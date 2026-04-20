use log::{info, warn};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FETCH_LENGTH: usize = 4000;

/// Prefix the TS side uses to recognize a paywall signal from a fetched
/// page. Kept in sync with `RUST_PAYWALL_SENTINEL` in
/// `src/lib/agent/paywall.ts` — change both or neither.
const PAYWALL_SENTINEL: &str = "[[HARUSPEX_PAYWALL_SIGNAL]]";
const RATE_LIMIT_INTERVAL: Duration = Duration::from_secs(2);
const SEARCH_CACHE_TTL: Duration = Duration::from_secs(300); // 5 minutes
const FETCH_CACHE_TTL: Duration = Duration::from_secs(600); // 10 minutes
const ENGINE_COOLDOWN: Duration = Duration::from_secs(300); // 5 min cooldown after failure

// Slow-mode pacing — used by deep research with auto rotation when no
// reliable provider (Brave / SearXNG) is configured. Slower per-engine
// pacing reduces bot-detection trips, and shorter cooldowns let engines
// recover within the same research turn instead of taking the whole turn
// out of commission.
const RATE_LIMIT_INTERVAL_SLOW: Duration = Duration::from_secs(6);
const ENGINE_COOLDOWN_SLOW: Duration = Duration::from_secs(45);
// Note: Bing and Qwant were previously in this list but have been removed.
// As of April 2026:
//   - Bing serves a JavaScript shell + Cloudflare Turnstile bot challenge
//     for all `/search?q=...` requests; no result HTML exists in the
//     initial response.
//   - api.qwant.com is gated by DataDome (commercial JS-execution bot
//     detection), and the www.qwant.com HTML page is a Next.js SPA shell
//     with empty preloaded data — results are fetched client-side.
// Both have no plain-HTTP scraping path; resurrecting either would require
// a headless browser (Playwright/Puppeteer) or a paid API.
// See git history for the previous search_bing / search_qwant implementations.
const AUTO_ENGINES: &[&str] = &["brave_html", "duckduckgo", "mojeek"];

#[derive(Clone, Debug, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// User-configured HTTP proxy. Mirrors the `ProxyConfig` TS type and is
/// passed in as an optional argument on every egress command. `mode` is
/// either "none" or "manual" — any other value is treated as none so a
/// typo can't accidentally force traffic through an invalid URL. Bypass
/// entries are parsed per request; we don't cache them because the user
/// can edit them between calls and there's no hot path here.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProxyConfig {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub bypass: String,
}

enum BypassEntry {
    Cidr(ipnet::IpNet),
    Ip(IpAddr),
    /// Lowercased, leading "." stripped. Matches the host itself or any
    /// subdomain (Firefox-style).
    Host(String),
}

fn parse_bypass_list(raw: &str) -> Vec<BypassEntry> {
    raw.split([',', ';', '\n', '\r', ' ', '\t'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if let Ok(net) = s.parse::<ipnet::IpNet>() {
                BypassEntry::Cidr(net)
            } else if let Ok(ip) = s.parse::<IpAddr>() {
                BypassEntry::Ip(ip)
            } else {
                BypassEntry::Host(s.trim_start_matches('.').to_lowercase())
            }
        })
        .collect()
}

fn should_bypass(target: &reqwest::Url, entries: &[BypassEntry]) -> bool {
    let Some(host) = target.host_str() else {
        return false;
    };
    // url::Url returns IPv6 hosts wrapped in brackets (`[::1]`); strip
    // them before parsing so literal IPv6 destinations match.
    let host_bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host_bare.parse::<IpAddr>() {
        return entries.iter().any(|e| match e {
            BypassEntry::Cidr(net) => net.contains(&ip),
            BypassEntry::Ip(entry) => entry == &ip,
            BypassEntry::Host(_) => false,
        });
    }
    let host_lc = host.to_lowercase();
    entries.iter().any(|e| match e {
        BypassEntry::Host(h) => host_lc == *h || host_lc.ends_with(&format!(".{}", h)),
        _ => false,
    })
}

/// Apply the user's proxy config to a reqwest ClientBuilder. Returns the
/// builder unchanged when the proxy is disabled or the URL is blank; bails
/// with an error if the URL is set but unparseable.
fn apply_proxy(
    builder: reqwest::ClientBuilder,
    proxy: Option<&ProxyConfig>,
) -> Result<reqwest::ClientBuilder, String> {
    let Some(cfg) = proxy else { return Ok(builder) };
    if cfg.mode != "manual" {
        return Ok(builder);
    }
    let trimmed = cfg.url.trim();
    if trimmed.is_empty() {
        return Ok(builder);
    }
    let proxy_url = reqwest::Url::parse(trimmed)
        .map_err(|e| format!("Invalid proxy URL '{}': {}", trimmed, e))?;
    let bypass = parse_bypass_list(&cfg.bypass);
    let rp = reqwest::Proxy::custom(move |target| {
        if should_bypass(target, &bypass) {
            None
        } else {
            Some(proxy_url.clone())
        }
    });
    Ok(builder.proxy(rp))
}

struct CacheEntry<T> {
    value: T,
    expires_at: Instant,
}

pub struct ProxyState {
    last_search_time: Mutex<HashMap<String, Instant>>,
    engine_failures: Mutex<HashMap<String, Instant>>,
    search_cache: Mutex<HashMap<String, CacheEntry<Vec<SearchResult>>>>,
    fetch_cache: Mutex<HashMap<String, CacheEntry<String>>>,
    /// Index of the next engine to try first in auto-rotation. Incremented
    /// after each successful search so we round-robin through the engines
    /// instead of always starting with the same one.
    auto_rotation_cursor: Mutex<usize>,
}

impl ProxyState {
    pub fn new() -> Self {
        Self {
            last_search_time: Mutex::new(HashMap::new()),
            engine_failures: Mutex::new(HashMap::new()),
            search_cache: Mutex::new(HashMap::new()),
            fetch_cache: Mutex::new(HashMap::new()),
            auto_rotation_cursor: Mutex::new(0),
        }
    }

