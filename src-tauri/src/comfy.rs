//! ComfyUI over HTTP and WebSocket, from Rust rather than the webview.
//!
//! A request from the webview carries an `Origin`. ComfyUI's origin-only
//! middleware rejects a loopback request whose `Origin` host differs from its
//! `Host`, and a remote server sends no CORS headers, so the webview saw "Load
//! failed" unless ComfyUI was started with `--enable-cors-header`. A request
//! from here carries no `Origin`, so a stock `python main.py` works.
//!
//! The socket gains something too: a browser `WebSocket` cannot send headers,
//! so the API key never reached a server that wanted it. From here it can.
//!
//! No proxy: the webview's `fetch` used none, and a ComfyUI on the LAN should
//! not be reached through an outbound one.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::sidecar_utils::{clear_logs, new_log_buffer, push_log, snapshot_logs, LogBuffer};

/// One HTTP call. `id` lets the caller cancel it with [`comfy_cancel`].
#[derive(Clone, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct ComfyCall {
    pub base_url: String,
    pub api_key: String,
    /// `GET` or `POST`.
    pub method: String,
    pub path: String,
    #[ts(type = "unknown")]
    pub body: Option<serde_json::Value>,
    pub timeout_ms: u64,
    pub id: Option<String>,
}

/// By hand, so a `{:?}` in a log or an error never prints the API key or the
/// request body.
impl std::fmt::Debug for ComfyCall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Self {
            base_url,
            api_key,
            method,
            path,
            body,
            timeout_ms,
            id,
        } = self;
        f.debug_struct("ComfyCall")
            .field("base_url", base_url)
            .field("api_key", &crate::text_util::redacted(api_key))
            .field("method", method)
            .field("path", path)
            .field("body", &body.as_ref().map(|_| "<body>"))
            .field("timeout_ms", timeout_ms)
            .field("id", id)
            .finish()
    }
}

/// Why a call failed, in the kinds `ImageBackendError` already has.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComfyError {
    Unreachable { message: String },
    Timeout { message: String },
    Rejected { status: u16, body: String },
    Cancelled,
}

impl std::fmt::Display for ComfyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable { message } | Self::Timeout { message } => f.write_str(message),
            Self::Rejected { status, body } => {
                write!(
                    f,
                    "The image backend refused the request ({status}): {body}"
                )
            }
            Self::Cancelled => f.write_str("Cancelled."),
        }
    }
}

/// One message from the progress socket, or the socket's end.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComfySocketEvent {
    /// A text frame. `type` is ComfyUI's message type; `value` and `max` are
    /// present on `progress`, `node` on `executing` (the graph node now
    /// running, so the webview can tell a model loading from a model drawing).
    Message {
        #[serde(rename = "type")]
        kind: String,
        value: Option<f64>,
        max: Option<f64>,
        node: Option<String>,
    },
    /// The socket failed or the server closed it.
    Closed,
}

/// How much of a refusal's body comes back.
const REJECTED_BODY_MAX: usize = 4000;

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("a client with no proxy and a connect timeout builds")
    })
}

/// In-flight calls and open sockets, by id, so either can be stopped.
fn running() -> &'static Mutex<HashMap<String, AbortHandle>> {
    static R: OnceLock<Mutex<HashMap<String, AbortHandle>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn base(url: &str) -> &str {
    url.trim().trim_end_matches('/')
}

/// Where the API key is kept in the secret store.
const API_KEY_SECRET: &str = "comfy:key";

/// The key to send: the one the webview gave (inline only where no secret
/// store works), else the stored one, else none.
async fn effective_api_key(given: &str) -> String {
    let given = given.trim();
    if !given.is_empty() {
        return given.to_string();
    }
    crate::secrets::get(API_KEY_SECRET)
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Make the call and return the body's bytes, or why not.
async fn send(call: &ComfyCall) -> Result<Vec<u8>, ComfyError> {
    let url = format!("{}{}", base(&call.base_url), call.path);
    let mut req = match call.method.as_str() {
        "POST" => client().post(&url),
        _ => client().get(&url),
    };
    // Absent rather than empty: a bare local ComfyUI has no auth.
    let key = effective_api_key(&call.api_key).await;
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }
    if let Some(body) = &call.body {
        req = req.json(body);
    }
    let timeout = Duration::from_millis(call.timeout_ms);
    let res = req.timeout(timeout).send().await.map_err(|e| {
        if e.is_timeout() {
            ComfyError::Timeout {
                message: format!(
                    "The image backend did not answer {} within {}s.",
                    call.path,
                    timeout.as_secs()
                ),
            }
        } else {
            ComfyError::Unreachable {
                message: format!(
                    "Could not reach the image backend at {} — {}. Is ComfyUI running there?",
                    base(&call.base_url),
                    root_cause(&e)
                ),
            }
        }
    })?;
    let status = res.status();
    let bytes = res.bytes().await.map_err(|e| ComfyError::Unreachable {
        message: format!(
            "The image backend dropped {} — {}",
            call.path,
            root_cause(&e)
        ),
    })?;
    if !status.is_success() {
        // Enough for ComfyUI's validation report, which the client turns into
        // a sentence; it clips what it shows.
        let body: String = String::from_utf8_lossy(&bytes)
            .chars()
            .take(REJECTED_BODY_MAX)
            .collect();
        return Err(ComfyError::Rejected {
            status: status.as_u16(),
            body,
        });
    }
    Ok(bytes.to_vec())
}

