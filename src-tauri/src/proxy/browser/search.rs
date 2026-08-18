//! Searching by rendering pages in a real browser.
//!
//! The transport is the only thing that differs from `proxy::search`: engines
//! contribute a URL and a parser exactly as they do over HTTP, and the same
//! rate limits, cooldowns and rotation apply. What changes is that the page is
//! *rendered* first, which is what gets past a JavaScript bot wall — and what
//! makes this mode a hedge against the next engine to grow one, rather than a
//! fix for one specific engine.

use super::detect::DetectedBrowser;
use super::process::BrowserProcess;
use super::{cdp, detect};
use crate::proxy::config::{ENGINE_COOLDOWN, RATE_LIMIT_INTERVAL};
use crate::proxy::search::{
    looks_like_bot_challenge, parse_bing_html, parse_brave_html, parse_ddg_html,
    parse_startpage_html, parse_yahoo_html,
};
use crate::proxy::stats::{
    record_engine_result, SearchFailure, SearchFailureKind, SearchStats, StatSink,
};
use crate::proxy::{ProxyState, SearchResult};
use log::{info, warn};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Ceiling on one page render. A proof-of-work interstitial clears in ~2s and
/// an ordinary SERP well under one, so this is generous — it exists to bound a
/// hung page, not to pace anything.
const RENDER_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a launched browser stays warm after its last use.
///
/// Measured: ~0.19s to start but ~1.2 GB resident with tabs open. Next to a
/// 5-18 GB model that is not a background cost worth imposing for a saving
/// this small, so the browser is a guest, not a resident.
const IDLE_SHUTDOWN: Duration = Duration::from_secs(60);

/// One engine in browser mode: how to build its URL and how to read its DOM.
///
/// Deliberately a separate table from `AUTO_ENGINES`. Membership differs —
/// Startpage belongs here and nowhere else — and browser mode must not inherit
/// a removal made for plain-HTTP reasons, which is exactly how it would lose
/// the engine it exists to provide.
pub(crate) struct BrowserEngine {
    /// Stats key, already suffixed. Browser and plain attempts for the same
    /// engine have different success rates, and averaging them would blind the
    /// per-engine table that has diagnosed every search problem so far.
    pub(crate) stats_key: &'static str,
    pub(crate) url: fn(&str, &str) -> String,
    pub(crate) parse: fn(&str) -> Result<Vec<SearchResult>, String>,
}

fn encode(query: &str) -> String {
    urlencoding::encode(query).into_owned()
}

/// Engines browser mode rotates through, verified rendering under Chrome 151
/// on 2026-08-17.
///
/// Startpage leads because it is the one engine the plain rotation cannot
/// reach: when both modes work, browser mode should be returning something
/// `auto` could not.
///
/// Mojeek is absent by evidence rather than oversight — it answers a headless
/// browser with the same hard 403 it gives plain HTTP, naming the *network*,
/// so nothing client-side reaches it. Qwant is absent because its rendered DOM
/// contains nothing the existing selectors match; it would need a parser of
/// its own.
pub(crate) const BROWSER_ENGINES: &[BrowserEngine] = &[
    BrowserEngine {
        stats_key: "startpage/browser",
        url: |q, _| format!("https://www.startpage.com/sp/search?query={}", encode(q)),
        parse: parse_startpage_html,
    },
    BrowserEngine {
        stats_key: "bing/browser",
        url: |q, recency| {
            let filters = match recency {
                "day" => "&filters=ex1%3a%22ez1%22",
                "week" => "&filters=ex1%3a%22ez2%22",
                "month" => "&filters=ex1%3a%22ez3%22",
                _ => "",
            };
            format!("https://www.bing.com/search?q={}{}", encode(q), filters)
        },
        parse: parse_bing_html,
    },
    BrowserEngine {
        stats_key: "brave_html/browser",
        url: |q, recency| {
            let tf = match recency {
                "day" => "&tf=pd",
                "week" => "&tf=pw",
                "month" => "&tf=pm",
                "year" => "&tf=py",
                _ => "",
            };
            format!(
                "https://search.brave.com/search?q={}&source=web{}",
                encode(q),
                tf
            )
        },
        parse: parse_brave_html,
    },
    BrowserEngine {
        stats_key: "duckduckgo/browser",
        url: |q, _| format!("https://html.duckduckgo.com/html/?q={}", encode(q)),
        parse: parse_ddg_html,
    },
    BrowserEngine {
        stats_key: "yahoo/browser",
        url: |q, _| format!("https://search.yahoo.com/search?p={}", encode(q)),
        parse: parse_yahoo_html,
    },
];