    /// Get the rotation order: starts at the cursor and wraps around so
    /// every engine is tried once. Does NOT advance the cursor — call
    /// advance_rotation_cursor() after a successful search.
    fn rotation_order(&self) -> Vec<&'static str> {
        let cursor = *self.auto_rotation_cursor.lock().unwrap();
        let n = AUTO_ENGINES.len();
        (0..n).map(|i| AUTO_ENGINES[(cursor + i) % n]).collect()
    }

    fn advance_rotation_cursor(&self) {
        let mut cursor = self.auto_rotation_cursor.lock().unwrap();
        *cursor = (*cursor + 1) % AUTO_ENGINES.len();
    }

    fn rate_limit_engine(&self, engine: &str, interval: Duration) {
        let mut last_times = self.last_search_time.lock().unwrap();
        if let Some(last_time) = last_times.get(engine) {
            let elapsed = last_time.elapsed();
            if elapsed < interval {
                std::thread::sleep(interval - elapsed);
            }
        }
        last_times.insert(engine.to_string(), Instant::now());
    }

    fn record_failure(&self, engine: &str) {
        let mut failures = self.engine_failures.lock().unwrap();
        failures.insert(engine.to_string(), Instant::now());
    }

    fn is_engine_healthy(&self, engine: &str, cooldown: Duration) -> bool {
        let failures = self.engine_failures.lock().unwrap();
        match failures.get(engine) {
            Some(failed_at) => failed_at.elapsed() >= cooldown,
            None => true,
        }
    }

    fn get_cached_search(&self, query: &str) -> Option<Vec<SearchResult>> {
        let cache = self.search_cache.lock().unwrap();
        cache.get(query).and_then(|entry| {
            if entry.expires_at > Instant::now() {
                Some(entry.value.clone())
            } else {
                None
            }
        })
    }

    fn cache_search(&self, query: &str, results: &[SearchResult]) {
        let mut cache = self.search_cache.lock().unwrap();
        cache.insert(
            query.to_string(),
            CacheEntry {
                value: results.to_vec(),
                expires_at: Instant::now() + SEARCH_CACHE_TTL,
            },
        );
    }

    fn get_cached_fetch(&self, url: &str) -> Option<String> {
        let cache = self.fetch_cache.lock().unwrap();
        cache.get(url).and_then(|entry| {
            if entry.expires_at > Instant::now() {
                Some(entry.value.clone())
            } else {
                None
            }
        })
    }

    fn cache_fetch(&self, url: &str, content: &str) {
        let mut cache = self.fetch_cache.lock().unwrap();
        cache.insert(
            url.to_string(),
            CacheEntry {
                value: content.to_string(),
                expires_at: Instant::now() + FETCH_CACHE_TTL,
            },
        );
    }
}

/// Build a diagnostic snippet of an HTML page for empty-result logging.
/// Tries to anchor on the first occurrence of any of the provided needles
/// (likely results-container substrings) and returns ~`window` chars
/// starting from a bit before that anchor. If no needle matches, falls
/// back to the first `window` chars of the page so we still see something.
/// This is what makes the empty-result log line actually actionable when
/// a search engine restructures its markup — we get the relevant body
/// instead of just the head metadata.
fn diagnostic_snippet(html: &str, needles: &[&str], window: usize) -> String {
    for needle in needles {
        if let Some(pos) = html.find(needle) {
            let start = pos.saturating_sub(200);
            // Walk forward from `start` until we hit a char boundary
            let mut s = start;
            while s < html.len() && !html.is_char_boundary(s) {
                s += 1;
            }
            return html[s..].chars().take(window).collect();
        }
    }
    html.chars().take(window).collect()
}

// DuckDuckGo HTML search

async fn search_duckduckgo(
    query: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, String> {
    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5))
            .cookie_store(true),
        proxy,
    )?
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

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
        .map_err(|e| format!("Search request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Search failed with status: {}", response.status()));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // Detect bot/captcha page
    if html.contains("cc=botnet") || html.contains("anomaly.js") {
        warn!("DuckDuckGo returned a bot detection page — search temporarily unavailable");
        return Err(
            "Web search is temporarily unavailable (rate limited). Try again in a few minutes."
                .to_string(),
        );
    }

    parse_ddg_html(&html)
}

fn parse_ddg_html(html: &str) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);
    let result_selector =
        Selector::parse(".result__body").map_err(|_| "Failed to parse selector")?;
    let title_selector =
        Selector::parse(".result__a").map_err(|_| "Failed to parse title selector")?;
    let snippet_selector =
        Selector::parse(".result__snippet").map_err(|_| "Failed to parse snippet selector")?;
    let url_selector =
        Selector::parse(".result__url").map_err(|_| "Failed to parse URL selector")?;

    let mut results = Vec::new();

    for element in document.select(&result_selector) {
        let title = element
            .select(&title_selector)
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        let snippet = element
            .select(&snippet_selector)
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
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
                    let text = e.text().collect::<String>().trim().to_string();
                    if !text.starts_with("http") {
                        format!("https://{}", text)
                    } else {
                        text
                    }
                })
            })
            .unwrap_or_default();

        if !title.is_empty() && !url.is_empty() {
            results.push(SearchResult {
                title,
                url,
                snippet,
            });
        }

        if results.len() >= 8 {
            break;
        }
    }

    Ok(results)
}

// Mojeek HTML search — small independent index, scrape-friendly, no API key.
// Useful as a fallback when DDG/Qwant are rate-limited or broken.

async fn search_mojeek(
    query: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, String> {
    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5)),
        proxy,
    )?
    .build()
    .map_err(|e| format!("HTTP client error: {}", e))?;

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

    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Mojeek search failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Mojeek error: {}", resp.status()));
    }

    let html = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read Mojeek response: {}", e))?;

    let results = parse_mojeek_html(&html)?;

    if results.is_empty() {
        let snippet = diagnostic_snippet(
            &html,
            &[
                "results-standard",
                "class=\"results",
                "id=\"results",
                "<main",
            ],
            3000,
        );
        warn!(
            "Mojeek parser found 0 results — anchored snippet of response: {}",
            snippet
        );
    }

    Ok(results)
}

fn parse_mojeek_html(html: &str) -> Result<Vec<SearchResult>, String> {
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

    let mut results = Vec::new();

    for element in document.select(&result_selector) {
        let title_el = element
            .select(&title_selector_primary)
            .next()
            .or_else(|| element.select(&title_selector_fallback).next());

        let title = title_el
            .map(|e| e.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        let url = title_el
            .and_then(|e| e.value().attr("href"))
            .unwrap_or_default()
            .to_string();
        let snippet = element
            .select(&snippet_selector)
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        if !title.is_empty() && !url.is_empty() && url.starts_with("http") {
            results.push(SearchResult {
                title,
                url,
                snippet,
            });
        }

        if results.len() >= 8 {
            break;
        }
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

async fn search_brave_html(
    query: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, String> {
    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5)),
        proxy,
    )?
    .build()
    .map_err(|e| format!("HTTP client error: {}", e))?;

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

    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Brave HTML search failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Brave HTML error: {}", resp.status()));
    }

    let html = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read Brave HTML response: {}", e))?;

    let results = parse_brave_html(&html)?;

    if results.is_empty() {
        let snippet = diagnostic_snippet(
            &html,
            &[
                "data-type=\"web\"",
                "search-snippet-title",
                "generic-snippet",
                "result-wrapper",
            ],
            3000,
        );
        warn!(
            "Brave HTML parser found 0 results — anchored snippet of response: {}",
            snippet
        );
    }

    Ok(results)
}