/// The innermost error: reqwest's own message is "error sending request".
fn root_cause(e: &(dyn std::error::Error + 'static)) -> String {
    let mut cur = e;
    while let Some(next) = cur.source() {
        cur = next;
    }
    cur.to_string()
}

/// What ComfyUI was asked and how it went, for the log viewer's Image tab:
/// the method, server, path, outcome, time taken and size. Never the API key,
/// and never a body: prompts can be long, and they are the user's.
fn comfy_log() -> &'static LogBuffer {
    static LOG: OnceLock<LogBuffer> = OnceLock::new();
    LOG.get_or_init(new_log_buffer)
}

async fn log_line(line: String) {
    let stamped = format!("{} {line}", crate::app_log::timestamp());
    push_log(&mut *comfy_log().lock().await, &stamped);
}

/// `url`'s scheme, host and port, without any username or password in it.
fn server(url: &str) -> String {
    match reqwest::Url::parse(base(url)) {
        Ok(mut u) => {
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.origin().ascii_serialization()
        }
        Err(_) => "(bad address)".into(),
    }
}

/// One line for a finished call.
fn call_line(call: &ComfyCall, out: &Result<Vec<u8>, ComfyError>, elapsed: Duration) -> String {
    let what = format!("{} {}{}", call.method, server(&call.base_url), call.path);
    let ms = elapsed.as_millis();
    match out {
        Ok(bytes) => format!("{what} → ok in {ms} ms, {} bytes", bytes.len()),
        Err(ComfyError::Rejected { status, body }) => {
            let body: String = body.chars().take(300).collect();
            format!("{what} → {status} in {ms} ms: {body}")
        }
        Err(ComfyError::Cancelled) => format!("{what} → cancelled after {ms} ms"),
        Err(e) => format!("{what} → failed after {ms} ms: {e}"),
    }
}

/// Run `call` as a task registered under its id, so [`comfy_cancel`] can stop it.
async fn cancellable(call: ComfyCall) -> Result<Vec<u8>, ComfyError> {
    let started = std::time::Instant::now();
    let out = cancellable_unlogged(call.clone()).await;
    log_line(call_line(&call, &out, started.elapsed())).await;
    out
}

async fn cancellable_unlogged(call: ComfyCall) -> Result<Vec<u8>, ComfyError> {
    let id = call.id.clone();
    let task = tokio::spawn(async move { send(&call).await });
    if let Some(id) = &id {
        running()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone(), task.abort_handle());
    }
    let out = task.await;
    if let Some(id) = &id {
        running()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
    }
    match out {
        Ok(r) => r,
        Err(e) if e.is_cancelled() => Err(ComfyError::Cancelled),
        Err(e) => Err(ComfyError::Unreachable {
            message: format!("The request to the image backend failed — {e}"),
        }),
    }
}

/// Parse a body as JSON; an empty body is `null`, anything else unparseable is
/// its text (`/interrupt` answers with nothing, Manager's version with text).
fn as_json(bytes: &[u8]) -> serde_json::Value {
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return serde_json::Value::Null;
    }
    serde_json::from_slice(bytes)
        .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned()))
}

/// A call whose answer is JSON (or text, or nothing).
#[tauri::command]
pub async fn comfy_json(call: ComfyCall) -> Result<serde_json::Value, ComfyError> {
    cancellable(call).await.map(|b| as_json(&b))
}

/// A call whose answer is bytes: `/view`.
#[tauri::command]
pub async fn comfy_bytes(call: ComfyCall) -> Result<Response, ComfyError> {
    cancellable(call).await.map(Response::new)
}

