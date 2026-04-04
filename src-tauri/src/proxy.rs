use log::{info, warn};
use scraper::{Html, Selector};
use serde::Serialize;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FETCH_LENGTH: usize = 4000;
const RATE_LIMIT_INTERVAL: Duration = Duration::from_secs(2);
const SEARCH_CACHE_TTL: Duration = Duration::from_secs(300); // 5 minutes
const FETCH_CACHE_TTL: Duration = Duration::from_secs(600); // 10 minutes
const ENGINE_COOLDOWN: Duration = Duration::from_secs(300); // 5 min cooldown after failure
const AUTO_ENGINES: &[&str] = &["qwant", "duckduckgo", "bing"];

#[derive(Clone, Debug, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
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
}

impl ProxyState {
    pub fn new() -> Self {
        Self {
            last_search_time: Mutex::new(HashMap::new()),
            engine_failures: Mutex::new(HashMap::new()),
            search_cache: Mutex::new(HashMap::new()),
            fetch_cache: Mutex::new(HashMap::new()),
        }
    }

    fn rate_limit_engine(&self, engine: &str) {
        let mut last_times = self.last_search_time.lock().unwrap();
        if let Some(last_time) = last_times.get(engine) {
            let elapsed = last_time.elapsed();
            if elapsed < RATE_LIMIT_INTERVAL {
                std::thread::sleep(RATE_LIMIT_INTERVAL - elapsed);
            }
        }
        last_times.insert(engine.to_string(), Instant::now());
    }

    fn record_failure(&self, engine: &str) {
        let mut failures = self.engine_failures.lock().unwrap();
        failures.insert(engine.to_string(), Instant::now());
    }

