//! Network egress for the agent: web search (multi-engine with rotation,
//! caching, and rate limiting), page fetching with text extraction, and
//! image search. Split by concern: `config` (tunables + `ProxyConfig`),
//! `state` (`ProxyState` caches/rate-limit/rotation), `search` (engine
//! backends), `extract`/`paywall`/`images` (page content), `bypass`
//! (user proxy), `stats` (session counters + the `StatSink` persistence
//! seam). This file holds the Tauri commands and orchestration only.

mod bypass;
mod config;
mod extract;
pub mod images;
mod paywall;
mod search;
mod state;
pub mod stats;

use log::{info, warn};
use serde::Serialize;
use std::future::Future;
use std::time::Instant;

pub(crate) use bypass::apply_proxy;
pub use config::ProxyConfig;
use config::RATE_LIMIT_INTERVAL;
use extract::fetch_and_extract;
pub(crate) use extract::{validate_url, validating_redirect_policy, USER_AGENT};
use search::{search_auto, search_brave, search_duckduckgo, search_searxng};
pub use state::ProxyState;
use stats::{
    record_engine_result, record_global_both, GlobalCounter, SearchFailure, SearchStats, StatSink,
    StatSinkHandle,
};

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Run one engine call with timing and per-engine stat recording — the
/// shared telemetry skeleton for every non-auto `proxy_search` arm.
async fn timed_search<F>(
    stats: &SearchStats,
    sink: &dyn StatSink,
    engine: &str,
    call: F,
) -> Result<Vec<SearchResult>, String>
where
    F: Future<Output = Result<Vec<SearchResult>, SearchFailure>>,
{
    let start = Instant::now();
    let result = call.await;
    let elapsed = start.elapsed().as_millis() as u64;
    record_engine_result(stats, sink, engine, &result, elapsed, None);
    result.map_err(Into::into)
}

// Tauri commands

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn proxy_search(
    state: tauri::State<'_, ProxyState>,
    stats: tauri::State<'_, SearchStats>,
    sink: tauri::State<'_, StatSinkHandle>,
    query: String,
    provider: Option<String>,
    api_key: Option<String>,
    instance_url: Option<String>,
    recency: Option<String>,
    deep_research: Option<bool>,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<SearchResult>, String> {
    let sink: &dyn StatSink = sink.0.as_ref();
    record_global_both(&stats, sink, GlobalCounter::Query);

    // Check cache
    let cache_key = format!("{}:{}", query, recency.as_deref().unwrap_or("any"));
    if let Some(cached) = state.get_cached_search(&cache_key) {
        info!("Search cache hit for: {}", query);
        record_global_both(&stats, sink, GlobalCounter::CacheHit);
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
            timed_search(
                &stats,
                sink,
                "brave",
                search_brave(&query, key, recency, proxy_ref),
            )
            .await?
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
            timed_search(
                &stats,
                sink,
                "searxng",
                search_searxng(&query, url, recency, proxy_ref),
            )
            .await?
        }
        "auto" => {
            info!(
                "Auto-searching for: {} (recency: {}, deep_research: {})",
                query, recency, deep_research
            );
            search_auto(
                &state,
                &stats,
                sink,
                &query,
                recency,
                deep_research,
                proxy_ref,
            )
            .await?
        }
        _ => {
            state
                .rate_limit_engine("duckduckgo", RATE_LIMIT_INTERVAL)
                .await;
            info!("Searching DDG for: {} (recency: {})", query, recency);
            timed_search(
                &stats,
                sink,
                "duckduckgo",
                search_duckduckgo(&query, recency, proxy_ref),
            )
            .await?
        }
    };

    if results.is_empty() {
        warn!("No search results for: {}", query);
    }

    state.cache_search(&cache_key, &results);
    Ok(results)
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CombinedSearchStats {
    pub session: stats::SessionStatsSnapshot,
    pub lifetime: stats::LifetimeStatsSnapshot,
}

#[tauri::command]
pub fn get_search_stats(
    stats: tauri::State<'_, SearchStats>,
    sink: tauri::State<'_, StatSinkHandle>,
) -> Result<CombinedSearchStats, String> {
    let session = stats.snapshot();
    let lifetime = sink.0.lifetime_snapshot()?;
    Ok(CombinedSearchStats { session, lifetime })
}

#[tauri::command]
pub fn reset_lifetime_search_stats(sink: tauri::State<'_, StatSinkHandle>) -> Result<(), String> {
    sink.0.reset_lifetime()
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
