mod bypass;
mod extract;
pub mod images;
mod paywall;
mod search;
pub mod stats;

use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) use bypass::apply_proxy;
use extract::fetch_and_extract;
pub(crate) use extract::{validate_url, USER_AGENT};
use search::{search_auto, search_brave, search_duckduckgo, search_searxng};
use stats::{AutoPosition, RecordedOutcome, SearchFailure, SearchFailureKind, SearchStats};

use crate::db::{Database, EngineStatDelta};

const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const MAX_FETCH_LENGTH: usize = 4000;
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

/// Which global counter to bump in `record_global_both`.
#[derive(Clone, Copy)]
pub(super) enum GlobalCounter {
    Query,
    CacheHit,
    AllEnginesFailed,
}

impl GlobalCounter {
    fn db_key(self) -> &'static str {
        match self {
            GlobalCounter::Query => "total_queries",
            GlobalCounter::CacheHit => "cache_hits",
            GlobalCounter::AllEnginesFailed => "all_engines_failed",
        }
    }
}

/// Update both the in-memory session counters and the lifetime SQLite row
/// for a single engine attempt. Persistence failures are logged but don't
/// propagate — a transient DB error shouldn't break the search itself.
pub(super) fn record_outcome_both(
    stats: &SearchStats,
    db: &Database,
    engine: &str,
    outcome: &RecordedOutcome,
) {
    stats.record_outcome(engine, outcome);

    let now = stats::now_ms();
    let (success, latency_ms, failure_column) = match &outcome.result {
        Ok(ms) => (true, *ms, None),
        Err(kind) => (false, 0, Some(kind.db_column())),
    };
    let delta = EngineStatDelta {
        attempt: true,
        success,
        latency_ms,
        failure_column,
        now_ms: now,
        first_choice: matches!(outcome.position, Some(AutoPosition::First)),
        fallback: matches!(outcome.position, Some(AutoPosition::Fallback)),
        fallback_success: success && matches!(outcome.position, Some(AutoPosition::Fallback)),
    };
    if let Err(e) = db.update_engine_stat(engine, &delta) {
        warn!("Failed to persist lifetime stats for {}: {}", engine, e);
    }
}

/// Classify a single engine call's `Result` (success / empty / typed
/// failure) into a `RecordedOutcome` and persist it through both stores.
/// Empty results (Ok with no items) are recorded as a `Empty` failure
/// for stats purposes even though the engine technically succeeded.
pub(super) fn record_engine_result(
    stats: &SearchStats,
    db: &Database,
    engine: &str,
    result: &Result<Vec<SearchResult>, SearchFailure>,
    elapsed_ms: u64,
    position: Option<AutoPosition>,
) {
    let outcome = match result {
        Ok(r) if r.is_empty() => RecordedOutcome {
            result: Err(SearchFailureKind::Empty),
            position,
        },
        Ok(_) => RecordedOutcome {
            result: Ok(elapsed_ms),
            position,
        },
        Err(f) => RecordedOutcome {
            result: Err(f.kind),
            position,
        },
    };
    record_outcome_both(stats, db, engine, &outcome);
}

