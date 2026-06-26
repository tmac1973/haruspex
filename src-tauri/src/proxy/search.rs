//! Search backends — one async fn + HTML parser per engine. The trait
//! abstraction proposed in design-patterns audit P-1 is deferred; for
//! now the dispatcher in `mod.rs::proxy_search` matches on a provider
//! string and calls the appropriate backend.

use super::bypass::apply_proxy;
use super::config::{
    ENGINE_COOLDOWN, ENGINE_COOLDOWN_SLOW, FETCH_TIMEOUT, RATE_LIMIT_INTERVAL,
    RATE_LIMIT_INTERVAL_SLOW,
};
use super::extract::{diagnostic_snippet, USER_AGENT};
use super::stats::{
    record_engine_result, record_global_both, AutoPosition, GlobalCounter, SearchFailure,
    SearchFailureKind, SearchStats, StatSink,
};
use super::{ProxyConfig, ProxyState, SearchResult};
use log::{info, warn};
use scraper::{ElementRef, Html, Selector};

/// Every engine returns at most this many results per query.
const MAX_RESULTS: usize = 8;

/// Classify a reqwest error: timeouts go to Timeout, everything else
/// (connect, DNS, TLS, broken pipe, response read) is Network.
fn classify_reqwest_err(e: reqwest::Error, context: &str) -> SearchFailure {
    if e.is_timeout() {
        SearchFailure::new(SearchFailureKind::Timeout, format!("{}: {}", context, e))
    } else {
        SearchFailure::new(SearchFailureKind::Network, format!("{}: {}", context, e))
    }
}

/// Pass a response through unchanged on 2xx, else map it to a
/// `SearchFailure::Http` tagged `"{label} error: {status}"`. The shared
/// non-2xx form used by the scrape engines and SearXNG (DuckDuckGo and the
/// Brave API word their status errors differently and stay bespoke).
fn ensure_search_success(
    resp: reqwest::Response,
    label: &str,
) -> Result<reqwest::Response, SearchFailure> {
    if resp.status().is_success() {
        Ok(resp)
    } else {
        Err(SearchFailure::new(
            SearchFailureKind::Http,
            format!("{} error: {}", label, resp.status()),
        ))
    }
}

// Shared result-collection skeletons (audit R-search). Engine quirks —
// DDG's `uddg=` redirect decode, Mojeek's title-selector fallback, Brave's
// link-text fallback — stay local to each engine's extraction closure.

/// Trimmed text content of an element — the common title/snippet shape.
fn element_text(e: ElementRef) -> String {
    e.text().collect::<String>().trim().to_string()
}

/// HTML-scrape skeleton shared by DDG / Mojeek / Brave-HTML: iterate the
/// per-result elements, let the engine-specific closure extract (and
/// validate) a `SearchResult`, and stop once `MAX_RESULTS` are collected.
fn scrape_results(
    document: &Html,
    result_selector: &Selector,
    mut extract: impl FnMut(ElementRef) -> Option<SearchResult>,
) -> Vec<SearchResult> {
    let mut results = Vec::new();
    for element in document.select(result_selector) {
        if let Some(result) = extract(element) {
            results.push(result);
        }
        if results.len() >= MAX_RESULTS {
            break;
        }
    }
    results
}

/// JSON→`SearchResult` collection shared by the Brave API and SearXNG —
/// identical apart from where the results array lives (resolved by the
/// caller) and which field carries the snippet.
fn collect_json_results(items: &[serde_json::Value], snippet_field: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    for item in items.iter().take(MAX_RESULTS) {
        let title = item
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        let url = item.get("url").and_then(|u| u.as_str()).unwrap_or_default();
        let snippet = item
            .get(snippet_field)
            .and_then(|s| s.as_str())
            .unwrap_or_default();

        if !title.is_empty() && !url.is_empty() {
            results.push(SearchResult {
                title: title.to_string(),
                url: url.to_string(),
                snippet: snippet.to_string(),
            });
        }
    }
    results
}

/// Log an anchored diagnostic snippet when a scrape parser finds nothing —
/// this is what makes the empty-result log line actionable when an engine
/// restructures its markup.
fn warn_empty_scrape(label: &str, html: &str, needles: &[&str]) {
    let snippet = diagnostic_snippet(html, needles, 3000);
    warn!(
        "{} parser found 0 results — anchored snippet of response: {}",
        label, snippet
    );
}

