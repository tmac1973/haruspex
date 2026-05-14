//! Search backends — one async fn + HTML parser per engine. The trait
//! abstraction proposed in design-patterns audit P-1 is deferred; for
//! now the dispatcher in `mod.rs::proxy_search` matches on a provider
//! string and calls the appropriate backend.

use super::bypass::apply_proxy;
use super::extract::{diagnostic_snippet, USER_AGENT};
use super::{
    ProxyConfig, ProxyState, SearchResult, ENGINE_COOLDOWN, ENGINE_COOLDOWN_SLOW,
    FETCH_TIMEOUT, RATE_LIMIT_INTERVAL, RATE_LIMIT_INTERVAL_SLOW,
};
use log::{info, warn};
use scraper::{Html, Selector};

pub(super) async fn search_duckduckgo(
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

pub(super) async fn search_mojeek(
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

pub(super) async fn search_brave_html(
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

pub(super) async fn search_auto(
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

/// Inspect the raw HTML of a fetched page for standardized paywall
/// declarations. Host-agnostic: we never match a specific publisher.
// Brave Search API
pub(super) async fn search_brave(
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

pub(super) async fn search_searxng(
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