/// A warm browser, or the absence of one.
///
/// Shared across searches so a burst pays the launch cost once. The mutex is
/// held across a render — searches through this mode are serialized, matching
/// the local-inference lane's behaviour and keeping the memory ceiling to one
/// browser.
#[derive(Default)]
pub(crate) struct BrowserSession {
    inner: Mutex<Option<WarmBrowser>>,
}

struct WarmBrowser {
    process: BrowserProcess,
    last_used: Instant,
}

impl BrowserSession {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Render `url`, launching or reusing the browser as needed.
    async fn render(
        &self,
        browser: &DetectedBrowser,
        url: &str,
        ready: &(dyn Fn(&str) -> bool + Sync),
    ) -> Result<cdp::RenderOutcome, String> {
        let mut guard = self.inner.lock().await;

        // Drop a browser that has been idle: see IDLE_SHUTDOWN.
        if guard
            .as_ref()
            .is_some_and(|w| w.last_used.elapsed() > IDLE_SHUTDOWN)
        {
            info!("browser search: shutting down idle browser");
            if let Some(mut warm) = guard.take() {
                warm.process.close().await;
            }
        }

        if guard.is_none() {
            *guard = Some(WarmBrowser {
                process: BrowserProcess::launch(browser)?,
                last_used: Instant::now(),
            });
        }

        let warm = guard.as_mut().expect("just populated");
        let port = warm.process.port;
        let outcome = cdp::render(port, url, ready, RENDER_TIMEOUT).await;
        match &outcome {
            Ok(_) => warm.last_used = Instant::now(),
            Err(e) => {
                // A browser that failed a render is not trusted for the next
                // one: it may have crashed, and a dead port produces the same
                // error forever otherwise.
                warn!("browser search: render failed ({e}) — dropping the browser");
                if let Some(mut warm) = guard.take() {
                    warm.process.close().await;
                }
            }
        }
        outcome
    }

    /// Release the browser (app shutdown, or the user turning the mode off).
    pub(crate) async fn shutdown(&self) {
        if let Some(mut warm) = self.inner.lock().await.take() {
            warm.process.close().await;
        }
    }
}

/// Why browser mode could not run, in words a user can act on.
pub(crate) struct BrowserUnavailable {
    pub(crate) reason: String,
    /// Where detection looked, when that was the problem — the difference
    /// between a complaint and a fixable one.
    pub(crate) searched: Vec<String>,
}

