//! The owner API over HTTP: engine operations as POSTs, engine events as SSE.
//!
//! Its own listener, apart from remote chat's guest server (`remote/`): that
//! one is for people the owner lets chat, this one for the owner's own
//! devices, and they want different networks and different rules. Every
//! request but `/api/v1/health` carries a device's token as
//! `Authorization: Bearer`, and every operation is checked against that
//! device's scopes (`clients.rs`).
//!
//! The web client (plan/remote-api phase 4) is served from `/app/` and uses
//! a cookie instead, set by redeeming a one-time pairing code
//! (`pairing.rs`). A cookie alone is never enough: the request must also
//! carry `X-Haruspex: 1`, a header a page on another site can't add without
//! a CORS preflight this server never answers, and a request whose `Origin`
//! isn't its own `Host` is refused either way.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Component, Path as FsPath, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, State};
use axum::http::header::{
    AUTHORIZATION, CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, COOKIE, HOST, LOCATION,
    ORIGIN, SET_COOKIE,
};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::Stream;
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch};

use super::clients::{required_scope, Clients, OwnerClient, Scope};
use super::pairing::PairingCodes;
use crate::sync_util::LockExt;

/// Largest operation body. A prompt is the only big thing in one.
const MAX_BODY_BYTES: usize = 64 * 1024;

/// Failed tokens one address may send in a [`THROTTLE_WINDOW`] before it is
/// refused outright for the rest of it.
const THROTTLE_FAILURES: u32 = 10;
const THROTTLE_WINDOW: Duration = Duration::from_secs(60);

/// The web client's cookie: a device token, set by `/api/v1/pair`.
pub const OWNER_COOKIE: &str = "haruspex_owner";

/// The header a cookie-authenticated request must carry (see the module doc).
const CSRF_HEADER: &str = "x-haruspex";

/// The web client's pages: nothing but its own files, and no framing.
const WEB_CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
                       connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// What the server needs from the engine. The app's is `engine::request` and
/// `EngineHub::subscribe`; the tests' is a stub.
pub trait Dispatch: Send + Sync + 'static {
    fn op(&self, op: Value) -> BoxFuture<Result<Value, String>>;
    fn subscribe(&self) -> broadcast::Receiver<Value>;
}

/// What the server serves from.
pub struct Services {
    pub dispatch: Arc<dyn Dispatch>,
    pub clients: Arc<Clients>,
    pub pairing: Arc<PairingCodes>,
    /// The built web client (`index.html` and its assets), if there is one.
    pub web_root: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    dispatch: Arc<dyn Dispatch>,
    clients: Arc<Clients>,
    pairing: Arc<PairingCodes>,
    web_root: Option<Arc<PathBuf>>,
    throttle: Arc<Throttle>,
}

pub struct Running {
    pub port: u16,
    pub bind_all: bool,
    shutdown: watch::Sender<bool>,
}

impl Running {
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

/// Bind and serve. Returns once the socket is listening.
pub async fn start(services: Services, port: u16, bind_all: bool) -> Result<Running, String> {
    let ip = if bind_all {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    let addr = SocketAddr::new(ip, port);
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        format!("could not listen on {addr}: {e} — another program may already have that port")
    })?;
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(port);

    let state = AppState {
        dispatch: services.dispatch,
        clients: services.clients,
        pairing: services.pairing,
        web_root: services.web_root.map(Arc::new),
        throttle: Arc::new(Throttle::default()),
    };
    let router = Router::new()
        .route("/", get(to_app))
        .route("/app", get(to_app))
        .route("/app/", get(web_index))
        .route("/app/{*path}", get(web_file))
        .route("/api/v1/health", get(health))
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/logout", post(logout))
        .route("/api/v1/op", post(op))
        .route("/api/v1/events", get(events))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state);

    let (shutdown, mut rx) = watch::channel(false);
    tokio::spawn(async move {
        let served = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = rx.wait_for(|stop| *stop).await;
        });
        if let Err(e) = served.await {
            log::error!("[owner] server stopped: {e}");
        }
    });
    log::info!(
        "[owner] serving on {}:{port}",
        if bind_all { "0.0.0.0" } else { "127.0.0.1" }
    );
    Ok(Running {
        port,
        bind_all,
        shutdown,
    })
}