/// Stop a call or close a socket. Unknown ids are ignored: it already ended.
#[tauri::command]
pub fn comfy_cancel(id: String) {
    if let Some(h) = running()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&id)
    {
        h.abort();
    }
}

/// The fields of a socket frame worth forwarding.
fn socket_event(text: &str) -> Option<ComfySocketEvent> {
    let msg: serde_json::Value = serde_json::from_str(text).ok()?;
    let kind = msg.get("type")?.as_str()?.to_string();
    let data = msg.get("data");
    let num = |k: &str| data.and_then(|d| d.get(k)).and_then(|v| v.as_f64());
    Some(ComfySocketEvent::Message {
        value: num("value"),
        max: num("max"),
        node: data
            .and_then(|d| d.get("node"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        kind,
    })
}

/// The ComfyUI call log, oldest first.
#[tauri::command]
pub async fn comfy_logs() -> Vec<String> {
    snapshot_logs(comfy_log()).await
}

#[tauri::command]
pub async fn comfy_clear_logs() {
    clear_logs(comfy_log()).await;
}

/// Open the progress socket and forward its messages on `channel` until
/// [`comfy_cancel`] closes it or the server does. Fails when the handshake
/// does, so the caller can fall back to polling at once.
#[tauri::command]
pub async fn comfy_subscribe(
    base_url: String,
    api_key: String,
    client_id: String,
    id: String,
    channel: Channel<ComfySocketEvent>,
) -> Result<(), ComfyError> {
    let url = format!(
        "{}/ws?clientId={}",
        base(&base_url).replacen("http", "ws", 1),
        urlencoding::encode(&client_id)
    );
    let mut request = url
        .into_client_request()
        .map_err(|e| ComfyError::Unreachable {
            message: format!("Bad image backend URL {base_url}: {e}"),
        })?;
    let api_key = effective_api_key(&api_key).await;
    if !api_key.is_empty() {
        let value = format!("Bearer {api_key}");
        request.headers_mut().insert(
            "Authorization",
            value.parse().map_err(|_| ComfyError::Unreachable {
                message: "The API key cannot be sent as a header.".into(),
            })?,
        );
    }
    let connect = tokio_tungstenite::connect_async(request);
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), connect)
        .await
        .map_err(|_| ComfyError::Timeout {
            message: "The image backend's progress socket did not open.".into(),
        })?
        .map_err(|e| ComfyError::Unreachable {
            message: format!("The image backend's progress socket refused: {e}"),
        })?;

    let where_ = server(&base_url);
    log_line(format!("progress socket opened to {where_}")).await;
    let task = tokio::spawn(async move {
        while let Some(frame) = socket.next().await {
            match frame {
                Ok(Message::Text(t)) => {
                    if let Some(ev) = socket_event(&t) {
                        if channel.send(ev).is_err() {
                            return;
                        }
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                // Binary frames are previews; nothing reads them.
                Ok(_) => {}
            }
        }
        let _ = channel.send(ComfySocketEvent::Closed);
        log_line(format!("progress socket to {where_} closed")).await;
    });
    running()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id, task.abort_handle());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_name_the_server_without_credentials() {
        assert_eq!(
            server("http://user:secret@gpu.lan:8188/"),
            "http://gpu.lan:8188"
        );
        let call = ComfyCall {
            base_url: "http://user:secret@gpu.lan:8188".into(),
            api_key: "sk-SECRET".into(),
            method: "POST".into(),
            path: "/prompt".into(),
            body: Some(serde_json::json!({"prompt": "a private prompt"})),
            timeout_ms: 1000,
            id: None,
        };
        let ok = call_line(&call, &Ok(vec![0; 42]), Duration::from_millis(7));
        assert_eq!(ok, "POST http://gpu.lan:8188/prompt → ok in 7 ms, 42 bytes");
        let refused = call_line(
            &call,
            &Err(ComfyError::Rejected {
                status: 400,
                body: "missing node".into(),
            }),
            Duration::from_millis(3),
        );
        assert!(refused.ends_with("→ 400 in 3 ms: missing node"));
        for line in [ok, refused] {
            assert!(!line.contains("secret") && !line.contains("sk-") && !line.contains("private"));
        }
    }
    use axum::routing::{get, post};
    use axum::Router;

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn call(base_url: &str, method: &str, path: &str) -> ComfyCall {
        ComfyCall {
            base_url: format!("{base_url}/"),
            api_key: String::new(),
            method: method.into(),
            path: path.into(),
            body: None,
            timeout_ms: 2_000,
            id: None,
        }
    }

    #[tokio::test]
    async fn json_text_and_empty_bodies() {
        let url = serve(
            Router::new()
                .route("/stats", get(|| async { r#"{"ok":1}"# }))
                .route("/version", get(|| async { "V4.2.2" }))
                .route("/interrupt", post(|| async { "" })),
        )
        .await;
        assert_eq!(
            comfy_json(call(&url, "GET", "/stats")).await.unwrap(),
            serde_json::json!({ "ok": 1 })
        );
        assert_eq!(
            comfy_json(call(&url, "GET", "/version")).await.unwrap(),
            serde_json::json!("V4.2.2")
        );
        assert_eq!(
            comfy_json(call(&url, "POST", "/interrupt")).await.unwrap(),
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn sends_the_body_and_the_key_and_no_origin() {
        let url = serve(Router::new().route(
            "/prompt",
            post(|headers: axum::http::HeaderMap, body: String| async move {
                format!(
                    r#"{{"auth":{:?},"origin":{},"body":{}}}"#,
                    headers["authorization"].to_str().unwrap(),
                    headers.contains_key("origin"),
                    body
                )
            }),
        ))
        .await;
        let mut c = call(&url, "POST", "/prompt");
        c.api_key = " secret ".into();
        c.body = Some(serde_json::json!({ "prompt": {} }));
        let out = comfy_json(c).await.unwrap();
        assert_eq!(out["auth"], "Bearer secret");
        assert_eq!(out["origin"], false);
        assert_eq!(out["body"], serde_json::json!({ "prompt": {} }));
    }

    #[tokio::test]
    async fn a_refusal_carries_its_status_and_the_start_of_its_body() {
        let url = serve(Router::new().route(
            "/prompt",
            post(|| async { (axum::http::StatusCode::BAD_REQUEST, "x".repeat(5000)) }),
        ))
        .await;
        match comfy_json(call(&url, "POST", "/prompt")).await {
            Err(ComfyError::Rejected { status, body }) => {
                assert_eq!(status, 400);
                assert_eq!(body.len(), REJECTED_BODY_MAX);
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn bytes_come_back_as_bytes() {
        let url = serve(Router::new().route("/view", get(|| async { vec![0u8, 159, 255] }))).await;
        assert!(comfy_bytes(call(&url, "GET", "/view")).await.is_ok());
        assert_eq!(
            send(&call(&url, "GET", "/view")).await.unwrap(),
            vec![0, 159, 255]
        );
    }

    #[tokio::test]
    async fn a_slow_answer_times_out_and_a_closed_port_is_unreachable() {
        let url = serve(Router::new().route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                "late"
            }),
        ))
        .await;
        let mut c = call(&url, "GET", "/slow");
        c.timeout_ms = 100;
        assert!(matches!(
            comfy_json(c).await,
            Err(ComfyError::Timeout { .. })
        ));
        let mut closed = call("http://127.0.0.1:9", "GET", "/system_stats");
        // Windows retries a refused connection for ~2 s before giving up, which
        // the 2 s default would report as a timeout.
        closed.timeout_ms = 10_000;
        assert!(matches!(
            comfy_json(closed).await,
            Err(ComfyError::Unreachable { .. })
        ));
    }

    #[tokio::test]
    async fn a_call_can_be_cancelled_by_id() {
        let url = serve(Router::new().route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                "late"
            }),
        ))
        .await;
        let mut c = call(&url, "GET", "/slow");
        c.id = Some("cancel-me".into());
        let pending = tokio::spawn(comfy_json(c));
        tokio::time::sleep(Duration::from_millis(100)).await;
        comfy_cancel("cancel-me".into());
        assert_eq!(pending.await.unwrap(), Err(ComfyError::Cancelled));
        assert!(!running().lock().unwrap().contains_key("cancel-me"));
    }

    #[test]
    fn socket_frames_keep_type_and_progress() {
        match socket_event(r#"{"type":"progress","data":{"value":3,"max":12}}"#) {
            Some(ComfySocketEvent::Message {
                kind,
                value,
                max,
                node,
            }) => {
                assert_eq!(
                    (kind.as_str(), value, max, node),
                    ("progress", Some(3.0), Some(12.0), None)
                );
            }
            other => panic!("{other:?}"),
        }
        match socket_event(r#"{"type":"executing","data":{"node":"4","prompt_id":"p"}}"#) {
            Some(ComfySocketEvent::Message { kind, node, .. }) => {
                assert_eq!((kind.as_str(), node.as_deref()), ("executing", Some("4")));
            }
            other => panic!("{other:?}"),
        }
        assert!(socket_event("not json").is_none());
        assert!(socket_event(r#"{"data":{}}"#).is_none());
    }
}