pub(super) async fn search_duckduckgo(
    query: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, SearchFailure> {
    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5))
            .cookie_store(true),
        proxy,
    )
    .map_err(SearchFailure::other)?
    .build()
    .map_err(|e| SearchFailure::other(format!("Failed to create HTTP client: {}", e)))?;

    // DDG date filter: df=d (day), df=w (week), df=m (month), df=y (year)
    let df = match recency {
        "day" => "&df=d",
        "week" => "&df=w",
        "month" => "&df=m",
        "year" => "&df=y",
        _ => "",
    };

    let response = client
        .post("https://html.duckduckgo.com/html/")
        .header("User-Agent", USER_AGENT)
        .header("Referer", "https://html.duckduckgo.com/")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!("q={}&b={}", urlencoding::encode(query), df))
        .send()
        .await
        .map_err(|e| classify_reqwest_err(e, "Search request failed"))?;

    if !response.status().is_success() {
        return Err(SearchFailure::new(
            SearchFailureKind::Http,
            format!("Search failed with status: {}", response.status()),
        ));
    }

    let html = response
        .text()
        .await
        .map_err(|e| classify_reqwest_err(e, "Failed to read response"))?;

    // Detect bot/captcha page
    if html.contains("cc=botnet") || html.contains("anomaly.js") {
        warn!("DuckDuckGo returned a bot detection page — search temporarily unavailable");
        return Err(SearchFailure::new(
            SearchFailureKind::RateLimited,
            "Web search is temporarily unavailable (rate limited). Try again in a few minutes."
                .to_string(),
        ));
    }

    parse_ddg_html(&html).map_err(|e| SearchFailure::new(SearchFailureKind::Parse, e))
}

pub(super) fn parse_ddg_html(html: &str) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);
    let result_selector =
        Selector::parse(".result__body").map_err(|_| "Failed to parse selector")?;
    let title_selector =
        Selector::parse(".result__a").map_err(|_| "Failed to parse title selector")?;
    let snippet_selector =
        Selector::parse(".result__snippet").map_err(|_| "Failed to parse snippet selector")?;
    let url_selector =
        Selector::parse(".result__url").map_err(|_| "Failed to parse URL selector")?;

    Ok(scrape_results(&document, &result_selector, |element| {
        let title = element
            .select(&title_selector)
            .next()
            .map(element_text)
            .unwrap_or_default();

        let snippet = element
            .select(&snippet_selector)
            .next()
            .map(element_text)
            .unwrap_or_default();

        // Try to get URL from the link href, or from the .result__url text
        let url = element
            .select(&title_selector)
            .next()
            .and_then(|e| e.value().attr("href"))
            .map(|href| {
                // DDG wraps URLs in a redirect; extract the actual URL
                if let Some(pos) = href.find("uddg=") {
                    let encoded = &href[pos + 5..];
                    let end = encoded.find('&').unwrap_or(encoded.len());
                    urlencoding::decode(&encoded[..end])
                        .unwrap_or_default()
                        .to_string()
                } else {
                    href.to_string()
                }
            })
            .or_else(|| {
                element.select(&url_selector).next().map(|e| {
                    let text = element_text(e);
                    if !text.starts_with("http") {
                        format!("https://{}", text)
                    } else {
                        text
                    }
                })
            })
            .unwrap_or_default();

        (!title.is_empty() && !url.is_empty()).then_some(SearchResult {
            title,
            url,
            snippet,
        })
    }))
}

/// Shared skeleton for the plain-GET HTML scrape engines (Mojeek, Brave HTML,
/// Startpage, Yahoo). Builds the proxied client, GETs `url` with the standard
/// browser-like scrape headers, enforces a 2xx, reads the body, runs `parse`,
/// and — when parsing yields nothing — first consults `on_empty` (so an engine
/// can recognize an anti-bot challenge and surface it as RateLimited) before
/// logging an empty-result warning keyed by `empty_needles`. `label` tags every
/// error and warning. `send_accept` adds the browser-like `Accept: text/html…`
/// header (Brave/Startpage/Yahoo send it; Mojeek historically does not, so it
/// passes `false`). DuckDuckGo is intentionally NOT routed through here: it
/// POSTs a form with a cookie store and its own bot-detection handling.
async fn scrape_engine(
    url: &str,
    label: &str,
    proxy: Option<&ProxyConfig>,
    send_accept: bool,
    parse: impl Fn(&str) -> Result<Vec<SearchResult>, String>,
    on_empty: impl Fn(&str) -> Option<SearchFailure>,
    empty_needles: &[&str],
) -> Result<Vec<SearchResult>, SearchFailure> {
    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5)),
        proxy,
    )
    .map_err(SearchFailure::other)?
    .build()
    .map_err(|e| SearchFailure::other(format!("HTTP client error: {}", e)))?;

    let mut req = client.get(url).header("User-Agent", USER_AGENT);
    if send_accept {
        req = req.header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9",
        );
    }
    let resp = req
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| classify_reqwest_err(e, &format!("{} search failed", label)))?;

    let resp = ensure_search_success(resp, label)?;

    let html = resp
        .text()
        .await
        .map_err(|e| classify_reqwest_err(e, &format!("Failed to read {} response", label)))?;

    let results = parse(&html).map_err(|e| SearchFailure::new(SearchFailureKind::Parse, e))?;

    if results.is_empty() {
        if let Some(failure) = on_empty(&html) {
            return Err(failure);
        }
        warn_empty_scrape(label, &html, empty_needles);
    }

    Ok(results)
}

