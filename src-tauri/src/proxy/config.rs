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

// Note: Bing, Qwant, Startpage and Mojeek were previously in this list but
// have been removed — each gained a JS-execution bot wall that plain HTTP
// scraping cannot pass.
// As of April 2026:
//   - Bing serves a JavaScript shell + Cloudflare Turnstile bot challenge
//     for all `/search?q=...` requests; no result HTML exists in the
//     initial response.
//   - api.qwant.com is gated by DataDome (commercial JS-execution bot
//     detection), and the www.qwant.com HTML page is a Next.js SPA shell
//     with empty preloaded data — results are fetched client-side.
// As of August 2026, verified by replaying the exact request this code sent:
//   - Startpage answers `/sp/search` with HTTP 200 and an Anubis
//     proof-of-work interstitial ("Verifying your request…"). Last real
//     result on the dev instance: 2026-07-16, after which 62 of 88 attempts
//     were the challenge.
//   - Mojeek answers with HTTP 200 and a captcha page reading "JavaScript is
//     required to complete this challenge". Last real result: 2026-06-23,
//     after which 115 of 187 attempts parsed to zero results. A *newer*
//     Chrome UA makes it worse (hard 403), and the `Accept` header makes no
//     difference, so there is no header combination that gets through.
// None have a plain-HTTP scraping path; resurrecting any would require
// a headless browser (Playwright/Puppeteer) or a paid API — Mojeek sells a
// keyed Web Search API, which would fit the shape of the existing Brave
// provider if it is ever worth the key.
// See git history for the previous search_bing / search_qwant /
// search_startpage / search_mojeek implementations.
pub(super) const AUTO_ENGINES: &[&str] = &["yahoo", "brave_html", "duckduckgo"];

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