pub(super) fn record_global_both(stats: &SearchStats, db: &Database, counter: GlobalCounter) {
    match counter {
        GlobalCounter::Query => stats.record_query(),
        GlobalCounter::CacheHit => stats.record_cache_hit(),
        GlobalCounter::AllEnginesFailed => stats.record_all_engines_failed(),
    }
    let key = counter.db_key();
    if let Err(e) = db.increment_global(key) {
        warn!("Failed to persist global stat {}: {}", key, e);
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

// Tauri commands

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn proxy_search(
    state: tauri::State<'_, ProxyState>,
    stats: tauri::State<'_, SearchStats>,
    db: tauri::State<'_, Database>,
    query: String,
    provider: Option<String>,
    api_key: Option<String>,
    instance_url: Option<String>,
    recency: Option<String>,
    deep_research: Option<bool>,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<SearchResult>, String> {
    record_global_both(&stats, &db, GlobalCounter::Query);

    // Check cache
    let cache_key = format!("{}:{}", query, recency.as_deref().unwrap_or("any"));
    if let Some(cached) = state.get_cached_search(&cache_key) {
        info!("Search cache hit for: {}", query);
        record_global_both(&stats, &db, GlobalCounter::CacheHit);
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
            let start = Instant::now();
            let r = search_brave(&query, key, recency, proxy_ref).await;
            let elapsed = start.elapsed().as_millis() as u64;
            record_engine_result(&stats, &db, "brave", &r, elapsed, None);
            r?
        }
        "searxng" => {
            // The TS caller always resolves this to `DEFAULT_SEARXNG_URL`, so a
            // missing/empty value is a misconfiguration rather than a default to
            // paper over here (audit X5; mirrors the Brave key check above).
            let url = instance_url.as_deref().unwrap_or("");
            if url.is_empty() {
                return Err("SearXNG instance URL not configured".to_string());
            }
            info!(
                "Searching SearXNG ({}) for: {} (recency: {})",
                url, query, recency
            );
            let start = Instant::now();
            let r = search_searxng(&query, url, recency, proxy_ref).await;
            let elapsed = start.elapsed().as_millis() as u64;
            record_engine_result(&stats, &db, "searxng", &r, elapsed, None);
            r?
        }
        "auto" => {
            info!(
                "Auto-searching for: {} (recency: {}, deep_research: {})",
                query, recency, deep_research
            );
            search_auto(
                &state,
                &stats,
                &db,
                &query,
                recency,
                deep_research,
                proxy_ref,
            )
            .await?
        }
        _ => {
            state.rate_limit_engine("duckduckgo", RATE_LIMIT_INTERVAL);
            info!("Searching DDG for: {} (recency: {})", query, recency);
            let start = Instant::now();
            let r = search_duckduckgo(&query, recency, proxy_ref).await;
            let elapsed = start.elapsed().as_millis() as u64;
            record_engine_result(&stats, &db, "duckduckgo", &r, elapsed, None);
            r?
        }
    };

    if results.is_empty() {
        warn!("No search results for: {}", query);
    }

    state.cache_search(&cache_key, &results);
    Ok(results)
}

#[derive(Serialize)]
pub struct CombinedSearchStats {
    pub session: stats::SessionStatsSnapshot,
    pub lifetime: crate::db::LifetimeStatsSnapshot,
}

#[tauri::command]
pub fn get_search_stats(
    stats: tauri::State<'_, SearchStats>,
    db: tauri::State<'_, Database>,
) -> Result<CombinedSearchStats, String> {
    let session = stats.snapshot();
    let lifetime = db.lifetime_stats_snapshot()?;
    Ok(CombinedSearchStats { session, lifetime })
}

#[tauri::command]
pub fn reset_lifetime_search_stats(db: tauri::State<'_, Database>) -> Result<(), String> {
    db.reset_lifetime_stats()
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

#[cfg(test)]
mod tests {
    use super::bypass::{parse_bypass_list, should_bypass, BypassEntry};
    use super::extract::{extract_text, is_private_ip};
    use super::images::{extract_page_images, parse_commons_imageinfo};
    use super::paywall::detect_paywall_signal;
    use super::search::{parse_brave_html, parse_ddg_html};
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
    fn extract_text_truncates_multibyte_content_on_char_boundary() {
        // 3-byte chars with no whitespace guarantee a char straddles the
        // MAX_FETCH_LENGTH byte index (4000 is not a multiple of 3), which
        // panicked before truncation backed off to a char boundary.
        let long_text = "—".repeat(3000);
        let html = format!(
            "<html><body><article><p>{}</p></article></body></html>",
            long_text
        );
        let text = extract_text(&html);
        assert!(text.len() <= MAX_FETCH_LENGTH + 3); // +3 for "..."
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
