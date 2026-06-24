//! Tunable constants for the proxy subsystem (timeouts, cache TTLs,
//! rate-limit pacing, engine cooldowns, the auto-rotation engine list)
//! plus the user-facing `ProxyConfig` type passed in on every egress
//! command.

use serde::Deserialize;
use std::time::Duration;

pub(super) const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const RATE_LIMIT_INTERVAL: Duration = Duration::from_secs(2);
pub(super) const SEARCH_CACHE_TTL: Duration = Duration::from_secs(300); // 5 minutes
pub(super) const FETCH_CACHE_TTL: Duration = Duration::from_secs(600); // 10 minutes
pub(super) const ENGINE_COOLDOWN: Duration = Duration::from_secs(90); // cooldown after a failure (e.g. a 429)

// Slow-mode pacing — used by deep research with auto rotation when no
// reliable provider (Brave / SearXNG) is configured. Slower per-engine
// pacing reduces bot-detection trips, and shorter cooldowns let engines
// recover within the same research turn instead of taking the whole turn
// out of commission.
pub(super) const RATE_LIMIT_INTERVAL_SLOW: Duration = Duration::from_secs(6);
pub(super) const ENGINE_COOLDOWN_SLOW: Duration = Duration::from_secs(45);

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
pub(super) const AUTO_ENGINES: &[&str] = &["brave_html", "duckduckgo", "mojeek"];

/// User-configured HTTP proxy. Mirrors the `ProxyConfig` TS type and is
/// passed in as an optional argument on every egress command. `mode` is
/// either "none" or "manual" — any other value is treated as none so a
/// typo can't accidentally force traffic through an invalid URL. Bypass
/// entries are parsed per request; we don't cache them because the user
/// can edit them between calls and there's no hot path here.
#[derive(Clone, Debug, Default, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct ProxyConfig {
    #[serde(default)]
    #[ts(type = "\"none\" | \"manual\"")]
    pub mode: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub bypass: String,
}