// Mojeek HTML search — small independent index, scrape-friendly, no API key.
// Useful as a fallback when DDG/Qwant are rate-limited or broken.

pub(super) async fn search_mojeek(
    query: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, SearchFailure> {
    // Mojeek freshness: si=day|week|month|year (their "since" parameter)
    let since = match recency {
        "day" => "&si=day",
        "week" => "&si=week",
        "month" => "&si=month",
        "year" => "&si=year",
        _ => "",
    };

    let url = format!(
        "https://www.mojeek.com/search?q={}{}",
        urlencoding::encode(query),
        since
    );

    scrape_engine(
        &url,
        "Mojeek",
        proxy,
        false,
        parse_mojeek_html,
        |_| None,
        &[
            "results-standard",
            "class=\"results",
            "id=\"results",
            "<main",
        ],
    )
    .await
}

pub(super) fn parse_mojeek_html(html: &str) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);

    // Mojeek's organic results historically live in `ul.results-standard > li`
    // with an `<a class="ob">` for the title link and a `<p class="s">` for
    // the snippet. Be tolerant of small markup changes by falling back to
    // any `li > h2 a` inside the results list.
    let result_selector = Selector::parse("ul.results-standard > li, ol.results-standard > li")
        .map_err(|_| "Failed to parse mojeek result selector")?;
    let title_selector_primary =
        Selector::parse("a.ob").map_err(|_| "Failed to parse mojeek title selector")?;
    let title_selector_fallback =
        Selector::parse("h2 a").map_err(|_| "Failed to parse mojeek h2 selector")?;
    let snippet_selector =
        Selector::parse("p.s").map_err(|_| "Failed to parse mojeek snippet selector")?;

    Ok(scrape_results(&document, &result_selector, |element| {
        let title_el = element
            .select(&title_selector_primary)
            .next()
            .or_else(|| element.select(&title_selector_fallback).next());

        let title = title_el.map(element_text).unwrap_or_default();
        let url = title_el
            .and_then(|e| e.value().attr("href"))
            .unwrap_or_default()
            .to_string();
        let snippet = element
            .select(&snippet_selector)
            .next()
            .map(element_text)
            .unwrap_or_default();

        (!title.is_empty() && !url.is_empty() && url.starts_with("http")).then_some(SearchResult {
            title,
            url,
            snippet,
        })
    }))
}

// Brave HTML search — scrapes search.brave.com directly without an API key.
// This is distinct from the explicit `brave` provider which uses the paid
// Brave Search API. Brave's HTML page returns server-rendered results with
// no Cloudflare/Turnstile/DataDome challenge as of April 2026, so plain
// HTTP scraping works. The markup uses Svelte build hashes in classnames,
// so we anchor on stable data attributes (`data-type="web"`) and unhashed
// class prefixes (`search-snippet-title`, `generic-snippet`) instead.