/// Search by rendering each engine in turn.
///
/// Returns `Err(BrowserUnavailable)` when the browser itself is the problem,
/// which the caller turns into a fallback to the plain rotation. Engine-level
/// failures are handled here exactly as they are over HTTP: cool the engine
/// down and try the next.
pub(crate) async fn search_via_browser(
    session: &BrowserSession,
    state: &ProxyState,
    stats: &SearchStats,
    sink: &dyn StatSink,
    query: &str,
    recency: &str,
    override_path: Option<&str>,
) -> Result<Result<Vec<SearchResult>, String>, BrowserUnavailable> {
    let browser = match detect::detect(override_path) {
        Ok(b) => b,
        Err(failure) => {
            return Err(BrowserUnavailable {
                reason: failure
                    .override_error
                    .unwrap_or_else(|| "No Chrome or Chromium installation was found.".to_string()),
                searched: failure.searched,
            })
        }
    };

    let mut last_error = String::new();
    let mut engine_ran = false;

    // Start at the rotation cursor and wrap, exactly as `search_auto` does.
    // Without this the leading engine answers every search, the other four are
    // never exercised, and their stats stay empty — which is how a hedge stops
    // working without anyone noticing.
    let offset = state.browser_rotation_offset(BROWSER_ENGINES.len());
    let rotated = BROWSER_ENGINES
        .iter()
        .cycle()
        .skip(offset)
        .take(BROWSER_ENGINES.len());

    for engine in rotated {
        if !state.is_engine_healthy(engine.stats_key, ENGINE_COOLDOWN) {
            continue;
        }
        // Browser mode is more capable than plain HTTP and therefore more able
        // to get the user's address blocked — which is what 150 first-choice
        // attempts a day earned Mojeek. Faster does not mean looser.
        state
            .rate_limit_engine(engine.stats_key, RATE_LIMIT_INTERVAL)
            .await;

        let url = (engine.url)(query, recency);
        let parse = engine.parse;
        // "Ready" is "the parser found results", which is what makes a
        // proof-of-work interstitial work without special handling: the page
        // simply is not ready until it renders results, so a ~2s solve is just
        // a slow load.
        let ready = move |html: &str| parse(html).map(|r| !r.is_empty()).unwrap_or(false);

        let started = Instant::now();
        let outcome = session.render(&browser, &url, &ready).await;
        let elapsed = started.elapsed().as_millis() as u64;

        let result = match outcome {
            Ok(rendered) if rendered.ready => (engine.parse)(&rendered.html)
                .map_err(|e| SearchFailure::new(SearchFailureKind::Parse, e)),
            Ok(rendered) => {
                // Nothing parsed before the deadline. The same classifier the
                // HTTP path uses decides whether that was a wall or an
                // ordinary empty page.
                if looks_like_bot_challenge(&rendered.html) {
                    Err(SearchFailure::new(
                        SearchFailureKind::RateLimited,
                        format!("{} served an anti-bot challenge", engine.stats_key),
                    ))
                } else {
                    Ok(Vec::new())
                }
            }
            Err(e) => {
                // The browser itself failed. If it failed before any engine
                // produced anything, the whole mode is unavailable and the
                // caller should fall back rather than grind through four more
                // engines against a dead browser.
                if !engine_ran {
                    return Err(BrowserUnavailable {
                        reason: e,
                        searched: Vec::new(),
                    });
                }
                Err(SearchFailure::new(SearchFailureKind::Other, e))
            }
        };

        engine_ran = true;
        record_engine_result(stats, sink, engine.stats_key, &result, elapsed, None);

        match result {
            Ok(results) if !results.is_empty() => {
                info!(
                    "browser search: {} returned {} results",
                    engine.stats_key,
                    results.len()
                );
                // Advance so the NEXT search starts elsewhere; this is what
                // makes it a rotation rather than a preference order.
                state.advance_browser_rotation_cursor(BROWSER_ENGINES.len());
                return Ok(Ok(results));
            }
            Ok(_) => last_error = format!("{} returned no results", engine.stats_key),
            Err(e) => {
                state.record_failure(engine.stats_key);
                last_error = e.into();
            }
        }
    }

    // Everything failed: still move on, so the next search does not open with
    // the same engine that just failed.
    state.advance_browser_rotation_cursor(BROWSER_ENGINES.len());
    Ok(Err(if last_error.is_empty() {
        "All browser search engines are cooling down.".to_string()
    } else {
        format!("All browser search engines failed. Last error: {last_error}")
    }))
}

/// Shared handle so the Tauri layer can own one session for the app's life.
pub(crate) type BrowserSessionHandle = Arc<BrowserSession>;

#[cfg(test)]
mod tests {
    use super::*;

    /// Every rotation entry must have a parser that works, or the engine is a
    /// guaranteed empty result that still costs a render.
    #[test]
    fn every_engine_parses_its_own_markup() {
        // Minimal markup per engine, mirroring the shapes verified live.
        let fixtures: &[(&str, &str)] = &[
            (
                "startpage/browser",
                r##"<html><body><div class="result"><a class="result-title" href="https://example.com" data-testid="gl-title-link">A title</a><p class="description">A snippet.</p></div></body></html>"##,
            ),
            (
                "bing/browser",
                r##"<html><body><ol id="b_results"><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&p=x&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbQ&ntb=1">A title</a></h2><div class="b_caption"><p>A snippet.</p></div></li></ol></body></html>"##,
            ),
            (
                "brave_html/browser",
                r##"<html><body><div data-type="web"><a href="https://example.com"><div class="search-snippet-title">A title</div></a><div class="generic-snippet">A snippet.</div></div></body></html>"##,
            ),
            (
                "duckduckgo/browser",
                // DDG's parser keys on `.result__body`, not `.result`.
                r##"<html><body><div class="result__body"><a class="result__a" href="https://example.com">A title</a><a class="result__snippet">A snippet.</a></div></body></html>"##,
            ),
            (
                "yahoo/browser",
                r##"<html><body><div class="algo"><h3 class="title"><a href="https://r.search.yahoo.com/x/RU=https%3a%2f%2fexample.com/RK=2">A title</a></h3><div class="compText"><p>A snippet.</p></div></div></body></html>"##,
            ),
        ];

        for engine in BROWSER_ENGINES {
            let html = fixtures
                .iter()
                .find(|(key, _)| *key == engine.stats_key)
                .unwrap_or_else(|| panic!("no fixture for {}", engine.stats_key))
                .1;
            let results = (engine.parse)(html)
                .unwrap_or_else(|e| panic!("{} parser errored: {e}", engine.stats_key));
            assert!(
                !results.is_empty(),
                "{} parsed no results from its own markup",
                engine.stats_key
            );
        }
    }