// --- auth ---------------------------------------------------------------------

/// Failed tokens per address, so guessing is slow.
#[derive(Default)]
struct Throttle {
    failures: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl Throttle {
    fn blocked(&self, ip: IpAddr) -> bool {
        let map = self.failures.lock_or_recover();
        matches!(map.get(&ip), Some((start, n)) if *n >= THROTTLE_FAILURES && start.elapsed() < THROTTLE_WINDOW)
    }

    fn fail(&self, ip: IpAddr) {
        let mut map = self.failures.lock_or_recover();
        if map.len() > 1024 {
            map.retain(|_, (start, _)| start.elapsed() < THROTTLE_WINDOW);
        }
        let entry = map.entry(ip).or_insert((Instant::now(), 0));
        if entry.0.elapsed() >= THROTTLE_WINDOW {
            *entry = (Instant::now(), 0);
        }
        entry.1 += 1;
    }
}

fn refuse(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// A browser page on another site calling in: its `Origin` names somewhere
/// other than the `Host` it is calling.
fn cross_site(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let host = headers
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let authority = origin.split_once("://").map(|(_, a)| a).unwrap_or(origin);
    !authority.eq_ignore_ascii_case(host)
}

/// Why a request is refused: its status and what to tell the caller.
type Refusal = (StatusCode, &'static str);

/// The device making the request, or why it is refused.
fn authorise(state: &AppState, ip: IpAddr, headers: &HeaderMap) -> Result<OwnerClient, Refusal> {
    if cross_site(headers) {
        return Err((StatusCode::FORBIDDEN, "cross-site requests are refused"));
    }
    if state.throttle.blocked(ip) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many wrong tokens; wait a minute",
        ));
    }
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let token = match bearer {
        Some(t) => t.to_string(),
        None => match cookie(headers, OWNER_COOKIE) {
            Some(t) if headers.get(CSRF_HEADER).is_some_and(|v| v == "1") => t,
            Some(_) => return Err((StatusCode::FORBIDDEN, "missing X-Haruspex header")),
            None => String::new(),
        },
    };
    match state.clients.authenticate(&token) {
        Some(client) => Ok(client),
        None => {
            state.throttle.fail(ip);
            Err((StatusCode::UNAUTHORIZED, "a device token is needed"))
        }
    }
}

/// A cookie's value from the `Cookie` header.
fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

/// The refusal for a device without `scope`, if it hasn't got it.
fn missing(client: &OwnerClient, scope: Scope) -> Option<Response> {
    let what = match scope {
        Scope::Read => "read sessions",
        Scope::Drive => "drive sessions",
        Scope::Approve => "answer prompts",
    };
    (!client.scopes.contains(&scope)).then(|| {
        refuse(
            StatusCode::FORBIDDEN,
            &format!("this device may not {what}"),
        )
    })
}

// --- handlers -------------------------------------------------------------------

/// Redeem a pairing code for the device cookie. Open, like health, but a
/// wrong code counts as a wrong token for the throttle.
async fn pair(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if cross_site(&headers) {
        return refuse(StatusCode::FORBIDDEN, "cross-site requests are refused");
    }
    if state.throttle.blocked(peer.ip()) {
        return refuse(
            StatusCode::TOO_MANY_REQUESTS,
            "too many wrong codes; wait a minute",
        );
    }
    let code = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let Some(token) = state.pairing.redeem(&code) else {
        state.throttle.fail(peer.ip());
        return refuse(
            StatusCode::UNAUTHORIZED,
            "that link has expired or was used already: make a new one in Settings → Remote control",
        );
    };
    // Behind `tailscale serve` the browser speaks HTTPS and this server
    // plain HTTP; the proxy says which.
    let secure = headers
        .get("x-forwarded-proto")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"https"));
    let cookie = format!(
        "{OWNER_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000{}",
        if secure { "; Secure" } else { "" }
    );
    let mut response = Json(json!({ "ok": true })).into_response();
    response
        .headers_mut()
        .insert(SET_COOKIE, cookie.parse().expect("token is hex"));
    response
}

