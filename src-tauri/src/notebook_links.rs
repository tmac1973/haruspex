//! The notebooks' dead-link check: each http(s) link in a notebook is asked
//! for (HEAD, then GET when a server won't answer HEAD), through the app's
//! proxy and its rules. A link is **broken** when the page is gone (404,
//! 410, a server error) or the name or connection fails; **skipped** when it
//! points at this computer or the local network (web fetches may not reach
//! those) or the server didn't answer in time or asked us to slow down.
//! Results are kept per notebook in `notebook_link_status`.

use crate::db::Database;
use crate::proxy::{build_fetch_client, validate_url, with_cause, ProxyConfig};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use std::time::Duration;

const PARALLEL: usize = 6;
const TIMEOUT: Duration = Duration::from_secs(10);
/// Links checked in one go, at most.
const MAX_LINKS: usize = 500;

/// What asking for a link came to.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Status(u16),
    Timeout,
    /// Refused before asking: this computer or the local network.
    Local,
    /// The name didn't resolve, the connection was refused, TLS failed…
    Network(String),
}

/// A link's verdict: `ok`, `broken` or `skipped`, and why.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct LinkStatus {
    pub url: String,
    pub state: String,
    pub status: String,
}

/// Turn an outcome into a verdict.
pub fn classify(outcome: &Outcome) -> (&'static str, String) {
    match outcome {
        Outcome::Status(s) if (200..400).contains(s) => ("ok", format!("{s}")),
        Outcome::Status(429) => ("skipped", "Didn't answer (too many requests)".into()),
        Outcome::Status(s @ (404 | 410)) => ("broken", format!("Page not found ({s})")),
        Outcome::Status(s) if *s >= 500 => ("broken", format!("Server error ({s})")),
        // 401/403 and the like: the page is there, just not for us.
        Outcome::Status(s) => ("ok", format!("{s}")),
        Outcome::Timeout => ("skipped", "Didn't answer in time".into()),
        Outcome::Local => ("skipped", "Not checked (local address)".into()),
        Outcome::Network(why) => ("broken", why.clone()),
    }
}

/// Whether a HEAD answer is worth a GET: servers that refuse HEAD, and
/// connections that failed (some servers drop HEAD outright).
pub fn needs_get_fallback(head: &Outcome) -> bool {
    matches!(head, Outcome::Status(403 | 405 | 501) | Outcome::Network(_))
}

fn outcome_of(result: Result<reqwest::Response, reqwest::Error>) -> Outcome {
    match result {
        Ok(r) => Outcome::Status(r.status().as_u16()),
        Err(e) if e.is_timeout() => Outcome::Timeout,
        Err(e) => {
            let why = with_cause(&e);
            if why.contains("local network") || why.contains("this computer") {
                Outcome::Local
            } else {
                Outcome::Network(plain_reason(&why))
            }
        }
    }
}

/// A network error in a few plain words, for the link's tooltip.
pub fn plain_reason(why: &str) -> String {
    let w = why.to_ascii_lowercase();
    let says = |any: &[&str]| any.iter().any(|s| w.contains(s));
    if says(&[
        "lookup address",
        "name or service not known",
        "no such host",
        "dns",
    ]) {
        "Site not found".into()
    } else if says(&["connection refused"]) {
        "Connection refused".into()
    } else if says(&["certificate", "tls", "ssl"]) {
        "Certificate problem".into()
    } else if says(&["reset", "closed", "broken pipe"]) {
        "Connection dropped".into()
    } else {
        "Couldn't connect".into()
    }
}

async fn check_one(client: &reqwest::Client, url: &str) -> Outcome {
    if validate_url(url).is_err() {
        return Outcome::Local;
    }
    let head = outcome_of(client.head(url).timeout(TIMEOUT).send().await);
    if !needs_get_fallback(&head) {
        return head;
    }
    // GET, reading only the start of the body: a dead link needs no more.
    match client.get(url).timeout(TIMEOUT).send().await {
        Ok(r) => {
            let status = r.status().as_u16();
            let _ = crate::http_util::read_capped(r, 64 * 1024).await;
            Outcome::Status(status)
        }
        Err(e) => outcome_of(Err(e)),
    }
}

/// Check `urls` (a notebook's links), keep the verdicts, and return them.
#[tauri::command]
pub async fn notebook_links_check(
    state: tauri::State<'_, Database>,
    notebook_id: String,
    urls: Vec<String>,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<LinkStatus>, String> {
    let client = build_fetch_client(proxy.as_ref())?;
    let mut list = urls;
    list.sort();
    list.dedup();
    list.truncate(MAX_LINKS);
    let results: Vec<LinkStatus> = stream::iter(list)
        .map(|url| {
            let client = client.clone();
            async move {
                let outcome = check_one(&client, &url).await;
                let (state, status) = classify(&outcome);
                LinkStatus {
                    url,
                    state: state.to_string(),
                    status,
                }
            }
        })
        .buffer_unordered(PARALLEL)
        .collect()
        .await;
    let db = state.inner().clone();
    let keep = results.clone();
    tauri::async_runtime::spawn_blocking(move || db.notebook_link_status_save(&notebook_id, &keep))
        .await
        .map_err(|e| format!("link task panicked: {e}"))??;
    Ok(results)
}

/// The last verdicts for a notebook's links.
#[tauri::command]
pub async fn notebook_link_status_get(
    state: tauri::State<'_, Database>,
    notebook_id: String,
) -> Result<Vec<LinkStatus>, String> {
    let db = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.notebook_link_status_get(&notebook_id))
        .await
        .map_err(|e| format!("link task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdicts() {
        let v = |o: Outcome| classify(&o).0;
        assert_eq!(v(Outcome::Status(200)), "ok");
        assert_eq!(v(Outcome::Status(301)), "ok");
        assert_eq!(v(Outcome::Status(403)), "ok");
        assert_eq!(v(Outcome::Status(404)), "broken");
        assert_eq!(v(Outcome::Status(410)), "broken");
        assert_eq!(v(Outcome::Status(500)), "broken");
        assert_eq!(v(Outcome::Status(429)), "skipped");
        assert_eq!(v(Outcome::Timeout), "skipped");
        assert_eq!(v(Outcome::Local), "skipped");
        assert_eq!(v(Outcome::Network("dns error".into())), "broken");
    }

    #[test]
    fn plain_reasons() {
        assert_eq!(
            plain_reason("error sending request: failed to lookup address information: Name or service not known"),
            "Site not found"
        );
        assert_eq!(
            plain_reason("tcp connect error: Connection refused (os error 111)"),
            "Connection refused"
        );
        assert_eq!(
            plain_reason("invalid peer certificate: Expired"),
            "Certificate problem"
        );
        assert_eq!(plain_reason("something odd"), "Couldn't connect");
    }

    #[test]
    fn get_after_head_only_when_it_might_help() {
        for s in [403, 405, 501] {
            assert!(needs_get_fallback(&Outcome::Status(s)));
        }
        assert!(needs_get_fallback(&Outcome::Network("reset".into())));
        assert!(!needs_get_fallback(&Outcome::Status(200)));
        assert!(!needs_get_fallback(&Outcome::Status(404)));
        assert!(!needs_get_fallback(&Outcome::Timeout));
        assert!(!needs_get_fallback(&Outcome::Local));
    }
}