pub(super) async fn search_brave_html(
    query: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, SearchFailure> {
    // Brave time filter: tf=pd (past day), pw (week), pm (month), py (year)
    let tf = match recency {
        "day" => "&tf=pd",
        "week" => "&tf=pw",
        "month" => "&tf=pm",
        "year" => "&tf=py",
        _ => "",
    };

    let url = format!(
        "https://search.brave.com/search?q={}&source=web{}",
        urlencoding::encode(query),
        tf
    );

    scrape_engine(
        &url,
        "Brave HTML",
        proxy,
        true,
        parse_brave_html,
        |_| None,
        &[
            "data-type=\"web\"",
            "search-snippet-title",
            "generic-snippet",
            "result-wrapper",
        ],
    )
    .await
}

pub(super) fn parse_brave_html(html: &str) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);
    // Anchor on the stable data attribute that survives Svelte rebuilds.
    let result_selector = Selector::parse(r#"div[data-type="web"]"#)
        .map_err(|_| "Failed to parse brave result selector")?;
    // First http(s) link inside the result is the canonical destination.
    let link_selector =
        Selector::parse(r#"a[href^="http"]"#).map_err(|_| "Failed to parse brave link selector")?;
    // Title div has a stable unhashed class prefix.
    let title_selector = Selector::parse(r#"div[class*="search-snippet-title"]"#)
        .map_err(|_| "Failed to parse brave title selector")?;
    // Snippet body lives inside .generic-snippet (unhashed prefix).
    let snippet_selector = Selector::parse(r#"div[class*="generic-snippet"]"#)
        .map_err(|_| "Failed to parse brave snippet selector")?;

    Ok(scrape_results(&document, &result_selector, |element| {
        let link = element.select(&link_selector).next();
        let url = link
            .and_then(|e| e.value().attr("href"))
            .unwrap_or_default()
            .to_string();

        // Title: prefer the explicit search-snippet-title div; fall back to
        // the link's own text content if the title div is missing or empty
        // (e.g. for some result types Brave reuses the wrapper for).
        let title = element
            .select(&title_selector)
            .next()
            .map(element_text)
            .filter(|s| !s.is_empty())
            .or_else(|| link.map(element_text))
            .unwrap_or_default();

        let snippet = element
            .select(&snippet_selector)
            .next()
            .map(|e| {
                e.text()
                    .collect::<String>()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();

        (!title.is_empty() && !url.is_empty() && url.starts_with("http")).then_some(SearchResult {
            title,
            url,
            snippet,
        })
    }))
}

// Startpage HTML search — Startpage proxies Google's results and serves them
// server-rendered, so plain-HTTP scraping yields Google-quality results without
// a browser, and without ever hitting Google's own bot wall. The markup is
// Emotion CSS-in-JS, so we anchor on the stable `data-testid` (`gl-title-link`)
// and the unhashed class tokens (`result`, `description`) rather than the
// hashed `css-*` classes. Note: Emotion injects `<style>` tags *inside* the
// result anchors, so titles/snippets must be read with `text_skipping_style`.

pub(super) async fn search_startpage(
    query: &str,
    _recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, SearchFailure> {
    // Startpage's simple GET endpoint exposes no reliable date-filter param, so
    // recency is intentionally not applied here.
    let url = format!(
        "https://www.startpage.com/sp/search?query={}",
        urlencoding::encode(query)
    );

    scrape_engine(
        &url,
        "Startpage",
        proxy,
        true,
        parse_startpage_html,
        // No results + an anti-bot fingerprint means Startpage served its
        // challenge page rather than a SERP — surface it as rate-limited so the
        // engine cools down, instead of mistaking it for a genuine empty set.
        |html| {
            is_startpage_challenge(html).then(|| {
                SearchFailure::new(
                    SearchFailureKind::RateLimited,
                    "Startpage served an anti-bot challenge — temporarily unavailable.".to_string(),
                )
            })
        },
        &["gl-title-link", "result-title", "class=\"result", "w-gl"],
    )
    .await
}

/// Heuristic: does this look like Startpage's anti-bot / captcha page rather
/// than a SERP? Only consulted when zero results parsed (a real SERP that
/// happens to contain the word elsewhere never reaches this).
fn is_startpage_challenge(html: &str) -> bool {
    let lower = html.to_lowercase();
    lower.contains("captcha")
        || lower.contains("/sp/captcha")
        || lower.contains("are you human")
        || lower.contains("unusual traffic")
        || lower.contains("anubis")
}

pub(super) fn parse_startpage_html(html: &str) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);
    // Each organic result is a div whose class list includes the unhashed
    // token `result` (alongside an Emotion `css-*` hash we ignore).
    let result_selector =
        Selector::parse("div.result").map_err(|_| "Failed to parse startpage result selector")?;
    // Stable test id on the title anchor; its href is the real destination
    // (Startpage does not redirect-wrap organic result links).
    let title_selector = Selector::parse(r#"a[data-testid="gl-title-link"]"#)
        .map_err(|_| "Failed to parse startpage title selector")?;
    let desc_selector = Selector::parse("p.description")
        .map_err(|_| "Failed to parse startpage snippet selector")?;

    Ok(scrape_results(&document, &result_selector, |element| {
        let title_el = element.select(&title_selector).next();
        let url = title_el
            .and_then(|e| e.value().attr("href"))
            .unwrap_or_default()
            .to_string();
        let title = title_el.map(text_skipping_style).unwrap_or_default();
        let snippet = element
            .select(&desc_selector)
            .next()
            .map(text_skipping_style)
            .unwrap_or_default();

        (!title.is_empty() && url.starts_with("http")).then_some(SearchResult {
            title,
            url,
            snippet,
        })
    }))
}

/// Trimmed visible text of an element, ignoring the contents of any nested
/// `<style>`/`<script>`. Startpage injects Emotion `<style>` tags inside its
/// result anchors and snippets, whose CSS rules would otherwise pollute the
/// extracted title/snippet.
fn text_skipping_style(e: ElementRef) -> String {
    let mut buf = String::new();
    for node in e.descendants() {
        let Some(text) = node.value().as_text() else {
            continue;
        };
        let inside_style = node.ancestors().any(|a| {
            a.value()
                .as_element()
                .map(|el| el.name() == "style" || el.name() == "script")
                .unwrap_or(false)
        });
        if !inside_style {
            buf.push_str(text);
        }
    }
    buf.split_whitespace().collect::<Vec<_>>().join(" ")
}

// Yahoo HTML search — Yahoo's web results are Bing-sourced and server-rendered,
// so plain-HTTP scraping yields Bing-quality results without a browser. Organic
// results live in `div.algo`; the clean page title is the nested `h3.title` (a
// separate absolutely-positioned div holds the favicon + URL breadcrumb, which
// we ignore); result links are wrapped in `r.search.yahoo.com` redirects that
// carry the real destination in the `RU=` path segment.

pub(super) async fn search_yahoo(
    query: &str,
    _recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, SearchFailure> {
    // Yahoo's freshness param isn't reliably documented on the HTML endpoint, so
    // recency is intentionally not applied here.
    let url = format!(
        "https://search.yahoo.com/search?p={}",
        urlencoding::encode(query)
    );

    scrape_engine(
        &url,
        "Yahoo",
        proxy,
        true,
        parse_yahoo_html,
        // No results + a consent/captcha fingerprint means Yahoo bounced us to
        // its gate rather than a SERP — cool the engine down rather than report
        // empty.
        |html| {
            is_yahoo_challenge(html).then(|| {
                SearchFailure::new(
                    SearchFailureKind::RateLimited,
                    "Yahoo served a consent/anti-bot gate — temporarily unavailable.".to_string(),
                )
            })
        },
        &["class=\"algo", "compTitle", "h3 class=\"title", "compText"],
    )
    .await
}

fn is_yahoo_challenge(html: &str) -> bool {
    let lower = html.to_lowercase();
    lower.contains("captcha")
        || lower.contains("consent.yahoo")
        || lower.contains("guce.yahoo")
        || lower.contains("are you a human")
}

/// Decode the real destination URL from a `r.search.yahoo.com/...//RU=<enc>/RK=`
/// redirect link. The `RU=` value is percent-encoded (so it contains no literal
/// `/`), which lets us slice it out up to the next path segment.
fn decode_yahoo_redirect(href: &str) -> Option<String> {
    let pos = href.find("/RU=")?;
    let rest = &href[pos + 4..];
    let end = rest.find('/').unwrap_or(rest.len());
    let decoded = urlencoding::decode(&rest[..end]).ok()?.into_owned();
    decoded.starts_with("http").then_some(decoded)
}

pub(super) fn parse_yahoo_html(html: &str) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);
    // Organic results are `div.algo` (ads use `div.ads`, so they're excluded).
    let result_selector =
        Selector::parse("div.algo").map_err(|_| "Failed to parse yahoo result selector")?;
    // Clean title lives in the nested h3.title (not the breadcrumb div).
    let title_selector =
        Selector::parse("h3.title").map_err(|_| "Failed to parse yahoo title selector")?;
    // First Yahoo redirect link in the result is the canonical destination.
    let link_selector = Selector::parse(r#"a[href*="r.search.yahoo.com"]"#)
        .map_err(|_| "Failed to parse yahoo link selector")?;
    let snippet_selector =
        Selector::parse("div.compText").map_err(|_| "Failed to parse yahoo snippet selector")?;

    Ok(scrape_results(&document, &result_selector, |element| {
        let title = element
            .select(&title_selector)
            .next()
            .map(element_text)
            .unwrap_or_default();
        let url = element
            .select(&link_selector)
            .next()
            .and_then(|e| e.value().attr("href"))
            .and_then(decode_yahoo_redirect)
            .unwrap_or_default();
        let snippet = element
            .select(&snippet_selector)
            .next()
            .map(element_text)
            .unwrap_or_default();

        (!title.is_empty() && url.starts_with("http")).then_some(SearchResult {
            title,
            url,
            snippet,
        })
    }))
}

// Auto-rotation search across multiple engines

/// Build the engine try-order from the round-robin rotation: engines still
/// within their failure cooldown are pushed to the back as fallbacks, healthy
/// ones tried first. Stable within each partition (rotation order preserved).
fn order_engines(
    state: &ProxyState,
    rotation: &[&'static str],
    cooldown: std::time::Duration,
) -> Vec<&'static str> {
    let mut healthy: Vec<&'static str> = Vec::new();
    let mut unhealthy: Vec<&'static str> = Vec::new();
    for &engine in rotation {
        if state.is_engine_healthy(engine, cooldown) {
            healthy.push(engine);
        } else {
            unhealthy.push(engine);
        }
    }
    healthy.into_iter().chain(unhealthy).collect()
}

pub(super) async fn search_auto(
    state: &ProxyState,
    stats: &SearchStats,
    sink: &dyn StatSink,
    query: &str,
    recency: &str,
    slow_mode: bool,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, String> {
    // Pick pacing constants based on slow mode. Slow mode is only enabled
    // for deep research turns when no reliable provider is configured;
    // it slows pacing down enough to avoid bot-detection trips and uses a
    // shorter cooldown so engines can recover within the same research turn.
    let (rate_interval, cooldown) = if slow_mode {
        (RATE_LIMIT_INTERVAL_SLOW, ENGINE_COOLDOWN_SLOW)
    } else {
        (RATE_LIMIT_INTERVAL, ENGINE_COOLDOWN)
    };

    // Build the try order: start at the rotation cursor (round-robin) so
    // we don't always hit the same engine first, then partition into
    // healthy/unhealthy so cooled-down engines come last as fallbacks.
    let rotation = state.rotation_order();
    // Only contact engines that aren't currently in a failure cooldown.
    // Re-hitting a just-rate-limited engine almost always 429s again AND, via
    // record_failure below, would push its cooldown back to "now" — so a burst
    // of searches could pin every engine in a permanent rate-limited state and
    // never let the cooldown elapse. Drop cooled-down engines here; if they're
    // ALL cooling down, fail fast (no HTTP, no recorded failure) so the
    // cooldowns actually expire and the caller backs off for a bit.
    let engines: Vec<&'static str> = order_engines(state, &rotation, cooldown)
        .into_iter()
        .filter(|engine| state.is_engine_healthy(engine, cooldown))
        .collect();
    info!(
        "Auto-search engines for '{}' (slow_mode={}): {:?}",
        query, slow_mode, engines
    );
    if engines.is_empty() {
        record_global_both(stats, sink, GlobalCounter::AllEnginesFailed);
        return Err(
            "Web search is temporarily unavailable (all engines are rate-limited). \
             Try again in a couple of minutes."
                .to_string(),
        );
    }

    let mut last_error = String::new();

    for (idx, engine) in engines.iter().enumerate() {
        // Brave's free HTML endpoint 429s far more eagerly than the others, so
        // give it extra breathing room between requests.
        let interval = if *engine == "brave_html" {
            rate_interval.max(std::time::Duration::from_secs(5))
        } else {
            rate_interval
        };
        state.rate_limit_engine(engine, interval).await;
        info!(
            "Auto-search trying {} for: {} (recency: {})",
            engine, query, recency
        );

        let position = if idx == 0 {
            AutoPosition::First
        } else {
            AutoPosition::Fallback
        };

        let start = std::time::Instant::now();
        let result = match *engine {
            "startpage" => search_startpage(query, recency, proxy).await,
            "yahoo" => search_yahoo(query, recency, proxy).await,
            "brave_html" => search_brave_html(query, recency, proxy).await,
            "duckduckgo" => search_duckduckgo(query, recency, proxy).await,
            "mojeek" => search_mojeek(query, recency, proxy).await,
            _ => unreachable!(),
        };
        let elapsed = start.elapsed().as_millis() as u64;

        record_engine_result(stats, sink, engine, &result, elapsed, Some(position));

        match result {
            Ok(results) if !results.is_empty() => {
                info!(
                    "Auto-search succeeded with {} ({} results)",
                    engine,
                    results.len()
                );
                // Advance the cursor so the NEXT search starts with a
                // different engine first. This is what makes it actually
                // rotate instead of always hitting the same one.
                state.advance_rotation_cursor();
                return Ok(results);
            }
            Ok(_) => {
                warn!(
                    "Auto-search: {} returned empty results, trying next",
                    engine
                );
                last_error = format!("{} returned no results", engine);
            }
            Err(e) => {
                warn!("Auto-search: {} failed: {}, trying next", engine, e);
                state.record_failure(engine);
                last_error = e.into();
            }
        }
    }

    // All engines failed — still advance the cursor so the next attempt
    // starts somewhere new.
    state.advance_rotation_cursor();
    record_global_both(stats, sink, GlobalCounter::AllEnginesFailed);
    Err(format!(
        "All search engines failed. Last error: {}",
        last_error
    ))
}

// Brave Search API
pub(super) async fn search_brave(
    query: &str,
    api_key: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, SearchFailure> {
    let client = apply_proxy(reqwest::Client::builder().timeout(FETCH_TIMEOUT), proxy)
        .map_err(SearchFailure::other)?
        .build()
        .map_err(|e| SearchFailure::other(format!("HTTP client error: {}", e)))?;

    // Brave freshness: pd (past day), pw (past week), pm (past month), py (past year)
    let freshness = match recency {
        "day" => "pd",
        "week" => "pw",
        "month" => "pm",
        "year" => "py",
        _ => "",
    };

    let mut params = vec![("q", query), ("count", "8")];
    if !freshness.is_empty() {
        params.push(("freshness", freshness));
    }

    let resp = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .header("Accept", "application/json")
        .header("Accept-Encoding", "gzip")
        .header("X-Subscription-Token", api_key)
        .query(&params)
        .send()
        .await
        .map_err(|e| classify_reqwest_err(e, "Brave search failed"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(SearchFailure::new(
            SearchFailureKind::Http,
            format!("Brave search error {}: {}", status, body),
        ));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| {
        SearchFailure::new(
            SearchFailureKind::Parse,
            format!("Failed to parse Brave response: {}", e),
        )
    })?;

    Ok(data
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|r| r.as_array())
        .map(|items| collect_json_results(items, "description"))
        .unwrap_or_default())
}

// SearXNG instance search

pub(super) async fn search_searxng(
    query: &str,
    instance_url: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, SearchFailure> {
    let client = apply_proxy(reqwest::Client::builder().timeout(FETCH_TIMEOUT), proxy)
        .map_err(SearchFailure::other)?
        .build()
        .map_err(|e| SearchFailure::other(format!("HTTP client error: {}", e)))?;

    let url = format!("{}/search", instance_url.trim_end_matches('/'));

    // SearXNG time_range: day, week, month, year
    let mut params = vec![("q", query), ("format", "json"), ("categories", "general")];
    if recency != "any" && !recency.is_empty() {
        params.push(("time_range", recency));
    }

    let resp = client
        .get(&url)
        .query(&params)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| classify_reqwest_err(e, "SearXNG search failed"))?;

    let resp = ensure_search_success(resp, "SearXNG")?;

    let data: serde_json::Value = resp.json().await.map_err(|e| {
        SearchFailure::new(
            SearchFailureKind::Parse,
            format!("Failed to parse SearXNG response: {}", e),
        )
    })?;

    Ok(data
        .get("results")
        .and_then(|r| r.as_array())
        .map(|items| collect_json_results(items, "content"))
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn order_engines_all_healthy_preserves_rotation() {
        let state = ProxyState::new();
        let rotation = state.rotation_order();
        let ordered = order_engines(&state, &rotation, Duration::from_secs(60));
        assert_eq!(ordered, rotation);
    }

    #[test]
    fn order_engines_demotes_a_cooled_down_engine_to_the_back() {
        let state = ProxyState::new();
        let rotation = state.rotation_order();
        let victim = rotation[0];
        state.record_failure(victim);
        let ordered = order_engines(&state, &rotation, Duration::from_secs(60));
        assert_eq!(
            ordered.last(),
            Some(&victim),
            "failed engine should be a fallback"
        );
        assert_eq!(ordered.len(), rotation.len());
        for e in &rotation {
            assert!(ordered.contains(e), "no engine should be dropped");
        }
    }

    #[test]
    fn order_engines_recovers_once_cooldown_elapses() {
        let state = ProxyState::new();
        let rotation = state.rotation_order();
        state.record_failure(rotation[0]);
        // Zero cooldown ⇒ the just-failed engine already counts as healthy.
        let ordered = order_engines(&state, &rotation, Duration::from_secs(0));
        assert_eq!(ordered, rotation);
    }

    #[test]
    fn all_engines_cooled_down_leaves_nothing_to_try() {
        // Mirrors the filter search_auto applies: when every engine is within
        // its cooldown, the pickable set is empty, so search_auto fails fast
        // instead of re-hitting rate-limited endpoints.
        let state = ProxyState::new();
        let rotation = state.rotation_order();
        for engine in &rotation {
            state.record_failure(engine);
        }
        let pickable: Vec<&'static str> = order_engines(&state, &rotation, Duration::from_secs(60))
            .into_iter()
            .filter(|engine| state.is_engine_healthy(engine, Duration::from_secs(60)))
            .collect();
        assert!(pickable.is_empty());
    }

    #[test]
    fn parse_ddg_empty_html() {
        let result = parse_ddg_html("<html><body>No results</body></html>");
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn parse_ddg_malformed_html() {
        let result = parse_ddg_html("<not valid html at all <<<>>>");
        assert!(result.is_ok()); // Should not panic
    }

    #[test]
    fn parse_brave_html_extracts_minimal_result() {
        // Minimal markup matching the structure search.brave.com serves:
        // outer wrapper with data-type="web", a result-content div containing
        // the destination link, and a generic-snippet div with the body text.
        let html = r##"
            <html><body>
            <div class="snippet svelte-abc" data-pos="1" data-type="web">
              <div class="result-wrapper svelte-xyz">
                <div class="result-content svelte-xyz">
                  <a href="https://example.com/page" class="svelte-l1 l1">
                    <div class="title search-snippet-title svelte-l1" title="Example Page">Example Page</div>
                  </a>
                  <div class="generic-snippet svelte-gs">
                    <div class="content svelte-gs">An example snippet body.</div>
                  </div>
                </div>
              </div>
            </div>
            </body></html>
        "##;
        let results = parse_brave_html(html).expect("parse ok");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Example Page");
        assert_eq!(results[0].url, "https://example.com/page");
        assert_eq!(results[0].snippet, "An example snippet body.");
    }

    #[test]
    fn parse_brave_html_handles_empty_input() {
        let results = parse_brave_html("<html><body>nothing here</body></html>").expect("parse ok");
        assert!(results.is_empty());
    }

    #[test]
    fn parse_startpage_extracts_result_and_strips_emotion_style() {
        // Mirrors Startpage's real markup: a `div.result` wrapper, a title anchor
        // tagged `data-testid="gl-title-link"` with the real href, an Emotion
        // <style> injected *inside* the anchor (whose CSS must NOT leak into the
        // title), and a `p.description` snippet.
        let html = r##"
            <html><body>
            <div class="result css-ocm99y">
              <div class="wgl-title-link-container css-1gz2b5f">
                <a class="result-title result-link css-1bggj8v"
                   href="https://go.dev/doc/tutorial/generics"
                   data-testid="gl-title-link"><style data-emotion="css i3irj7">.css-i3irj7{color:#2E39B3;}</style>Tutorial: Getting started with generics</a>
              </div>
              <p class="description css-abc">Create a folder for your code, then add generics.</p>
            </div>
            </body></html>
        "##;
        let results = parse_startpage_html(html).expect("parse ok");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Tutorial: Getting started with generics");
        assert_eq!(results[0].url, "https://go.dev/doc/tutorial/generics");
        assert!(results[0].snippet.contains("Create a folder"));
        // The Emotion CSS rule must not have leaked into the title.
        assert!(!results[0].title.contains("css-"));
    }

    #[test]
    fn parse_startpage_handles_empty_input() {
        let results =
            parse_startpage_html("<html><body>nothing here</body></html>").expect("parse ok");
        assert!(results.is_empty());
    }

    #[test]
    fn startpage_challenge_detection() {
        assert!(is_startpage_challenge(
            "<html>Please solve the CAPTCHA to continue</html>"
        ));
        assert!(!is_startpage_challenge(
            "<html><div class=\"result\">normal serp</div></html>"
        ));
    }

    #[test]
    fn parse_yahoo_extracts_clean_title_url_and_snippet() {
        // Mirrors Yahoo's real markup: a `div.algo` container, a redirect link
        // carrying the real URL in `RU=`, a breadcrumb div (favicon + site name)
        // that must NOT be mistaken for the title, the clean title in `h3.title`,
        // and the snippet in `div.compText`.
        let html = r##"
            <li class="first"><div class="dd fst algo algo-sr relsrch Sr">
              <div class="compTitle">
                <a class="d-ib" data-matarget="algo" target="_blank"
                   href="https://r.search.yahoo.com/_ylt=Aaa;_ylu=Bbb/RV=2/RE=1/RO=10/RU=https%3a%2f%2fgo.dev%2fdoc%2ftutorial%2fgenerics/RK=2/RS=ccc-">
                  <div class="d-ib p-abs t-0 l-0">
                    <span class="d-ib va-mid"><span class="fc-141414 d-b">The Go Programming Language</span>https://go.dev &rsaquo; doc</span>
                  </div>
                  <h3 class="title"><span class="d-b">Tutorial: Getting started with generics</span></h3>
                </a>
              </div>
              <div class="compText aAbs"><p class="fc-dustygray">This <b>tutorial</b> introduces generics in Go.</p></div>
            </div></li>
        "##;
        let results = parse_yahoo_html(html).expect("parse ok");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Tutorial: Getting started with generics");
        assert_eq!(results[0].url, "https://go.dev/doc/tutorial/generics");
        assert!(results[0].snippet.contains("introduces generics"));
        // The breadcrumb/site-name must not leak into the title.
        assert!(!results[0].title.contains("go.dev"));
    }

    #[test]
    fn parse_yahoo_handles_empty_input() {
        let results = parse_yahoo_html("<html><body>nothing</body></html>").expect("parse ok");
        assert!(results.is_empty());
    }

    #[test]
    fn yahoo_redirect_decode() {
        assert_eq!(
            decode_yahoo_redirect(
                "https://r.search.yahoo.com/_ylt=x/RV=2/RU=https%3a%2f%2fexample.com%2fpage/RK=2/RS=y"
            ),
            Some("https://example.com/page".to_string())
        );
        assert_eq!(
            decode_yahoo_redirect("https://r.search.yahoo.com/no-ru-here"),
            None
        );
    }
}