fn parse_brave_html(html: &str) -> Result<Vec<SearchResult>, String> {
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

    let mut results = Vec::new();

    for element in document.select(&result_selector) {
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
            .map(|e| e.text().collect::<String>().trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| link.map(|e| e.text().collect::<String>().trim().to_string()))
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

        if !title.is_empty() && !url.is_empty() && url.starts_with("http") {
            results.push(SearchResult {
                title,
                url,
                snippet,
            });
        }

        if results.len() >= 8 {
            break;
        }
    }

    Ok(results)
}

// Auto-rotation search across multiple engines

async fn search_auto(
    state: &ProxyState,
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
    let mut healthy: Vec<&str> = Vec::new();
    let mut unhealthy: Vec<&str> = Vec::new();

    for engine in &rotation {
        if state.is_engine_healthy(engine, cooldown) {
            healthy.push(*engine);
        } else {
            unhealthy.push(*engine);
        }
    }

    let ordered: Vec<&str> = healthy.into_iter().chain(unhealthy).collect();
    info!(
        "Auto-search rotation order for '{}' (slow_mode={}): {:?}",
        query, slow_mode, ordered
    );

    let mut last_error = String::new();

    for engine in &ordered {
        state.rate_limit_engine(engine, rate_interval);
        info!(
            "Auto-search trying {} for: {} (recency: {})",
            engine, query, recency
        );

        let result = match *engine {
            "brave_html" => search_brave_html(query, recency, proxy).await,
            "duckduckgo" => search_duckduckgo(query, recency, proxy).await,
            "mojeek" => search_mojeek(query, recency, proxy).await,
            _ => unreachable!(),
        };

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
                last_error = e;
            }
        }
    }

    // All engines failed — still advance the cursor so the next attempt
    // starts somewhere new.
    state.advance_rotation_cursor();
    Err(format!(
        "All search engines failed. Last error: {}",
        last_error
    ))
}

// URL fetching with content extraction

async fn fetch_and_extract(url: &str, proxy: Option<&ProxyConfig>) -> Result<String, String> {
    // Validate URL
    validate_url(url)?;

    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5)),
        proxy,
    )?
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Fetch failed with status: {}", response.status()));
    }

    // Check content type
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !content_type.contains("text/html") && !content_type.contains("text/plain") {
        return Err(format!("Content type not supported: {}", content_type));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // Before stripping to plain text, check whether the raw HTML carries
    // a standardized paywall marker. When a page self-declares as gated,
    // return a sentinel instead of the extracted body — the model can't
    // usefully cite a preview, and the TS layer will reject the URL as a
    // citation source. See the comment on PAYWALL_SENTINEL.
    if let Some(reason) = detect_paywall_signal(&html) {
        return Ok(format!("{} {}", PAYWALL_SENTINEL, reason));
    }

    Ok(extract_text(&html))
}

/// Inspect the raw HTML of a fetched page for standardized paywall
/// declarations. Host-agnostic: we never match a specific publisher.
/// Signals checked (in order):
///
///   1. Schema.org JSON-LD `"isAccessibleForFree": false`. This is the
///      field Google News / Search expect when indexing gated content;
///      most publishers emit it to keep their articles indexable even
///      when behind a paywall.
///   2. OpenGraph / Facebook News meta `article:content_tier = locked`.
///      A parallel convention used by social platforms for the same
///      purpose. Less universal than Schema.org but catches a few sites
///      that omit the JSON-LD.
///
/// Returns `Some(reason)` when a marker is found, `None` otherwise.
/// Reason string is used downstream to explain why a URL was rejected.
fn detect_paywall_signal(html: &str) -> Option<&'static str> {
    let lowered = html.to_lowercase();

    // Compact form collapses all whitespace so JSON keys/values and
    // attribute spacing don't have to match a specific layout.
    let compact: String = lowered.chars().filter(|c| !c.is_whitespace()).collect();

    if compact.contains("\"isaccessibleforfree\":false") {
        return Some("Schema.org isAccessibleForFree=false");
    }

    // OG meta attribute order is arbitrary (`property` before `content`
    // or vice versa). Rather than match the whole tag literally, walk
    // every `<meta ...>` tag and flag it only when BOTH the tier key
    // and a "locked" value live inside the same tag's angle brackets.
    // Restricting to tag boundaries prevents prose that happens to
    // mention both strings from tripping the detector.
    let mut cursor = 0;
    while let Some(rel) = lowered[cursor..].find("<meta") {
        let start = cursor + rel;
        let tag_end = lowered[start..]
            .find('>')
            .map(|e| start + e + 1)
            .unwrap_or(lowered.len());
        let tag = &lowered[start..tag_end];
        if tag.contains("article:content_tier")
            && (tag.contains("\"locked\"") || tag.contains("'locked'"))
        {
            return Some("OpenGraph article:content_tier=locked");
        }
        cursor = tag_end;
    }

    None
}

pub(crate) fn validate_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "Invalid URL".to_string())?;

    // Only allow HTTP(S)
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("Unsupported URL scheme: {}", scheme)),
    }

    // Reject private/local IPs (SSRF protection)
    if let Some(host) = parsed.host_str() {
        if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "0.0.0.0" {
            return Err("Local URLs are not allowed".to_string());
        }

        if let Ok(ip) = host.parse::<IpAddr>() {
            if is_private_ip(&ip) {
                return Err("Private IP addresses are not allowed".to_string());
            }
        }
    }

    Ok(())
}

fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
        }
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
    }
}

fn extract_text(html: &str) -> String {
    let document = Html::parse_document(html);

    // Try to find main content area
    let content = try_select_text(&document, "article")
        .or_else(|| try_select_text(&document, "main"))
        .or_else(|| try_select_text(&document, "[role='main']"))
        .unwrap_or_else(|| extract_body_text(&document));

    // Clean up whitespace
    let cleaned = content
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<&str>>()
        .join("\n");

    // Truncate
    if cleaned.len() > MAX_FETCH_LENGTH {
        let truncated = &cleaned[..MAX_FETCH_LENGTH];
        // Find the last complete word
        if let Some(pos) = truncated.rfind(char::is_whitespace) {
            format!("{}...", &truncated[..pos])
        } else {
            format!("{}...", truncated)
        }
    } else {
        cleaned
    }
}

fn try_select_text(document: &Html, selector_str: &str) -> Option<String> {
    let selector = Selector::parse(selector_str).ok()?;
    let element = document.select(&selector).next()?;
    let text = element.text().collect::<String>();
    let trimmed = text.trim();
    if trimmed.len() > 100 {
        Some(trimmed.to_string())
    } else {
        None // Too short, probably not the main content
    }
}

