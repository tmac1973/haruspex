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

// Note: Qwant, Startpage and Mojeek were previously in this list but have been
// removed — each gained a JS-execution bot wall that plain HTTP scraping cannot
// pass. Bing was removed in April 2026 for the same reason and has since come
// back: re-verified on 2026-08-17 across five varied queries, every one
// server-rendering ten `li.b_algo` results in a 123-127 KB page, with no
// Turnstile shell in sight. Walls come down as well as up, so the others are
// worth re-testing occasionally rather than assumed dead forever.
// As of April 2026:
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
// Qwant re-checked on 2026-08-17: still an SPA shell with no server-rendered
// results (its markers appear only inside scripts), so it stays out.
// See git history for the previous search_qwant / search_startpage /
// search_mojeek implementations.
// Bing was pulled again on 2026-09-19, and for a new reason: it no longer
// blocks, it lies. It answers a scrape with HTTP 200 and a full, well-formed
// SERP whose results are for a different query — the submitted query survives
// verbatim in the page's own search box, but the organic results are for its
// first term alone (`Dave Smith comedian libertarian podcast` -> ten results
// about the Dave banking app, four runs of four), or, through an HTTP proxy,
// for nothing at all (a different unrelated SERP per request). No header,
// cookie warm-up or UA made any difference.
//
// That is invisible to every check upstream of `relevance`: the page is
// 120-180 KB, the parser finds eight results, and the rotation takes the first
// engine that returns any. Bing reached 590 attempts and 590 successes with
// `last_failure_at` still NULL — the only engine that had never failed, for
// the only reason that matters, which is that it could not. Whichever search
// it won came back as confident nonsense.
//
// `relevance::answers_query` now catches this class for every engine, so Bing
// could come back the moment it serves real results again. It stays out until
// then because a decoy costs a whole search: it wins the rotation before a
// working engine is ever asked.
pub(super) const AUTO_ENGINES: &[&str] = &["yahoo", "brave_html", "duckduckgo"];

/// User-configured HTTP proxy. Mirrors the `ProxyConfig` TS type and is
/// passed in as an optional argument on every egress command. `mode` is
/// either "none" or "manual" — any other value is treated as none so a
/// typo can't accidentally force traffic through an invalid URL. Bypass
/// entries are parsed per request; we don't cache them because the user
/// can edit them between calls and there's no hot path here.
#[derive(Clone, Default, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    #[serde(default)]
    #[ts(type = "\"none\" | \"manual\"")]
    pub mode: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub bypass: String,
    /// Where the proxy's password is kept (`"proxy:network"`,
    /// `"proxy:search"`), with `url` holding everything but the password.
    /// `None` for a proxy with no password, or one kept inline where no
    /// secret store works.
    #[serde(default)]
    #[ts(optional)]
    pub password_ref: Option<String>,
}

impl ProxyConfig {
    /// The URL to connect through, with the stored password put back in.
    /// Read through the secret cache, so only the first request after a
    /// change waits on the keychain.
    pub fn effective_url(&self) -> Result<String, String> {
        let url = self.url.trim();
        let Some(key) = self.password_ref.as_deref() else {
            return Ok(url.to_string());
        };
        let password = crate::secrets::get_blocking(key)?.ok_or_else(|| {
            "The proxy password is missing from Haruspex's secret store — enter it again in \
             Settings → Network."
                .to_string()
        })?;
        let mut parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid proxy URL: {e}"))?;
        parsed
            .set_password(Some(&password))
            .map_err(|_| "This proxy URL cannot carry a password".to_string())?;
        Ok(parsed.to_string())
    }
}

/// By hand: a proxy URL can carry `user:pass@`, so `{:?}` shows only its
/// scheme and host.
impl std::fmt::Debug for ProxyConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Self {
            mode,
            url,
            bypass,
            password_ref,
        } = self;
        let url = if url.is_empty() {
            String::new()
        } else {
            crate::text_util::url_for_log(url)
        };
        f.debug_struct("ProxyConfig")
            .field("mode", mode)
            .field("url", &url)
            .field("bypass", bypass)
            .field("password_ref", password_ref)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(url: &str, password_ref: Option<&str>) -> ProxyConfig {
        ProxyConfig {
            mode: "manual".into(),
            url: url.into(),
            bypass: String::new(),
            password_ref: password_ref.map(Into::into),
        }
    }

    #[test]
    fn the_stored_password_goes_back_into_the_url() {
        crate::secrets::seed_for_test("proxy:test-roundtrip", "p@ss:word");
        let url = cfg(
            "http://alice@proxy.example:3128",
            Some("proxy:test-roundtrip"),
        )
        .effective_url()
        .unwrap();
        let parsed = reqwest::Url::parse(&url).unwrap();
        assert_eq!(parsed.username(), "alice");
        // Percent-encoded in the URL, so the proxy sees exactly the password.
        assert_eq!(
            urlencoding::decode(parsed.password().unwrap()).unwrap(),
            "p@ss:word"
        );
        assert_eq!(parsed.host_str(), Some("proxy.example"));
    }

    #[test]
    fn a_url_without_a_reference_is_used_as_it_is() {
        assert_eq!(
            cfg(" http://proxy.example:3128 ", None)
                .effective_url()
                .unwrap(),
            "http://proxy.example:3128"
        );
    }

    #[test]
    fn debug_shows_the_reference_not_the_password() {
        let shown = format!(
            "{:?}",
            cfg("http://a:secret@proxy.example", Some("proxy:network"))
        );
        assert!(!shown.contains("secret"), "{shown}");
        assert!(shown.contains("proxy:network"), "{shown}");
    }
}
