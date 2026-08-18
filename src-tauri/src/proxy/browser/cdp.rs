//! A minimal Chrome DevTools Protocol client — just enough to open a tab and
//! read its settled DOM.
//!
//! No CDP crate: the whole surface is `Target.createTarget`,
//! `Target.closeTarget`, `Page.enable` and `Runtime.evaluate` over one
//! WebSocket, and a dependency that tracks the entire protocol would be far
//! more than this needs.

use futures_util::{SinkExt, StreamExt};
use log::debug;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// How often to ask the page whether it has what we need. A proof-of-work
/// interstitial clears in ~2s and an ordinary render in well under one, so
/// this is fast enough to not add noticeable latency and slow enough not to
/// spin.
const POLL_INTERVAL: Duration = Duration::from_millis(300);

/// Ceiling on a single CDP request. A hung browser must surface as an error
/// the caller can fall back from, not as a stuck search.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

pub(super) struct CdpConnection {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    next_id: u64,
}

impl CdpConnection {
    /// Connect to a DevTools WebSocket URL.
    ///
    /// The `Origin` header is deliberately absent: Chrome rejects handshakes
    /// carrying one unless it was launched with `--remote-allow-origins`, and
    /// `tungstenite` does not add it for a plain URL request.
    pub(super) async fn connect(ws_url: &str) -> Result<Self, String> {
        let request = ws_url
            .into_client_request()
            .map_err(|e| format!("bad DevTools URL {ws_url}: {e}"))?;
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| format!("CDP connect failed: {e}"))?;
        Ok(Self { socket, next_id: 0 })
    }

    /// Issue one command and wait for the matching reply.
    ///
    /// Replies are matched by id and everything else is discarded: CDP
    /// interleaves unsolicited events (`Page.*`, `Network.*`) with replies, and
    /// reading the next frame blindly would return an event as if it were the
    /// answer.
    pub(super) async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let payload = json!({ "id": id, "method": method, "params": params });
        self.socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .map_err(|e| format!("CDP send failed: {e}"))?;

        let deadline = Instant::now() + REQUEST_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("CDP call {method} timed out"));
            }
            let frame = tokio::time::timeout(remaining, self.socket.next())
                .await
                .map_err(|_| format!("CDP call {method} timed out"))?
                .ok_or_else(|| "CDP connection closed".to_string())?
                .map_err(|e| format!("CDP receive failed: {e}"))?;

            let Message::Text(text) = frame else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue; // an event, or a reply to something else
            }
            if let Some(error) = value.get("error") {
                return Err(format!("CDP {method} error: {error}"));
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// Evaluate an expression and return it as a string, or `None` when the
    /// page has no value to give.
    ///
    /// `None` is a real state, not a failure: immediately after a navigation
    /// `document.documentElement` is briefly null and `Runtime.evaluate`
    /// returns a result with no `value` field at all. Unwrapping that is a
    /// panic on a race that happens on every single page load.
    async fn eval_string(&mut self, expression: &str) -> Result<Option<String>, String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await?;
        Ok(result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(Value::as_str)
            .map(str::to_string))
    }
}

/// The DOM of a page, once it holds what the caller was waiting for.
///
/// `ready` decides when to stop: for search it is "the parser found results",
/// which is what makes a proof-of-work interstitial work without special
/// handling — the page simply isn't ready until it renders results, so a ~2s
/// Anubis solve is just a slow load.
///
/// On timeout the last DOM seen is returned rather than an error, so the
/// caller can inspect it — a challenge page it can recognize is far more
/// useful than "timed out".
pub(super) struct RenderOutcome {
    pub(super) html: String,
    pub(super) ready: bool,
}

/// Open `url` in a fresh tab, wait for `ready`, and return the DOM.
///
/// The tab is always closed, including on error: tabs are ~100 MB each and a
/// search burst opens one per engine per query.
pub(super) async fn render(
    port: u16,
    url: &str,
    ready: &(dyn Fn(&str) -> bool + Sync),
    timeout: Duration,
) -> Result<RenderOutcome, String> {
    let version: Value = reqwest::get(format!("http://127.0.0.1:{port}/json/version"))
        .await
        .map_err(|e| format!("browser not answering: {e}"))?
        .json()
        .await
        .map_err(|e| format!("browser sent no version info: {e}"))?;
    let browser_ws = version
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .ok_or("browser reported no debugger URL")?;

    let mut browser = CdpConnection::connect(browser_ws).await?;
    // Target.createTarget rather than the /json/new endpoint: that endpoint
    // requires a PUT as of Chrome 151 and answers 405 to anything else.
    let target = browser
        .call("Target.createTarget", json!({ "url": url }))
        .await?;
    let target_id = target
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or("browser opened no tab")?
        .to_string();

    let outcome = render_in_target(port, &target_id, ready, timeout).await;
    // Close the tab whatever happened.
    let _ = browser
        .call("Target.closeTarget", json!({ "targetId": target_id }))
        .await;
    outcome
}