fn extract_body_text(document: &Html) -> String {
    // Remove script, style, nav, header, footer, aside elements by collecting
    // text only from visible content elements
    let body_selector = Selector::parse("body").unwrap();

    if let Some(body) = document.select(&body_selector).next() {
        body.text().collect::<String>()
    } else {
        document.root_element().text().collect::<String>()
    }
}

// Brave Search API

async fn search_brave(
    query: &str,
    api_key: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, String> {
    let client = apply_proxy(reqwest::Client::builder().timeout(FETCH_TIMEOUT), proxy)?
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

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
        .map_err(|e| format!("Brave search failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Brave search error {}: {}", status, body));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Brave response: {}", e))?;

    let mut results = Vec::new();
    if let Some(web_results) = data
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|r| r.as_array())
    {
        for item in web_results.iter().take(8) {
            let title = item
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or_default();
            let url = item.get("url").and_then(|u| u.as_str()).unwrap_or_default();
            let snippet = item
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or_default();

            if !title.is_empty() && !url.is_empty() {
                results.push(SearchResult {
                    title: title.to_string(),
                    url: url.to_string(),
                    snippet: snippet.to_string(),
                });
            }
        }
    }

    Ok(results)
}

// SearXNG instance search

async fn search_searxng(
    query: &str,
    instance_url: &str,
    recency: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<SearchResult>, String> {
    let client = apply_proxy(reqwest::Client::builder().timeout(FETCH_TIMEOUT), proxy)?
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

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
        .map_err(|e| format!("SearXNG search failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("SearXNG error: {}", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse SearXNG response: {}", e))?;

    let mut results = Vec::new();
    if let Some(items) = data.get("results").and_then(|r| r.as_array()) {
        for item in items.iter().take(8) {
            let title = item
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or_default();
            let url = item.get("url").and_then(|u| u.as_str()).unwrap_or_default();
            let snippet = item
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or_default();

            if !title.is_empty() && !url.is_empty() {
                results.push(SearchResult {
                    title: title.to_string(),
                    url: url.to_string(),
                    snippet: snippet.to_string(),
                });
            }
        }
    }

    Ok(results)
}

// Tauri commands

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn proxy_search(
    state: tauri::State<'_, ProxyState>,
    query: String,
    provider: Option<String>,
    api_key: Option<String>,
    instance_url: Option<String>,
    recency: Option<String>,
    deep_research: Option<bool>,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<SearchResult>, String> {
    // Check cache
    let cache_key = format!("{}:{}", query, recency.as_deref().unwrap_or("any"));
    if let Some(cached) = state.get_cached_search(&cache_key) {
        info!("Search cache hit for: {}", query);
        return Ok(cached);
    }

    let provider = provider.as_deref().unwrap_or("duckduckgo");
    let recency = recency.as_deref().unwrap_or("any");
    let deep_research = deep_research.unwrap_or(false);
    let proxy_ref = proxy.as_ref();

    let results = match provider {
        "brave" => {
            let key = api_key.as_deref().unwrap_or("");
            if key.is_empty() {
                return Err("Brave Search API key not configured".to_string());
            }
            info!("Searching Brave for: {} (recency: {})", query, recency);
            search_brave(&query, key, recency, proxy_ref).await?
        }
        "searxng" => {
            let url = instance_url.as_deref().unwrap_or("http://localhost:8080");
            info!(
                "Searching SearXNG ({}) for: {} (recency: {})",
                url, query, recency
            );
            search_searxng(&query, url, recency, proxy_ref).await?
        }
        "auto" => {
            info!(
                "Auto-searching for: {} (recency: {}, deep_research: {})",
                query, recency, deep_research
            );
            search_auto(&state, &query, recency, deep_research, proxy_ref).await?
        }
        _ => {
            state.rate_limit_engine("duckduckgo", RATE_LIMIT_INTERVAL);
            info!("Searching DDG for: {} (recency: {})", query, recency);
            search_duckduckgo(&query, recency, proxy_ref).await?
        }
    };

    if results.is_empty() {
        warn!("No search results for: {}", query);
    }

    state.cache_search(&cache_key, &results);
    Ok(results)
}

#[tauri::command]
pub async fn proxy_fetch(
    state: tauri::State<'_, ProxyState>,
    url: String,
    caller: Option<String>,
    proxy: Option<ProxyConfig>,
) -> Result<String, String> {
    // Tag for the log line so we can distinguish fetch_url calls (raw page
    // text returned to the main agent) from research_url calls (page goes
    // through a sub-agent extractor before its findings reach the main agent).
    let caller_tag = caller.as_deref().unwrap_or("fetch_url");

    // Check cache
    if let Some(cached) = state.get_cached_fetch(&url) {
        info!("Fetch cache hit ({}) for: {}", caller_tag, url);
        return Ok(cached);
    }

    info!("Fetching URL ({}): {}", caller_tag, url);
    let content = fetch_and_extract(&url, proxy.as_ref()).await?;

    state.cache_fetch(&url, &content);
    Ok(content)
}

/// A single `<img>` reference discovered on a fetched web page. Width
/// and height are from the HTML attributes when present — many modern
/// pages omit them (relying on CSS), so they're optional. `src` is
/// always absolute (relative URLs are resolved against the page URL
/// before they leave `fetch_url_images`).
#[derive(Clone, Debug, Serialize)]
pub struct PageImage {
    pub src: String,
    pub alt: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Fetch a web page and extract up to 50 image URLs from its HTML.
/// Sources scanned, in order:
///
///   1. `<meta property="og:image">` — usually the page's hero image
///      and often the highest quality single URL.
///   2. `<link rel="image_src">` — legacy but some sites still emit it.
///   3. `<img src="...">` — everything visible in the body.
///
/// Relative `src` values are resolved against the page URL. Obviously
/// decorative entries are dropped: empty `src`, `data:` URLs under 500
/// bytes (tracking pixels, tiny icons), and `src` values that don't
/// parse as a valid URL after resolution.
///
/// The model uses this in combination with `fs_download_url` to fetch
/// manufacturer product shots or other page-hosted imagery and embed
/// them in a generated presentation. See the tool description for the
/// licensing caveat (results are NOT guaranteed to be free-to-use).
#[tauri::command]
pub async fn proxy_fetch_url_images(
    url: String,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<PageImage>, String> {
    validate_url(&url)?;
    info!("fetch_url_images: {}", url);

    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5)),
        proxy.as_ref(),
    )?
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Fetch failed with status: {}", response.status()));
    }

    // Capture the final URL after any redirects so we resolve relative
    // `src` attributes against the page the browser actually landed on,
    // not the URL we originally requested.
    let base_url = response.url().clone();

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !content_type.contains("text/html") && !content_type.contains("application/xhtml") {
        return Err(format!(
            "Content type not HTML ({}); nothing to scan for images.",
            content_type
        ));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    Ok(extract_page_images(&html, &base_url))
}

/// Parse `html` and return up to 50 deduplicated image references.
/// Extracted as a standalone function so it can be unit-tested against
/// HTML fixtures without touching the network.
fn extract_page_images(html: &str, base_url: &url::Url) -> Vec<PageImage> {
    const MAX_RESULTS: usize = 50;
    // Minimum size for a data: URL to be worth returning. Below this
    // it's almost certainly a tracking pixel or decorative sprite.
    const MIN_DATA_URL_BYTES: usize = 500;

    let doc = Html::parse_document(html);
    let mut seen_srcs: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<PageImage> = Vec::new();

    // Helper: resolve a raw src against the page base, validate, dedup.
    let mut push_candidate = |src: &str, alt: &str, width: Option<u32>, height: Option<u32>| {
        if out.len() >= MAX_RESULTS {
            return;
        }
        let raw = src.trim();
        if raw.is_empty() {
            return;
        }

        // Reject tiny data: URLs outright (tracking pixels / blank
        // placeholders). Larger data URLs could be legitimate inline
        // photos, so we keep those.
        if raw.starts_with("data:") {
            if raw.len() < MIN_DATA_URL_BYTES {
                return;
            }
            if !seen_srcs.insert(raw.to_string()) {
                return;
            }
            out.push(PageImage {
                src: raw.to_string(),
                alt: alt.to_string(),
                width,
                height,
            });
            return;
        }

        // Resolve relative URLs against the page base. Skip anything
        // that doesn't parse or ends up with an unsupported scheme.
        let absolute = match base_url.join(raw) {
            Ok(u) => u,
            Err(_) => return,
        };
        match absolute.scheme() {
            "http" | "https" => {}
            _ => return,
        }
        let abs_string: String = absolute.into();
        if !seen_srcs.insert(abs_string.clone()) {
            return;
        }
        out.push(PageImage {
            src: abs_string,
            alt: alt.to_string(),
            width,
            height,
        });
    };

    // 1) og:image meta tag — often the hero/best single image
    if let Ok(sel) = Selector::parse(r#"meta[property="og:image"]"#) {
        for el in doc.select(&sel) {
            if let Some(content) = el.value().attr("content") {
                push_candidate(content, "og:image", None, None);
            }
        }
    }
    // Also twitter:image, same idea
    if let Ok(sel) = Selector::parse(r#"meta[name="twitter:image"]"#) {
        for el in doc.select(&sel) {
            if let Some(content) = el.value().attr("content") {
                push_candidate(content, "twitter:image", None, None);
            }
        }
    }
    // 2) link rel=image_src — legacy discovery hint
    if let Ok(sel) = Selector::parse(r#"link[rel="image_src"]"#) {
        for el in doc.select(&sel) {
            if let Some(href) = el.value().attr("href") {
                push_candidate(href, "image_src", None, None);
            }
        }
    }
    // 3) body <img src="...">
    if let Ok(sel) = Selector::parse("img") {
        for el in doc.select(&sel) {
            let Some(src) = el.value().attr("src") else {
                continue;
            };
            let alt = el.value().attr("alt").unwrap_or("");
            let width = el
                .value()
                .attr("width")
                .and_then(|s| s.trim().parse::<u32>().ok());
            let height = el
                .value()
                .attr("height")
                .and_then(|s| s.trim().parse::<u32>().ok());
            push_candidate(src, alt, width, height);
        }
    }

    out
}

/// One image result from the Wikimedia Commons search. Fields are what
/// the frontend / agent need to decide whether to download:
///   - `title`: the File: page title, e.g. "File:Eiffel Tower.jpg"
///   - `url`: full-resolution image URL (upload.wikimedia.org)
///   - `thumb_url`: 800px-wide thumbnail for preview
///   - `width`/`height`: original pixel dimensions
///   - `mime`: server-declared MIME type
///   - `license`: short license name if present (e.g. "CC BY-SA 4.0")
///   - `attribution`: author/credit line, plain text
///   - `description_url`: Commons page URL for the file (attribution link)
#[derive(Clone, Debug, Serialize)]
pub struct ImageSearchResult {
    pub title: String,
    pub url: String,
    pub thumb_url: String,
    pub width: u32,
    pub height: u32,
    pub mime: String,
    pub license: String,
    pub attribution: String,
    pub description_url: String,
}

/// Search Wikimedia Commons for images matching `query`. Two-call flow:
///
///   1. `list=search&srnamespace=6` → find File:* page titles
///   2. `prop=imageinfo&iiurlwidth=800` → resolve actual upload URLs
///      and extract license / attribution from extmetadata
///
/// Commons is used because all content is openly licensed (public domain
/// or CC family) — embedding those in a generated PPTX is safe from a
/// licensing standpoint. Returns up to `max_results.unwrap_or(5)` items,
/// capped at 20.
#[tauri::command]
pub async fn proxy_image_search(
    query: String,
    max_results: Option<usize>,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<ImageSearchResult>, String> {
    use serde_json::Value;

    let limit = max_results.unwrap_or(5).clamp(1, 20);
    info!("image_search (commons) q={:?} limit={}", query, limit);

    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5)),
        proxy.as_ref(),
    )?
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Step 1: search for file titles in the File: namespace.
    let search_url = format!(
        "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit={}&srsearch={}",
        limit,
        urlencoding::encode(&query)
    );
    let search_resp: Value = client
        .get(&search_url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Commons search request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Commons search JSON parse failed: {}", e))?;

    let titles: Vec<String> = search_resp
        .get("query")
        .and_then(|q| q.get("search"))
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("title").and_then(|t| t.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if titles.is_empty() {
        return Ok(Vec::new());
    }

    // Step 2: resolve URLs + metadata for all matched titles in a single
    // call. Commons accepts up to 50 pipe-separated titles per request;
    // we're already capped at 20 above so this is always one round trip.
    let titles_param = titles.join("|");
    let info_url = format!(
        "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=800&titles={}",
        urlencoding::encode(&titles_param)
    );
    let info_resp: Value = client
        .get(&info_url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Commons imageinfo request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Commons imageinfo JSON parse failed: {}", e))?;

    let results = parse_commons_imageinfo(&info_resp, &titles);
    Ok(results)
}

/// Pull a string value out of Commons' extmetadata shape, which wraps
/// every field in `{ "value": "...", "source": "...", ... }`. Handles
/// both plain-text values and HTML-ish ones (the caller strips tags).
fn commons_extmetadata_string(extmeta: &serde_json::Value, key: &str) -> String {
    extmeta
        .get(key)
        .and_then(|v| v.get("value"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

/// Strip the HTML tags Commons sometimes embeds in extmetadata values
/// (Artist is frequently an `<a href="...">Name</a>` link). We only need
/// the plain text for the attribution field, and keeping it ASCII-safe
/// sidesteps a bunch of rendering edge cases downstream.
fn strip_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parse the JSON response from the imageinfo API call into a list of
/// `ImageSearchResult`. Extracted as a free function so it can be unit-
/// tested against hand-rolled JSON fixtures without touching the network.
/// `ordered_titles` preserves the result order from the search step — the
/// Commons API returns `pages` as an unordered map keyed by pageid, so we
/// re-project through the original title order for deterministic output.
fn parse_commons_imageinfo(
    info_resp: &serde_json::Value,
    ordered_titles: &[String],
) -> Vec<ImageSearchResult> {
    let Some(pages) = info_resp
        .get("query")
        .and_then(|q| q.get("pages"))
        .and_then(|p| p.as_object())
    else {
        return Vec::new();
    };

    // Build a lookup from title → page JSON so we can re-project in the
    // original search order.
    let mut by_title: std::collections::HashMap<&str, &serde_json::Value> =
        std::collections::HashMap::new();
    for page in pages.values() {
        if let Some(title) = page.get("title").and_then(|t| t.as_str()) {
            by_title.insert(title, page);
        }
    }

    let mut out = Vec::new();
    for title in ordered_titles {
        let Some(page) = by_title.get(title.as_str()) else {
            continue;
        };
        let Some(info) = page
            .get("imageinfo")
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
        else {
            continue;
        };
        let url = info
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // Commons returns thumburl when iiurlwidth is specified; fall
        // back to the original url if it's missing (e.g. image smaller
        // than the requested thumbnail width).
        let thumb_url = info
            .get("thumburl")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| url.clone());
        let width = info.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let height = info.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let mime = info
            .get("mime")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let description_url = info
            .get("descriptionurl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let extmeta = info.get("extmetadata").cloned().unwrap_or_default();
        let license = commons_extmetadata_string(&extmeta, "LicenseShortName");
        let artist_raw = commons_extmetadata_string(&extmeta, "Artist");
        let attribution = strip_html_tags(&artist_raw);

        if url.is_empty() {
            continue;
        }
        out.push(ImageSearchResult {
            title: title.clone(),
            url,
            thumb_url,
            width,
            height,
            mime,
            license,
            attribution,
            description_url,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bypass(list: &str) -> Vec<BypassEntry> {
        parse_bypass_list(list)
    }

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }

    #[test]
    fn bypass_host_matches_exact_and_subdomain() {
        let entries = bypass("example.com");
        assert!(should_bypass(&url("https://example.com/"), &entries));
        assert!(should_bypass(&url("https://api.example.com/x"), &entries));
        assert!(!should_bypass(&url("https://otherexample.com/"), &entries));
        assert!(!should_bypass(&url("https://example.org/"), &entries));
    }

    #[test]
    fn bypass_ignores_leading_dot_on_host_entry() {
        let entries = bypass(".example.com");
        assert!(should_bypass(&url("https://example.com/"), &entries));
        assert!(should_bypass(&url("https://www.example.com/"), &entries));
    }

    #[test]
    fn bypass_matches_ipv4_literal_and_cidr() {
        let entries = bypass("192.168.1.5, 10.0.0.0/8");
        assert!(should_bypass(&url("http://192.168.1.5/"), &entries));
        assert!(should_bypass(&url("http://10.99.99.99/"), &entries));
        assert!(!should_bypass(&url("http://192.168.1.6/"), &entries));
        assert!(!should_bypass(&url("http://11.0.0.1/"), &entries));
    }

    #[test]
    fn bypass_matches_ipv6_cidr() {
        let entries = bypass("2001:db8::/32");
        assert!(should_bypass(&url("http://[2001:db8:1::abcd]/"), &entries));
        assert!(!should_bypass(&url("http://[2001:db9::abcd]/"), &entries));
    }

    #[test]
    fn bypass_accepts_newline_and_comma_separators() {
        let entries = bypass("example.com,\n  192.168.0.0/16 ; foo.org\n");
        assert!(should_bypass(&url("https://example.com/"), &entries));
        assert!(should_bypass(&url("https://foo.org/"), &entries));
        assert!(should_bypass(&url("http://192.168.5.5/"), &entries));
    }

    #[test]
    fn bypass_empty_list_never_matches() {
        let entries = bypass("");
        assert!(!should_bypass(&url("https://example.com/"), &entries));
    }

    #[test]
    fn apply_proxy_noop_when_mode_is_none() {
        let cfg = ProxyConfig {
            mode: "none".to_string(),
            url: "http://proxy.example:8080".to_string(),
            bypass: String::new(),
        };
        // Just verifies apply_proxy accepts the config and returns Ok;
        // we can't inspect whether a proxy was attached to the builder,
        // but this confirms the "none" branch doesn't error on a set URL.
        assert!(apply_proxy(reqwest::Client::builder(), Some(&cfg)).is_ok());
    }

    #[test]
    fn apply_proxy_errors_on_invalid_url() {
        let cfg = ProxyConfig {
            mode: "manual".to_string(),
            url: "not a url".to_string(),
            bypass: String::new(),
        };
        assert!(apply_proxy(reqwest::Client::builder(), Some(&cfg)).is_err());
    }

    #[test]
    fn apply_proxy_ignores_blank_manual_url() {
        let cfg = ProxyConfig {
            mode: "manual".to_string(),
            url: "   ".to_string(),
            bypass: String::new(),
        };
        assert!(apply_proxy(reqwest::Client::builder(), Some(&cfg)).is_ok());
    }

    #[test]
    fn validate_url_accepts_https() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("http://example.com/path?q=1").is_ok());
    }

    #[test]
    fn validate_url_rejects_non_http() {
        assert!(validate_url("ftp://example.com").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn validate_url_rejects_localhost() {
        assert!(validate_url("http://localhost").is_err());
        assert!(validate_url("http://127.0.0.1").is_err());
        assert!(validate_url("http://0.0.0.0").is_err());
    }

    #[test]
    fn validate_url_rejects_private_ips() {
        assert!(validate_url("http://10.0.0.1").is_err());
        assert!(validate_url("http://192.168.1.1").is_err());
        assert!(validate_url("http://172.16.0.1").is_err());
    }

    #[test]
    fn validate_url_rejects_invalid() {
        assert!(validate_url("not a url").is_err());
        assert!(validate_url("").is_err());
    }

    #[test]
    fn extract_page_images_resolves_relative_urls() {
        let base = url::Url::parse("https://example.com/products/mobo/").unwrap();
        let html = r#"<html><body>
            <img src="hero.png" alt="Hero shot">
            <img src="/static/gallery/side.jpg" alt="Side">
            <img src="https://cdn.example.com/top.webp" alt="Top" width="1200" height="800">
        </body></html>"#;
        let images = extract_page_images(html, &base);
        assert_eq!(images.len(), 3);
        // Relative URL resolved against the page directory.
        assert!(images
            .iter()
            .any(|i| i.src == "https://example.com/products/mobo/hero.png"));
        // Absolute-path URL resolved against the page host.
        assert!(images
            .iter()
            .any(|i| i.src == "https://example.com/static/gallery/side.jpg"));
        // Fully-qualified URL passes through unchanged with width/height.
        let top = images
            .iter()
            .find(|i| i.src == "https://cdn.example.com/top.webp")
            .unwrap();
        assert_eq!(top.alt, "Top");
        assert_eq!(top.width, Some(1200));
        assert_eq!(top.height, Some(800));
    }

    #[test]
    fn extract_page_images_picks_up_og_and_twitter_meta() {
        let base = url::Url::parse("https://example.com/article").unwrap();
        let html = r#"<html><head>
            <meta property="og:image" content="https://cdn.example.com/og.jpg">
            <meta name="twitter:image" content="https://cdn.example.com/twitter.jpg">
            <link rel="image_src" href="https://cdn.example.com/legacy.jpg">
        </head><body></body></html>"#;
        let images = extract_page_images(html, &base);
        let srcs: Vec<&str> = images.iter().map(|i| i.src.as_str()).collect();
        assert!(srcs.contains(&"https://cdn.example.com/og.jpg"));
        assert!(srcs.contains(&"https://cdn.example.com/twitter.jpg"));
        assert!(srcs.contains(&"https://cdn.example.com/legacy.jpg"));
    }

    #[test]
    fn extract_page_images_deduplicates_and_filters_garbage() {
        let base = url::Url::parse("https://example.com/").unwrap();
        let html = r#"<html><body>
            <img src="photo.jpg" alt="x">
            <img src="photo.jpg" alt="y">
            <img src="" alt="empty">
            <img src="data:image/gif;base64,R0lGOD" alt="tiny pixel">
            <img src="javascript:alert(1)" alt="bad scheme">
        </body></html>"#;
        let images = extract_page_images(html, &base);
        // Duplicate photo.jpg collapses to one entry
        assert_eq!(
            images
                .iter()
                .filter(|i| i.src == "https://example.com/photo.jpg")
                .count(),
            1
        );
        // Empty src is dropped
        assert!(!images.iter().any(|i| i.alt == "empty"));
        // Short data: URL is dropped (below threshold)
        assert!(!images.iter().any(|i| i.alt == "tiny pixel"));
        // Bad scheme is dropped
        assert!(!images.iter().any(|i| i.alt == "bad scheme"));
    }

    #[test]
    fn parse_commons_imageinfo_extracts_fields() {
        // Minimal response shape mimicking the Commons imageinfo API.
        // Includes two pages to verify title-order projection — the
        // Commons `pages` map is unordered, so we rely on the ordered
        // `titles` slice to define result order.
        let json = serde_json::json!({
            "query": {
                "pages": {
                    "99": {
                        "title": "File:Beta.png",
                        "imageinfo": [{
                            "url": "https://upload.wikimedia.org/full/beta.png",
                            "thumburl": "https://upload.wikimedia.org/thumb/beta.png",
                            "width": 1024,
                            "height": 768,
                            "mime": "image/png",
                            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Beta.png",
                            "extmetadata": {
                                "LicenseShortName": { "value": "CC BY-SA 4.0" },
                                "Artist": { "value": "<a href=\"//foo\">Jane Doe</a>" }
                            }
                        }]
                    },
                    "42": {
                        "title": "File:Alpha.jpg",
                        "imageinfo": [{
                            "url": "https://upload.wikimedia.org/full/alpha.jpg",
                            "thumburl": "https://upload.wikimedia.org/thumb/alpha.jpg",
                            "width": 2000,
                            "height": 1500,
                            "mime": "image/jpeg",
                            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Alpha.jpg",
                            "extmetadata": {
                                "LicenseShortName": { "value": "Public domain" },
                                "Artist": { "value": "John Doe" }
                            }
                        }]
                    }
                }
            }
        });
        let ordered = vec!["File:Alpha.jpg".to_string(), "File:Beta.png".to_string()];
        let out = parse_commons_imageinfo(&json, &ordered);
        // Result order matches the ordered titles slice, not the JSON map order.
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, "File:Alpha.jpg");
        assert_eq!(out[0].url, "https://upload.wikimedia.org/full/alpha.jpg");
        assert_eq!(out[0].width, 2000);
        assert_eq!(out[0].license, "Public domain");
        assert_eq!(out[0].attribution, "John Doe");

        assert_eq!(out[1].title, "File:Beta.png");
        assert_eq!(out[1].license, "CC BY-SA 4.0");
        // HTML tags in the Artist field are stripped.
        assert_eq!(out[1].attribution, "Jane Doe");
    }

    #[test]
    fn parse_commons_imageinfo_returns_empty_on_malformed() {
        let empty = serde_json::json!({});
        assert!(parse_commons_imageinfo(&empty, &["File:X.jpg".to_string()]).is_empty());

        let no_imageinfo = serde_json::json!({
            "query": { "pages": { "1": { "title": "File:Y.jpg" } } }
        });
        assert!(parse_commons_imageinfo(&no_imageinfo, &["File:Y.jpg".to_string()]).is_empty());
    }

    #[test]
    fn extract_text_from_simple_html() {
        let html = r#"<html><body><article><p>Hello world</p><p>Second paragraph</p></article></body></html>"#;
        let text = extract_text(html);
        assert!(text.contains("Hello world"));
        assert!(text.contains("Second paragraph"));
    }

    #[test]
    fn extract_text_truncates_long_content() {
        let long_text = "word ".repeat(2000);
        let html = format!(
            "<html><body><article><p>{}</p></article></body></html>",
            long_text
        );
        let text = extract_text(&html);
        assert!(text.len() <= MAX_FETCH_LENGTH + 10); // +10 for "..."
        assert!(text.ends_with("..."));
    }

    #[test]
    fn detect_paywall_signal_schema_org_is_accessible_for_free() {
        let html = r#"<html><head>
            <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"NewsArticle","isAccessibleForFree":false}
            </script></head><body><p>Short preview.</p></body></html>"#;
        let result = detect_paywall_signal(html);
        assert!(result.is_some());
        assert!(result.unwrap().contains("isAccessibleForFree"));
    }

    #[test]
    fn detect_paywall_signal_schema_org_spaced() {
        // JSON-LD with spacing and mixed-case, as emitted by some CMS.
        let html = r#"<script type="application/ld+json">
            {
                "@type": "NewsArticle",
                "isAccessibleForFree": false
            }
        </script>"#;
        assert!(detect_paywall_signal(html).is_some());
    }

    #[test]
    fn detect_paywall_signal_og_content_tier_locked() {
        let html = r#"<html><head>
            <meta property="article:content_tier" content="locked">
        </head><body>Preview</body></html>"#;
        let result = detect_paywall_signal(html);
        assert!(result.is_some());
        assert!(result.unwrap().contains("content_tier"));
    }

    #[test]
    fn detect_paywall_signal_og_content_tier_reversed_attributes() {
        // Attribute order is arbitrary for OG meta tags.
        let html = r#"<meta content="locked" property="article:content_tier">"#;
        assert!(detect_paywall_signal(html).is_some());
    }

    #[test]
    fn detect_paywall_signal_free_article_not_flagged() {
        let html = r#"<html><head>
            <script type="application/ld+json">
            {"@type":"NewsArticle","isAccessibleForFree":true}
            </script>
            <meta property="article:content_tier" content="free">
        </head><body>Full article body.</body></html>"#;
        assert!(detect_paywall_signal(html).is_none());
    }

    #[test]
    fn detect_paywall_signal_plain_article_not_flagged() {
        let html = r#"<html><body><article>
            <p>A perfectly normal free article with no paywall metadata.</p>
        </article></body></html>"#;
        assert!(detect_paywall_signal(html).is_none());
    }

    #[test]
    fn detect_paywall_signal_content_tier_key_without_locked_value_not_flagged() {
        // A page that mentions the key name in prose or a different
        // config block should not be flagged — the "locked" value has
        // to live within the attribute window.
        let html = r#"<p>The article:content_tier metadata convention is interesting.</p>
            <p>Some systems mark content as "locked" elsewhere on the page.</p>"#;
        assert!(detect_paywall_signal(html).is_none());
    }

    #[test]
    fn extract_text_prefers_article() {
        let html = r#"
            <html><body>
            <nav>Navigation stuff</nav>
            <article><p>This is the main article content that should be extracted because it is long enough to be considered real content.</p></article>
            <footer>Footer stuff</footer>
            </body></html>"#;
        let text = extract_text(html);
        assert!(text.contains("main article content"));
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
    fn is_private_ip_detects_rfc1918() {
        assert!(is_private_ip(&"10.0.0.1".parse().unwrap()));
        assert!(is_private_ip(&"192.168.1.1".parse().unwrap()));
        assert!(is_private_ip(&"172.16.0.1".parse().unwrap()));
        assert!(is_private_ip(&"127.0.0.1".parse().unwrap()));
        assert!(!is_private_ip(&"8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip(&"1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn cache_stores_and_retrieves() {
        let state = ProxyState::new();
        let results = vec![SearchResult {
            title: "Test".to_string(),
            url: "https://example.com".to_string(),
            snippet: "A test result".to_string(),
        }];

        state.cache_search("test query", &results);
        let cached = state.get_cached_search("test query");
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().len(), 1);

        // Miss for different query
        assert!(state.get_cached_search("other query").is_none());
    }

    #[test]
    fn fetch_cache_stores_and_retrieves() {
        let state = ProxyState::new();
        state.cache_fetch("https://example.com", "cached content");
        let cached = state.get_cached_fetch("https://example.com");
        assert!(cached.is_some());
        assert_eq!(cached.unwrap(), "cached content");
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
    fn engine_failure_tracking() {
        let state = ProxyState::new();
        assert!(state.is_engine_healthy("brave_html", ENGINE_COOLDOWN));
        state.record_failure("brave_html");
        assert!(!state.is_engine_healthy("brave_html", ENGINE_COOLDOWN));
        // Other engines unaffected
        assert!(state.is_engine_healthy("duckduckgo", ENGINE_COOLDOWN));
        assert!(state.is_engine_healthy("mojeek", ENGINE_COOLDOWN));
    }

    #[test]
    fn per_engine_rate_limit() {
        let state = ProxyState::new();
        // First call should not block
        state.rate_limit_engine("brave_html", RATE_LIMIT_INTERVAL);
        // Different engine should also not block
        state.rate_limit_engine("mojeek", RATE_LIMIT_INTERVAL);
        // Verify both tracked independently
        let times = state.last_search_time.lock().unwrap();
        assert!(times.contains_key("brave_html"));
        assert!(times.contains_key("mojeek"));
    }

    #[test]
    fn rotation_starts_at_first_engine() {
        let state = ProxyState::new();
        let order = state.rotation_order();
        assert_eq!(order, vec!["brave_html", "duckduckgo", "mojeek"]);
    }

    #[test]
    fn rotation_advances_after_success() {
        let state = ProxyState::new();
        // First search starts with brave_html
        assert_eq!(state.rotation_order()[0], "brave_html");

        // After advancing, the next one starts with duckduckgo
        state.advance_rotation_cursor();
        assert_eq!(
            state.rotation_order(),
            vec!["duckduckgo", "mojeek", "brave_html"]
        );

        // And then mojeek
        state.advance_rotation_cursor();
        assert_eq!(
            state.rotation_order(),
            vec!["mojeek", "brave_html", "duckduckgo"]
        );

        // And wraps back around to brave_html
        state.advance_rotation_cursor();
        assert_eq!(
            state.rotation_order(),
            vec!["brave_html", "duckduckgo", "mojeek"]
        );
    }

    #[test]
    fn rotation_full_cycle_uses_each_engine() {
        let state = ProxyState::new();
        // Track which engine appears first across N consecutive searches.
        // After AUTO_ENGINES.len() advances we should have seen each engine
        // in position 0 exactly once.
        let mut firsts = std::collections::HashSet::new();
        for _ in 0..AUTO_ENGINES.len() {
            firsts.insert(state.rotation_order()[0]);
            state.advance_rotation_cursor();
        }
        assert_eq!(firsts.len(), AUTO_ENGINES.len());
        for engine in AUTO_ENGINES {
            assert!(firsts.contains(*engine));
        }
    }

    #[test]
    fn rotation_includes_all_engines() {
        // Every rotation order returned should be a permutation of all engines.
        let state = ProxyState::new();
        for _ in 0..6 {
            let order = state.rotation_order();
            assert_eq!(order.len(), AUTO_ENGINES.len());
            let mut sorted = order.clone();
            sorted.sort();
            let mut expected: Vec<&str> = AUTO_ENGINES.to_vec();
            expected.sort();
            assert_eq!(sorted, expected);
            state.advance_rotation_cursor();
        }
    }
}
