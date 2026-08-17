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

/// Build the HTTP client for one search-engine request: shared fetch
/// timeout + the user's proxy, with per-engine extras (the scrape
/// engines' 5-hop redirect cap, DDG's cookie store) layered on through
/// `configure`. One seam instead of per-engine copies so the
/// timeout/proxy handling can't silently drift. Unlike
/// `extract::build_fetch_client` this does NOT install the SSRF
/// redirect validator — search engines are fixed, operator-chosen
/// hosts, not untrusted page URLs — so callers pick their own redirect
/// policy and this helper must never be used for fetching arbitrary
/// URLs.
fn build_search_client(
    proxy: Option<&ProxyConfig>,
    configure: impl FnOnce(reqwest::ClientBuilder) -> reqwest::ClientBuilder,
) -> Result<reqwest::Client, SearchFailure> {
    apply_proxy(
        configure(reqwest::Client::builder().timeout(FETCH_TIMEOUT)),
        proxy,
    )
    .map_err(SearchFailure::other)?
    .build()
    .map_err(|e| SearchFailure::other(format!("Failed to create HTTP client: {}", e)))
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
// DDG's `uddg=` redirect decode, Yahoo's `RU=` decode, Brave's
// link-text fallback — stay local to each engine's extraction closure.

/// Trimmed text content of an element — the common title/snippet shape.
fn element_text(e: ElementRef) -> String {
    e.text().collect::<String>().trim().to_string()
}

/// HTML-scrape skeleton shared by DDG / Yahoo / Brave-HTML: iterate the
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
    let client = build_search_client(proxy, |b| {
        b.redirect(reqwest::redirect::Policy::limited(5))
            .cookie_store(true)
    })?;

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

    // Detect bot/captcha page — DDG's own fingerprints, plus the generic
    // challenge shapes so a new interstitial doesn't read as "no results".
    if html.contains("cc=botnet") || html.contains("anomaly.js") || looks_like_bot_challenge(&html)
    {
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

/// A challenge interstitial is a small page. Real SERPs measured on 2026-08-17:
/// DuckDuckGo's HTML endpoint is the smallest at ~33 KB (the same for a query
/// with zero results), Bing ~124 KB, Brave ~317 KB, Yahoo ~430 KB. The
/// challenge pages that took two engines out: Mojeek 5.5 KB, Startpage 10.3 KB.
/// 24 KB sits between the two populations with roughly 2x margin either side.
const MAX_CHALLENGE_PAGE_BYTES: usize = 24 * 1024;

/// Does this page look like a bot wall rather than a SERP?
///
/// Generic on purpose. Every engine that has gone dark did so by serving a
/// challenge with **HTTP 200**, and each one used wording nobody had a needle
/// for yet — Mojeek's "JavaScript is required to complete this challenge" was
/// the fourth variant in a row. Matching the *class* of page means the next
/// engine to fall over is recorded as blocked rather than as an engine that
/// keeps returning nothing.
///
/// The size guard is not belt-and-braces, it is load-bearing. These needles
/// are single words that appear in the scripts and markup of perfectly healthy
/// pages: Brave's SERP contains "captcha" and Bing's contains "turnstile", both
/// measured on a live query. Needles alone would therefore misreport a genuine
/// zero-result search — or, worse, a parser broken by a markup change — as a
/// bot wall, cooling the engine down and hiding the real cause behind a wrong
/// diagnosis. Requiring a small page keeps the match on the population it was
/// written for.
///
/// Even so this is only consulted when a parse yielded zero results, so a SERP
/// with results never reaches here whatever its size.
pub(super) fn looks_like_bot_challenge(html: &str) -> bool {
    if html.len() > MAX_CHALLENGE_PAGE_BYTES {
        return false;
    }
    let lower = html.to_lowercase();
    [
        "captcha",
        "javascript is required",
        "enable javascript",
        "verifying your request",
        "checking your browser",
        "unusual traffic",
        "are you human",
        "are you a human",
        "anubis",
        "cf-challenge",
        "turnstile",
        "datadome",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Shared skeleton for the plain-GET HTML scrape engines (Brave HTML, Yahoo).
/// Builds the proxied client, GETs `url` with the standard
/// browser-like scrape headers, enforces a 2xx, reads the body, runs `parse`,
/// and — when parsing yields nothing — first consults `on_empty` (so an engine
/// can recognize an anti-bot challenge and surface it as RateLimited) before
/// logging an empty-result warning keyed by `empty_needles`. `label` tags every
/// error and warning. `send_accept` adds the browser-like `Accept: text/html…`
/// header (both current engines send it; engines that tripped bot detection
/// with it passed `false`). DuckDuckGo is intentionally NOT routed through
/// here: it
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
    let client = build_search_client(proxy, |b| b.redirect(reqwest::redirect::Policy::limited(5)))?;

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
        // Brave has served plain SERPs so far, but it is the one rotation
        // engine with no challenge of its own to fingerprint — so it leans on
        // the generic detector rather than on nothing, which is how Mojeek
        // stayed first choice for 55 days while never returning a result.
        |html| {
            looks_like_bot_challenge(html).then(|| {
                SearchFailure::new(
                    SearchFailureKind::RateLimited,
                    "Brave served an anti-bot challenge — temporarily unavailable.".to_string(),
                )
            })
        },
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
    lower.contains("consent.yahoo")
        || lower.contains("guce.yahoo")
        || looks_like_bot_challenge(html)
}

// Bing HTML search — server-rendered organic results in `li.b_algo`, no API
// key. Removed from the rotation in April 2026 when every `/search?q=...`
// returned a Cloudflare Turnstile shell; re-verified working on 2026-08-17
// (five varied queries, ten results each, 123-127 KB pages), so it is back.
// Its bot-detection page is caught by the shared `looks_like_bot_challenge`
// rather than by Bing-specific needles, which is what the earlier version had.

pub(super) async fn search_bing(
    query: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, SearchFailure> {
    // Bing freshness: filters=ex1:"ez1|ez2|ez3" (day/week/month). It exposes
    // no year filter, so "year" falls through to unfiltered.
    let filters = match recency {
        "day" => "&filters=ex1%3a%22ez1%22",
        "week" => "&filters=ex1%3a%22ez2%22",
        "month" => "&filters=ex1%3a%22ez3%22",
        _ => "",
    };

    let url = format!(
        "https://www.bing.com/search?q={}{}",
        urlencoding::encode(query),
        filters
    );

    scrape_engine(
        &url,
        "Bing",
        proxy,
        true,
        parse_bing_html,
        |html| {
            looks_like_bot_challenge(html).then(|| {
                SearchFailure::new(
                    SearchFailureKind::RateLimited,
                    "Bing served an anti-bot challenge — temporarily unavailable.".to_string(),
                )
            })
        },
        &["b_algo", "b_results", "b_caption"],
    )
    .await
}

/// Decode the real destination from a `bing.com/ck/a?...&u=a1<b64url>&ntb=1`
/// tracking link. The payload is base64url after a two-character `a1` tag, and
/// Bing omits the padding — which `base64::decode` rejects, hence the explicit
/// re-pad. Every organic result on a live SERP used this form (10 of 10 on the
/// page this was written against), so a result whose link fails to decode is
/// dropped rather than reported with a bing.com URL the user didn't ask for.
fn decode_bing_redirect(href: &str) -> Option<String> {
    use base64::Engine as _;
    let pos = href.find("u=a1")?;
    let rest = &href[pos + 4..];
    let end = rest.find('&').unwrap_or(rest.len());
    let mut payload = rest[..end].to_string();
    payload.push_str(&"=".repeat((4 - payload.len() % 4) % 4));
    let bytes = base64::engine::general_purpose::URL_SAFE
        .decode(payload)
        .ok()?;
    let decoded = String::from_utf8(bytes).ok()?;
    decoded.starts_with("http").then_some(decoded)
}

pub(super) fn parse_bing_html(html: &str) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);
    // Organic results only — ads render as `li.b_ad`.
    let result_selector =
        Selector::parse("li.b_algo").map_err(|_| "Failed to parse bing result selector")?;
    let title_selector =
        Selector::parse("h2 a").map_err(|_| "Failed to parse bing title selector")?;
    let snippet_selector = Selector::parse(".b_caption p, .b_algoSlug")
        .map_err(|_| "Failed to parse bing snippet selector")?;

    Ok(scrape_results(&document, &result_selector, |element| {
        let title_el = element.select(&title_selector).next();
        let title = title_el.map(element_text).unwrap_or_default();
        let href = title_el.and_then(|e| e.value().attr("href")).unwrap_or("");
        // Prefer the decoded destination; accept a direct link if Bing ever
        // serves one, and drop anything still pointing at bing.com so a
        // tracking URL can never reach the model as a citation.
        let url = decode_bing_redirect(href)
            .or_else(|| href.starts_with("http").then(|| href.to_string()))
            .filter(|u| !u.contains("bing.com/ck/"))
            .unwrap_or_default();
        let snippet = element
            .select(&snippet_selector)
            .next()
            .map(element_text)
            .unwrap_or_default();

        (!title.is_empty() && !url.is_empty()).then_some(SearchResult {
            title,
            url,
            snippet,
        })
    }))
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
            "yahoo" => search_yahoo(query, recency, proxy).await,
            "bing" => search_bing(query, recency, proxy).await,
            "brave_html" => search_brave_html(query, recency, proxy).await,
            "duckduckgo" => search_duckduckgo(query, recency, proxy).await,
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
    let client = build_search_client(proxy, |b| b)?;

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
    let client = build_search_client(proxy, |b| b)?;

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

    /// The exact pages that took Mojeek and Startpage out, captured by
    /// replaying the request this code sends. Both answer **HTTP 200**, which
    /// is why they read as "no results" rather than as a block — Mojeek did so
    /// for 55 days while staying first choice in the rotation, because an
    /// engine that returns an empty Ok never enters a cooldown.
    #[test]
    fn generic_challenge_detection_catches_real_bot_walls() {
        // Mojeek, August 2026.
        assert!(looks_like_bot_challenge(
            "<html><body>Captcha … JavaScript is required to complete this challenge. \
             Please enable it and reload the page.</body></html>"
        ));
        // Startpage's Anubis proof-of-work interstitial, August 2026.
        assert!(looks_like_bot_challenge(
            "<html><body>Verifying your request... Loading...<script src=\"/anubis/\"></script></body></html>"
        ));
        // Shapes the others have used.
        for page in [
            "<html>Checking your browser before accessing</html>",
            "<html>Our systems have detected unusual traffic</html>",
            "<html><div id=\"cf-challenge\"></div></html>",
            "<html>Please solve the CAPTCHA to continue</html>",
        ] {
            assert!(looks_like_bot_challenge(page), "missed: {}", page);
        }
    }

    /// The guard that makes the generic matcher safe: it is only consulted
    /// when a parse found nothing, so a real SERP — even one *about* captchas
    /// — never reaches it. This asserts the ordinary page shape stays clean.
    #[test]
    fn generic_challenge_detection_ignores_an_ordinary_serp() {
        assert!(!looks_like_bot_challenge(
            "<html><body><div data-type=\"web\"><a href=\"https://example.com\">A result</a>\
             <div class=\"generic-snippet\">Some ordinary snippet text.</div></div></body></html>"
        ));
    }

    /// The needles are single words that live in healthy pages too: measured
    /// on 2026-08-17, Brave's SERP contains "captcha" and Bing's contains
    /// "turnstile". Without the size guard, a genuine zero-result query — or a
    /// parser broken by a markup change — would be reported as a bot wall and
    /// cool the engine down, hiding the real cause behind a wrong diagnosis.
    #[test]
    fn a_full_size_serp_is_never_a_challenge_however_it_reads() {
        for needle in ["captcha", "turnstile", "enable javascript"] {
            let page = format!(
                "<html><body>{}<div class=\"result\">real result</div>{}</body></html>",
                needle,
                "x".repeat(MAX_CHALLENGE_PAGE_BYTES)
            );
            assert!(
                !looks_like_bot_challenge(&page),
                "full-size page containing {:?} must not read as a challenge",
                needle
            );
        }
    }

    /// The two real interstitials sit far below the guard (5.5 KB and 10.3 KB
    /// as served), and the smallest real SERP measured — DuckDuckGo's HTML
    /// endpoint — is ~33 KB, so the threshold separates the populations rather
    /// than splitting one of them.
    #[test]
    fn challenge_size_guard_has_headroom_over_real_interstitials() {
        let mojeek_sized = format!(
            "<html><body>JavaScript is required to complete this challenge{}</body></html>",
            "x".repeat(5_500)
        );
        assert!(looks_like_bot_challenge(&mojeek_sized));
        let startpage_sized = format!(
            "<html><body>Verifying your request... anubis{}</body></html>",
            "x".repeat(10_332)
        );
        assert!(looks_like_bot_challenge(&startpage_sized));
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

    /// Mirrors Bing's live markup: organic results in `li.b_algo`, the title
    /// anchor pointing at a `ck/a` tracking URL with the real destination
    /// base64url-encoded (unpadded) after `u=a1`, and the snippet in
    /// `.b_caption p`. The second item is an ad wrapper, which must be ignored.
    #[test]
    fn parse_bing_decodes_tracking_links_and_skips_ads() {
        // base64url of "https://tokio.rs/", unpadded exactly as Bing sends it.
        let html = r##"
            <html><body><ol id="b_results">
            <li class="b_algo">
              <h2><a href="https://www.bing.com/ck/a?!&p=abc&u=a1aHR0cHM6Ly90b2tpby5ycy8&ntb=1">Tokio — An asynchronous Rust runtime</a></h2>
              <div class="b_caption"><p>Tokio is an asynchronous runtime for the Rust programming language.</p></div>
            </li>
            <li class="b_ad"><h2><a href="https://example.com/ad">An advert</a></h2></li>
            </ol></body></html>
        "##;
        let results = parse_bing_html(html).expect("parse ok");
        assert_eq!(results.len(), 1, "ads must not be collected");
        assert_eq!(results[0].url, "https://tokio.rs/");
        assert!(results[0].title.starts_with("Tokio"));
        assert!(results[0].snippet.contains("asynchronous runtime"));
    }

    /// A result whose link can't be decoded is dropped rather than reported
    /// with a bing.com tracking URL — those reach the model as citations.
    #[test]
    fn parse_bing_drops_results_it_cannot_resolve() {
        let html = r##"
            <html><body><ol id="b_results">
            <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&p=abc&ntb=1">No destination</a></h2></li>
            </ol></body></html>
        "##;
        assert!(parse_bing_html(html).expect("parse ok").is_empty());
    }

    #[test]
    fn bing_redirect_decode() {
        // Unpadded base64url, as served.
        assert_eq!(
            decode_bing_redirect("https://www.bing.com/ck/a?!&p=x&u=a1aHR0cHM6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvVG9reW8&ntb=1")
                .as_deref(),
            Some("https://en.wikipedia.org/wiki/Tokyo")
        );
        // Not a redirect link at all.
        assert_eq!(decode_bing_redirect("https://example.com/page"), None);
        // Payload that decodes to something that isn't a URL.
        assert_eq!(
            decode_bing_redirect("https://www.bing.com/ck/a?u=a1bm90YXVybA"),
            None
        );
    }

    #[test]
    fn parse_bing_handles_empty_input() {
        assert!(parse_bing_html("<html><body>nothing here</body></html>")
            .expect("parse ok")
            .is_empty());
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