async fn logout() -> Response {
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().insert(
        SET_COOKIE,
        format!("{OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
            .parse()
            .expect("static cookie"),
    );
    response
}

async fn to_app() -> Response {
    (StatusCode::FOUND, [(LOCATION, "/app/")]).into_response()
}

async fn web_index(State(state): State<AppState>) -> Response {
    web(&state, "")
}

async fn web_file(State(state): State<AppState>, Path(path): Path<String>) -> Response {
    web(&state, &path)
}

const NOT_BUILT: &str = "the web client isn't built into this copy of Haruspex";

/// The web client's files. A path naming no file is the app's own route, so
/// it gets `index.html`; a path that tries to leave the folder gets nothing.
fn web(state: &AppState, path: &str) -> Response {
    let Some(root) = state.web_root.as_deref() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, NOT_BUILT);
    };
    let Some(rel) = safe_relative(path) else {
        return refuse(StatusCode::NOT_FOUND, "no such file");
    };
    let candidate = root.join(&rel);
    let (file, is_index) = if !rel.as_os_str().is_empty() && candidate.is_file() {
        (candidate, false)
    } else if rel.extension().is_some() {
        // An asset that isn't there, not a page.
        return refuse(StatusCode::NOT_FOUND, "no such file");
    } else {
        (root.join("index.html"), true)
    };
    let Ok(bytes) = std::fs::read(&file) else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, NOT_BUILT);
    };
    let mut response = bytes.into_response();
    let h = response.headers_mut();
    h.insert(
        CONTENT_TYPE,
        content_type(&file).parse().expect("static type"),
    );
    h.insert(
        CONTENT_SECURITY_POLICY,
        WEB_CSP.parse().expect("static csp"),
    );
    // Vite names assets by their hash, so only the page itself goes stale.
    let cache = if is_index {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    h.insert(CACHE_CONTROL, cache.parse().expect("static header"));
    response
}

/// `path` as a relative path inside the web root, or `None` if any part of
/// it would leave it (`..`, an absolute path, a drive, a backslash).
fn safe_relative(path: &str) -> Option<PathBuf> {
    if path.contains('\\') || path.contains('\0') {
        return None;
    }
    let mut out = PathBuf::new();
    for c in FsPath::new(path).components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

fn content_type(file: &FsPath) -> &'static str {
    match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

/// Why the engine refused, as a status: a window that never answered, the
/// engine switched off, or the operation itself turned down.
fn engine_status(error: &str) -> StatusCode {
    if error.contains("no answer from the window") {
        StatusCode::GATEWAY_TIMEOUT
    } else if error.contains("the engine is off") {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::CONFLICT
    }
}

async fn op(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let client = match authorise(&state, peer.ip(), &headers) {
        Ok(c) => c,
        Err((status, why)) => return refuse(status, why),
    };
    let Ok(op) = serde_json::from_slice::<Value>(&body) else {
        return refuse(StatusCode::BAD_REQUEST, "the body is not JSON");
    };
    let kind = op.get("type").and_then(Value::as_str).unwrap_or_default();
    let Some(scope) = required_scope(kind) else {
        return refuse(StatusCode::BAD_REQUEST, &format!("no operation {kind:?}"));
    };
    if let Some(r) = missing(&client, scope) {
        return r;
    }
    match state.dispatch.op(op).await {
        Ok(value) => Json(json!({ "value": value })).into_response(),
        Err(e) => refuse(engine_status(&e), &e),
    }
}

async fn events(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let client = match authorise(&state, peer.ip(), &headers) {
        Ok(c) => c,
        Err((status, why)) => return refuse(status, why),
    };
    if let Some(r) = missing(&client, Scope::Read) {
        return r;
    }
    let mut response = Sse::new(event_stream(state.dispatch.subscribe()))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, "no-store".parse().expect("static header"));
    response
}