async fn render_in_target(
    port: u16,
    target_id: &str,
    ready: &(dyn Fn(&str) -> bool + Sync),
    timeout: Duration,
) -> Result<RenderOutcome, String> {
    let deadline = Instant::now() + timeout;
    let ws_url = page_socket_url(port, target_id, deadline).await?;
    let mut page = CdpConnection::connect(&ws_url).await?;
    page.call("Page.enable", json!({})).await?;

    let mut last_html = String::new();
    loop {
        // Guarded: documentElement is null for a moment after navigation.
        let html = page
            .eval_string("document.documentElement ? document.documentElement.outerHTML : ''")
            .await?
            .unwrap_or_default();
        if !html.is_empty() {
            last_html = html;
            if ready(&last_html) {
                return Ok(RenderOutcome {
                    html: last_html,
                    ready: true,
                });
            }
        }
        if Instant::now() >= deadline {
            debug!(
                "browser search: render deadline hit with {} bytes of DOM",
                last_html.len()
            );
            return Ok(RenderOutcome {
                html: last_html,
                ready: false,
            });
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Find the WebSocket URL for our tab.
///
/// Selecting by id and requiring `type == "page"` matters: extension
/// background pages are listed *first*, and attaching to one returns a 77-byte
/// DOM — indistinguishable from a site that served nothing, and a genuinely
/// confusing hour when it happens.
async fn page_socket_url(port: u16, target_id: &str, deadline: Instant) -> Result<String, String> {
    loop {
        let targets: Vec<Value> = reqwest::get(format!("http://127.0.0.1:{port}/json"))
            .await
            .map_err(|e| format!("browser not answering: {e}"))?
            .json()
            .await
            .map_err(|e| format!("browser sent no target list: {e}"))?;

        if let Some(url) = targets
            .iter()
            .find(|t| {
                t.get("id").and_then(Value::as_str) == Some(target_id)
                    && t.get("type").and_then(Value::as_str) == Some("page")
            })
            .and_then(|t| t.get("webSocketDebuggerUrl"))
            .and_then(Value::as_str)
        {
            return Ok(url.to_string());
        }
        if Instant::now() >= deadline {
            return Err("browser never listed the new tab".to_string());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `Runtime.evaluate` returns for a page whose documentElement
    /// is still null — no `value` key at all. Reading it as a string must
    /// yield None rather than panicking, because this happens on every load.
    #[test]
    fn evaluate_result_without_a_value_is_not_a_panic() {
        let reply: Value =
            serde_json::from_str(r#"{"id":3,"result":{"result":{"type":"undefined"}}}"#).unwrap();
        let extracted = reply
            .get("result")
            .and_then(|r| r.get("result"))
            .and_then(|r| r.get("value"))
            .and_then(Value::as_str);
        assert!(extracted.is_none());
    }

    #[test]
    fn evaluate_result_with_a_value_reads_back() {
        let reply: Value = serde_json::from_str(
            r#"{"id":3,"result":{"result":{"type":"string","value":"<html></html>"}}}"#,
        )
        .unwrap();
        let extracted = reply
            .get("result")
            .and_then(|r| r.get("result"))
            .and_then(|r| r.get("value"))
            .and_then(Value::as_str);
        assert_eq!(extracted, Some("<html></html>"));
    }

    /// Extension background pages come first in /json. Picking the first entry
    /// attaches to one and reads a 77-byte DOM that looks exactly like a site
    /// returning nothing.
    #[test]
    fn target_selection_requires_a_page_and_the_right_id() {
        let targets: Vec<Value> = serde_json::from_str(
            r#"[
              {"id":"ext1","type":"background_page","webSocketDebuggerUrl":"ws://x/ext"},
              {"id":"tab1","type":"page","webSocketDebuggerUrl":"ws://x/tab1"},
              {"id":"tab2","type":"page","webSocketDebuggerUrl":"ws://x/tab2"}
            ]"#,
        )
        .unwrap();
        let pick = |want: &str| -> Option<String> {
            targets
                .iter()
                .find(|t| {
                    t.get("id").and_then(Value::as_str) == Some(want)
                        && t.get("type").and_then(Value::as_str) == Some("page")
                })
                .and_then(|t| t.get("webSocketDebuggerUrl"))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        assert_eq!(pick("tab2").as_deref(), Some("ws://x/tab2"));
        // The extension target must never be selected, even by its own id.
        assert_eq!(pick("ext1"), None);
    }

    /// CDP interleaves events with replies; matching on id is what stops an
    /// event being returned as the answer to a command.
    #[test]
    fn replies_are_matched_by_id_not_by_arrival() {
        let frames = [
            r#"{"method":"Page.frameStartedLoading","params":{}}"#,
            r#"{"id":1,"result":{"targetId":"tab1"}}"#,
        ];
        let mut matched = None;
        for f in frames {
            let v: Value = serde_json::from_str(f).unwrap();
            if v.get("id").and_then(Value::as_u64) == Some(1) {
                matched = v.get("result").cloned();
            }
        }
        assert_eq!(
            matched.and_then(|r| r
                .get("targetId")
                .and_then(Value::as_str)
                .map(str::to_string)),
            Some("tab1".to_string())
        );
    }
}