    /// The suffix is what keeps browser and plain attempts separable in the
    /// stats table that has diagnosed every search problem so far.
    #[test]
    fn every_engine_key_is_browser_suffixed() {
        for engine in BROWSER_ENGINES {
            assert!(
                engine.stats_key.ends_with("/browser"),
                "{} would merge with the plain rotation's stats",
                engine.stats_key
            );
        }
    }

    /// Startpage is the engine this mode exists to provide, so it opens the
    /// rotation — but only as the first search's starting point, since the
    /// cursor moves on afterwards.
    #[test]
    fn startpage_opens_the_rotation() {
        assert_eq!(BROWSER_ENGINES[0].stats_key, "startpage/browser");
    }

    /// The rotation must actually visit every engine as a starting point.
    /// Without this the strongest engine answers every search, the rest are
    /// never exercised, and the mode's whole reason for existing — a path that
    /// still works when one engine falls over — quietly stops being tested.
    #[test]
    fn rotation_starts_each_engine_in_turn() {
        let state = ProxyState::new();
        let len = BROWSER_ENGINES.len();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..len {
            let offset = state.browser_rotation_offset(len);
            seen.insert(BROWSER_ENGINES[offset].stats_key);
            state.advance_browser_rotation_cursor(len);
        }
        assert_eq!(
            seen.len(),
            len,
            "every engine should get a turn at the front; saw {seen:?}"
        );
        // A full lap returns to the start.
        assert_eq!(state.browser_rotation_offset(len), 0);
    }

    #[test]
    fn urls_carry_the_query_and_recency_filters() {
        let startpage = (BROWSER_ENGINES[0].url)("rust async", "week");
        assert!(startpage.contains("rust%20async") || startpage.contains("rust+async"));

        let bing = (BROWSER_ENGINES[1].url)("rust", "week");
        assert!(bing.contains("ez2"), "week filter missing: {bing}");
        let bing_any = (BROWSER_ENGINES[1].url)("rust", "any");
        assert!(
            !bing_any.contains("filters="),
            "unexpected filter: {bing_any}"
        );
    }
}

#[cfg(test)]
mod integration {
    use super::*;

    /// The whole mode, end to end: detect a browser, render Startpage, parse
    /// real results. Startpage specifically, because it is the engine the
    /// plain rotation cannot reach — a pass here is the feature working, not
    /// just the plumbing.
    ///
    /// Ignored: needs a browser and the network. Run with
    /// `cargo test --manifest-path src-tauri/Cargo.toml browser_search_returns -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn browser_search_returns_startpage_results() {
        let browser = detect::detect(None).expect("a browser must be installed");
        let session = BrowserSession::new();
        let engine = &BROWSER_ENGINES[0];
        assert_eq!(engine.stats_key, "startpage/browser");

        let url = (engine.url)("rust async runtime", "any");
        let parse = engine.parse;
        let outcome = session
            .render(&browser, &url, &move |html: &str| {
                parse(html).map(|r| !r.is_empty()).unwrap_or(false)
            })
            .await
            .expect("render should succeed");

        assert!(
            outcome.ready,
            "Startpage did not render results in time ({} bytes)",
            outcome.html.len()
        );
        let results = (engine.parse)(&outcome.html).expect("parse should succeed");
        println!("startpage returned {} results", results.len());
        for r in results.iter().take(3) {
            println!("  {} | {}", r.title, r.url);
        }
        assert!(results.len() >= 5, "expected a full page of results");
        assert!(
            results.iter().all(|r| r.url.starts_with("http")),
            "every result should carry a real URL"
        );

        // Exercise the real teardown rather than Drop's backstop, and prove it
        // leaves nothing behind — the leak this caught was ten processes and a
        // profile directory surviving an earlier version of this test.
        session.shutdown().await;
        let leftovers: Vec<_> = std::fs::read_dir(std::env::temp_dir())
            .expect("temp dir readable")
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| n.starts_with(super::super::process::PROFILE_PREFIX))
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "shutdown left {} profile(s) behind",
            leftovers.len()
        );
    }
}