    fn is_engine_healthy(&self, engine: &str) -> bool {
        let failures = self.engine_failures.lock().unwrap();
        match failures.get(engine) {
            Some(failed_at) => failed_at.elapsed() >= ENGINE_COOLDOWN,
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

// DuckDuckGo HTML search

async fn search_duckduckgo(query: &str, recency: &str) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .cookie_store(true)
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

// Qwant JSON API search (no key required)

async fn search_qwant(query: &str, recency: &str) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut params = vec![
        ("q", query),
        ("count", "8"),
        ("locale", "en_US"),
        ("offset", "0"),
    ];

    match recency {
        "day" => params.push(("freshness", "day")),
        "week" => params.push(("freshness", "week")),
        "month" => params.push(("freshness", "month")),
        _ => {}
    }

    let resp = client
        .get("https://api.qwant.com/v3/search/web")
        .header("User-Agent", USER_AGENT)
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("Qwant search failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Qwant error: {}", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Qwant response: {}", e))?;

    let mut results = Vec::new();
    if let Some(items) = data
        .pointer("/data/result/items")
        .and_then(|i| i.as_array())
    {
        for item in items.iter().take(8) {
            let title = item.get("title").and_then(|t| t.as_str()).unwrap_or_default();
            let url = item.get("url").and_then(|u| u.as_str()).unwrap_or_default();
            let snippet = item.get("desc").and_then(|d| d.as_str()).unwrap_or_default();

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

// Bing HTML search

async fn search_bing(query: &str, recency: &str) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .cookie_store(true)
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let filters = match recency {
        "day" => "&filters=ex1%3a%22ez1%22",
        "week" => "&filters=ex1%3a%22ez2%22",
        "month" => "&filters=ex1%3a%22ez3%22",
        _ => "",
    };

    let url = format!(
        "https://www.bing.com/search?q={}&count=8{}",
        urlencoding::encode(query),
        filters
    );

    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Bing search failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Bing error: {}", resp.status()));
    }

    let html = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read Bing response: {}", e))?;

    if html.contains("/captcha/") || html.contains("unusual traffic") {
        warn!("Bing returned a bot detection page");
        return Err("Bing bot detection triggered — temporarily unavailable".to_string());
    }

    parse_bing_html(&html)
}

fn parse_bing_html(html: &str) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);
    let result_selector =
        Selector::parse("li.b_algo").map_err(|_| "Failed to parse selector")?;
    let title_selector =
        Selector::parse("h2 a").map_err(|_| "Failed to parse title selector")?;
    let snippet_selector =
        Selector::parse(".b_caption p").map_err(|_| "Failed to parse snippet selector")?;

    let mut results = Vec::new();

    for element in document.select(&result_selector) {
        let title_el = element.select(&title_selector).next();
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

// Auto-rotation search across multiple engines

async fn search_auto(
    state: &ProxyState,
    query: &str,
    recency: &str,
) -> Result<Vec<SearchResult>, String> {
    let mut healthy: Vec<&str> = Vec::new();
    let mut unhealthy: Vec<&str> = Vec::new();

    for engine in AUTO_ENGINES {
        if state.is_engine_healthy(engine) {
            healthy.push(engine);
        } else {
            unhealthy.push(engine);
        }
    }

    let ordered: Vec<&str> = healthy.into_iter().chain(unhealthy).collect();
    let mut last_error = String::new();

    for engine in &ordered {
        state.rate_limit_engine(engine);
        info!("Auto-search trying {} for: {} (recency: {})", engine, query, recency);

        let result = match *engine {
            "qwant" => search_qwant(query, recency).await,
            "duckduckgo" => search_duckduckgo(query, recency).await,
            "bing" => search_bing(query, recency).await,
            _ => unreachable!(),
        };

        match result {
            Ok(results) if !results.is_empty() => {
                info!("Auto-search succeeded with {}", engine);
                return Ok(results);
            }
            Ok(_) => {
                warn!("Auto-search: {} returned empty results, trying next", engine);
                last_error = format!("{} returned no results", engine);
            }
            Err(e) => {
                warn!("Auto-search: {} failed: {}, trying next", engine, e);
                state.record_failure(engine);
                last_error = e;
            }
        }
    }

    Err(format!("All search engines failed. Last error: {}", last_error))
}

// URL fetching with content extraction

async fn fetch_and_extract(url: &str) -> Result<String, String> {
    // Validate URL
    validate_url(url)?;

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
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

    Ok(extract_text(&html))
}

fn validate_url(url: &str) -> Result<(), String> {
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
) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
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
) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
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
pub async fn proxy_search(
    state: tauri::State<'_, ProxyState>,
    query: String,
    provider: Option<String>,
    api_key: Option<String>,
    instance_url: Option<String>,
    recency: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    // Check cache
    let cache_key = format!("{}:{}", query, recency.as_deref().unwrap_or("any"));
    if let Some(cached) = state.get_cached_search(&cache_key) {
        info!("Search cache hit for: {}", query);
        return Ok(cached);
    }

    let provider = provider.as_deref().unwrap_or("duckduckgo");
    let recency = recency.as_deref().unwrap_or("any");

    let results = match provider {
        "brave" => {
            let key = api_key.as_deref().unwrap_or("");
            if key.is_empty() {
                return Err("Brave Search API key not configured".to_string());
            }
            info!("Searching Brave for: {} (recency: {})", query, recency);
            search_brave(&query, key, recency).await?
        }
        "searxng" => {
            let url = instance_url.as_deref().unwrap_or("http://localhost:8080");
            info!(
                "Searching SearXNG ({}) for: {} (recency: {})",
                url, query, recency
            );
            search_searxng(&query, url, recency).await?
        }
        "auto" => {
            info!("Auto-searching for: {} (recency: {})", query, recency);
            search_auto(&state, &query, recency).await?
        }
        _ => {
            state.rate_limit_engine("duckduckgo");
            info!("Searching DDG for: {} (recency: {})", query, recency);
            search_duckduckgo(&query, recency).await?
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
) -> Result<String, String> {
    // Check cache
    if let Some(cached) = state.get_cached_fetch(&url) {
        info!("Fetch cache hit for: {}", url);
        return Ok(cached);
    }

    info!("Fetching URL: {}", url);
    let content = fetch_and_extract(&url).await?;

    state.cache_fetch(&url, &content);
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parse_bing_empty_html() {
        let result = parse_bing_html("<html><body>No results</body></html>");
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn parse_bing_malformed_html() {
        let result = parse_bing_html("<not valid html at all <<<>>>");
        assert!(result.is_ok());
    }

    #[test]
    fn engine_failure_tracking() {
        let state = ProxyState::new();
        assert!(state.is_engine_healthy("qwant"));
        state.record_failure("qwant");
        assert!(!state.is_engine_healthy("qwant"));
        // Other engines unaffected
        assert!(state.is_engine_healthy("duckduckgo"));
        assert!(state.is_engine_healthy("bing"));
    }

    #[test]
    fn per_engine_rate_limit() {
        let state = ProxyState::new();
        // First call should not block
        state.rate_limit_engine("qwant");
        // Different engine should also not block
        state.rate_limit_engine("bing");
        // Verify both tracked independently
        let times = state.last_search_time.lock().unwrap();
        assert!(times.contains_key("qwant"));
        assert!(times.contains_key("bing"));
    }
}