/// `ready` first, so a client knows it is connected, then every engine event.
/// A reader that falls behind is told `resync-all` and asks for snapshots of
/// the sessions it follows (`session.resync`).
fn event_stream(rx: broadcast::Receiver<Value>) -> impl Stream<Item = Result<Event, Infallible>> {
    let ready = Some(json!({ "type": "ready" }));
    futures_util::stream::unfold((rx, ready), |(mut rx, mut pending)| async move {
        if let Some(first) = pending.take() {
            return Some((Ok(sse(&first)), (rx, pending)));
        }
        match rx.recv().await {
            Ok(event) => Some((Ok(sse(&event)), (rx, pending))),
            Err(broadcast::error::RecvError::Lagged(_)) => {
                Some((Ok(sse(&json!({ "type": "resync-all" }))), (rx, pending)))
            }
            Err(broadcast::error::RecvError::Closed) => None,
        }
    })
}

fn sse(event: &Value) -> Event {
    Event::default().data(event.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::owner::clients::Scope;

    /// The engine, as the server sees it: answers from a script, events from a
    /// channel the test publishes on.
    struct Stub {
        events: broadcast::Sender<Value>,
        reply: Mutex<Result<Value, String>>,
        seen: Mutex<Vec<Value>>,
    }

    impl Dispatch for Stub {
        fn op(&self, op: Value) -> BoxFuture<Result<Value, String>> {
            self.seen.lock_or_recover().push(op);
            let reply = self.reply.lock_or_recover().clone();
            Box::pin(async move { reply })
        }
        fn subscribe(&self) -> broadcast::Receiver<Value> {
            self.events.subscribe()
        }
    }

    struct Harness {
        base: String,
        stub: Arc<Stub>,
        clients: Arc<Clients>,
        pairing: Arc<PairingCodes>,
        running: Running,
        http: reqwest::Client,
    }

    async fn serve() -> Harness {
        let (events, _) = broadcast::channel(4);
        let stub = Arc::new(Stub {
            events,
            reply: Mutex::new(Ok(json!({ "started": true }))),
            seen: Mutex::new(Vec::new()),
        });
        let clients = Arc::new(Clients::in_memory());
        let pairing = Arc::new(PairingCodes::default());
        let web = std::env::temp_dir().join(format!("owner-web-{}", std::process::id()));
        std::fs::create_dir_all(web.join("assets")).unwrap();
        std::fs::write(web.join("index.html"), "<!doctype html><title>web</title>").unwrap();
        std::fs::write(web.join("assets/app-1.js"), "console.log(1)").unwrap();
        let services = Services {
            dispatch: stub.clone(),
            clients: clients.clone(),
            pairing: pairing.clone(),
            web_root: Some(web),
        };
        let running = start(services, 0, false).await.unwrap();
        Harness {
            base: format!("http://127.0.0.1:{}", running.port),
            stub,
            clients,
            pairing,
            running,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
        }
    }

    impl Harness {
        fn token(&self, scopes: &[Scope]) -> String {
            self.clients.create("Test", scopes).unwrap().1
        }

        async fn op(&self, token: &str, body: Value) -> reqwest::Response {
            self.http
                .post(format!("{}/api/v1/op", self.base))
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .unwrap()
        }
    }

    #[tokio::test]
    async fn health_is_open_and_the_rest_needs_a_token() {
        let h = serve().await;
        let r = h
            .http
            .get(format!("{}/api/v1/health", h.base))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let r = h.op("", json!({ "type": "sessions.list" })).await;
        assert_eq!(r.status(), 401);
        let r = h.op("hsx_nope", json!({ "type": "sessions.list" })).await;
        assert_eq!(r.status(), 401);
        let r = h
            .http
            .get(format!("{}/api/v1/events", h.base))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401);
        assert!(h.stub.seen.lock_or_recover().is_empty());
        h.running.stop();
    }

    #[tokio::test]
    async fn an_operation_reaches_the_engine_and_its_answer_comes_back() {
        let h = serve().await;
        let token = h.token(&Scope::ALL);
        let r = h
            .op(
                &token,
                json!({ "type": "session.send", "id": "s1", "text": "hi" }),
            )
            .await;
        assert_eq!(r.status(), 200);
        let body: Value = r.json().await.unwrap();
        assert_eq!(body, json!({ "value": { "started": true } }));
        assert_eq!(h.stub.seen.lock_or_recover()[0]["text"], "hi");
        h.running.stop();
    }

    #[tokio::test]
    async fn each_operation_needs_its_scope() {
        let h = serve().await;
        let reader = h.token(&[Scope::Read]);
        assert_eq!(
            h.op(&reader, json!({ "type": "sessions.list" }))
                .await
                .status(),
            200
        );
        let r = h
            .op(
                &reader,
                json!({ "type": "session.send", "id": "s1", "text": "x" }),
            )
            .await;
        assert_eq!(r.status(), 403);
        let r = h
            .op(
                &reader,
                json!({ "type": "prompts.answer", "promptId": "main:1" }),
            )
            .await;
        assert_eq!(r.status(), 403);
        let driver = h.token(&[Scope::Drive]);
        let r = h
            .http
            .get(format!("{}/api/v1/events", h.base))
            .bearer_auth(&driver);
        assert_eq!(r.send().await.unwrap().status(), 403);
        // Only the one that was allowed reached the engine.
        assert_eq!(h.stub.seen.lock_or_recover().len(), 1);
        h.running.stop();
    }

    #[tokio::test]
    async fn an_unknown_operation_or_a_bad_body_is_refused() {
        let h = serve().await;
        let token = h.token(&Scope::ALL);
        assert_eq!(
            h.op(&token, json!({ "type": "session.delete" }))
                .await
                .status(),
            400
        );
        let r = h
            .http
            .post(format!("{}/api/v1/op", h.base))
            .bearer_auth(&token)
            .body("not json")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400);
        let big = "x".repeat(MAX_BODY_BYTES + 1);
        let r = h
            .op(
                &token,
                json!({ "type": "session.send", "id": "s", "text": big }),
            )
            .await;
        assert_eq!(r.status(), 413);
        h.running.stop();
    }

    #[tokio::test]
    async fn engine_refusals_keep_their_meaning() {
        let h = serve().await;
        let token = h.token(&Scope::ALL);
        let cases = [
            ("session s is not open: open it first", 409),
            ("no answer from the window in 10s", 504),
            ("the engine is off", 503),
        ];
        for (error, status) in cases {
            *h.stub.reply.lock_or_recover() = Err(error.into());
            let r = h
                .op(&token, json!({ "type": "session.get", "id": "s" }))
                .await;
            assert_eq!(r.status(), status, "{error}");
            let body: Value = r.json().await.unwrap();
            assert_eq!(body["error"], error);
        }
        h.running.stop();
    }

    #[tokio::test]
    async fn a_page_on_another_site_is_refused() {
        let h = serve().await;
        let token = h.token(&Scope::ALL);
        let r = h
            .http
            .post(format!("{}/api/v1/op", h.base))
            .bearer_auth(&token)
            .header("Origin", "http://evil.example")
            .json(&json!({ "type": "sessions.list" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 403);
        // Its own origin is fine.
        let own = h.base.clone();
        let r = h
            .http
            .post(format!("{}/api/v1/op", h.base))
            .bearer_auth(&token)
            .header("Origin", own)
            .json(&json!({ "type": "sessions.list" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        h.running.stop();
    }

    #[tokio::test]
    async fn guessing_tokens_gets_throttled() {
        let h = serve().await;
        let good = h.token(&Scope::ALL);
        for _ in 0..THROTTLE_FAILURES {
            let r = h.op("hsx_guess", json!({ "type": "sessions.list" })).await;
            assert_eq!(r.status(), 401);
        }
        let r = h.op("hsx_guess", json!({ "type": "sessions.list" })).await;
        assert_eq!(r.status(), 429);
        // Even the right token waits out the minute from that address.
        let r = h.op(&good, json!({ "type": "sessions.list" })).await;
        assert_eq!(r.status(), 429);
        h.running.stop();
    }

    /// Read SSE `data:` lines until `n` events have come, or time runs out.
    async fn read_events(r: reqwest::Response, n: usize) -> Vec<Value> {
        let mut out = Vec::new();
        let mut buf = String::new();
        let mut stream = r.bytes_stream();
        use futures_util::StreamExt;
        let deadline = tokio::time::sleep(Duration::from_secs(5));
        tokio::pin!(deadline);
        while out.len() < n {
            tokio::select! {
                chunk = stream.next() => {
                    let Some(Ok(chunk)) = chunk else { break };
                    buf.push_str(&String::from_utf8_lossy(&chunk));
                    while let Some(i) = buf.find("\n\n") {
                        let frame: String = buf.drain(..i + 2).collect();
                        for line in frame.lines() {
                            if let Some(data) = line.strip_prefix("data:") {
                                out.push(serde_json::from_str(data.trim()).unwrap());
                            }
                        }
                    }
                }
                _ = &mut deadline => break,
            }
        }
        out
    }

    #[tokio::test]
    async fn events_stream_after_ready() {
        let h = serve().await;
        let token = h.token(&[Scope::Read]);
        let r = h
            .http
            .get(format!("{}/api/v1/events", h.base))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let stub = h.stub.clone();
        tokio::spawn(async move {
            // After the subscriber exists.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = stub
                .events
                .send(json!({ "seq": 1, "type": "status", "sessionId": "s" }));
        });
        let got = read_events(r, 2).await;
        assert_eq!(got[0]["type"], "ready");
        assert_eq!(got[1]["type"], "status");
        h.running.stop();
    }

    #[tokio::test]
    async fn a_reader_that_falls_behind_is_told_to_resync() {
        let h = serve().await;
        let token = h.token(&[Scope::Read]);
        let r = h
            .http
            .get(format!("{}/api/v1/events", h.base))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        let stub = h.stub.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            // Capacity 4: ten at once overflow before the stream reads.
            for seq in 0..10 {
                let _ = stub.events.send(json!({ "seq": seq, "type": "live" }));
            }
        });
        let got = read_events(r, 3).await;
        assert!(got.iter().any(|e| e["type"] == "resync-all"), "{got:?}");
        h.running.stop();
    }

    /// Pair with a fresh device; the cookie to send back.
    async fn paired(h: &Harness, scopes: &[Scope]) -> String {
        let token = h.token(scopes);
        let code = h.pairing.issue(&token).unwrap();
        let r = h
            .http
            .post(format!("{}/api/v1/pair", h.base))
            .json(&json!({ "code": code }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let set = r.headers()[SET_COOKIE].to_str().unwrap().to_string();
        assert!(set.contains("HttpOnly") && set.contains("SameSite=Strict"));
        assert!(!set.contains("Secure"));
        set.split(';').next().unwrap().to_string()
    }

    #[tokio::test]
    async fn a_pairing_code_buys_a_cookie_once() {
        let h = serve().await;
        let token = h.token(&Scope::ALL);
        let code = h.pairing.issue(&token).unwrap();
        let pair = || {
            h.http
                .post(format!("{}/api/v1/pair", h.base))
                .header("X-Forwarded-Proto", "https")
                .json(&json!({ "code": code }))
                .send()
        };
        let r = pair().await.unwrap();
        assert_eq!(r.status(), 200);
        assert!(r.headers()[SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("; Secure"));
        assert_eq!(pair().await.unwrap().status(), 401);
        h.running.stop();
    }

    #[tokio::test]
    async fn a_cookie_needs_the_header_and_its_own_origin() {
        let h = serve().await;
        let cookie = paired(&h, &Scope::ALL).await;
        let send = |header: bool, origin: Option<&str>| {
            let mut req = h
                .http
                .post(format!("{}/api/v1/op", h.base))
                .header("Cookie", cookie.clone())
                .json(&json!({ "type": "sessions.list" }));
            if header {
                req = req.header("X-Haruspex", "1");
            }
            if let Some(o) = origin {
                req = req.header("Origin", o.to_string());
            }
            req.send()
        };
        // The cookie alone, as a forged form or fetch from elsewhere would send it.
        assert_eq!(send(false, None).await.unwrap().status(), 403);
        assert_eq!(send(true, None).await.unwrap().status(), 200);
        let own = h.base.clone();
        assert_eq!(send(true, Some(&own)).await.unwrap().status(), 200);
        let other = send(true, Some("http://evil.example")).await.unwrap();
        assert_eq!(other.status(), 403);
        h.running.stop();
    }

    #[tokio::test]
    async fn logging_out_clears_the_cookie() {
        let h = serve().await;
        let r = h
            .http
            .post(format!("{}/api/v1/logout", h.base))
            .send()
            .await
            .unwrap();
        assert!(r.headers()[SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0"));
        h.running.stop();
    }

    #[tokio::test]
    async fn the_web_client_is_served_with_its_policy() {
        let h = serve().await;
        let r = h.http.get(format!("{}/", h.base)).send().await.unwrap();
        assert_eq!(r.status(), 302);
        assert_eq!(r.headers()[LOCATION], "/app/");
        for page in ["/app/", "/app/session/s1"] {
            let r = h
                .http
                .get(format!("{}{page}", h.base))
                .send()
                .await
                .unwrap();
            assert_eq!(r.status(), 200, "{page}");
            assert!(r.headers()[CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'"));
            assert_eq!(r.headers()[CACHE_CONTROL], "no-cache");
            assert!(r.text().await.unwrap().contains("<title>web</title>"));
        }
        let get = |path: &str| h.http.get(format!("{}{path}", h.base)).send();
        let js = get("/app/assets/app-1.js").await.unwrap();
        assert_eq!(js.status(), 200);
        assert!(js.headers()[CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/javascript"));
        assert_eq!(get("/app/assets/gone.js").await.unwrap().status(), 404);
        assert_eq!(get("/app/%2e%2e/secret.txt").await.unwrap().status(), 404);
        h.running.stop();
    }

    #[test]
    fn a_path_cannot_leave_the_web_folder() {
        assert_eq!(
            safe_relative("assets/a.js"),
            Some(PathBuf::from("assets/a.js"))
        );
        assert_eq!(safe_relative(""), Some(PathBuf::new()));
        assert_eq!(safe_relative("../x"), None);
        assert_eq!(safe_relative("a/../../x"), None);
        assert_eq!(safe_relative("/etc/passwd"), None);
        assert_eq!(safe_relative("a\\..\\x"), None);
    }

    #[tokio::test]
    async fn a_stopped_server_stops_answering() {
        let h = serve().await;
        h.running.stop();
        let mut closed = false;
        for _ in 0..50 {
            if h.http
                .get(format!("{}/api/v1/health", h.base))
                .send()
                .await
                .is_err()
            {
                closed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(closed);
    }
}
