//! The preview listener's one handler: `GET /<token>/<path>`.
//!
//! Every response says `no-store`, so a reload always shows the file as it
//! is now, and `frame-ancestors` limits which pages may frame it to the app's
//! own (Playwright opens it top-level, which `frame-ancestors` doesn't
//! govern). A `Host` other than this port's own loopback name is refused, so
//! a web page that rebinds a hostname to 127.0.0.1 can't read the folder.

use super::paths::{self, Refusal};
use super::Shared;
use axum::body::Body;
use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, HOST};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use std::sync::Arc;

/// Larger files aren't mockup assets.
const MAX_FILE: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
struct Ctx {
    shared: Arc<Shared>,
    port: u16,
}

pub(super) fn router(shared: Arc<Shared>, port: u16) -> Router {
    Router::new()
        .fallback(handle)
        .with_state(Ctx { shared, port })
}

fn frame_ancestors() -> &'static str {
    if cfg!(debug_assertions) {
        "frame-ancestors tauri: http://tauri.localhost https://tauri.localhost http://localhost:1420"
    } else {
        "frame-ancestors tauri: http://tauri.localhost https://tauri.localhost"
    }
}

fn plain(status: StatusCode, text: &'static str) -> Response {
    (
        status,
        [
            (CONTENT_TYPE, "text/plain; charset=utf-8"),
            (CACHE_CONTROL, "no-store"),
        ],
        text,
    )
        .into_response()
}

async fn handle(State(ctx): State<Ctx>, method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let host = headers
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if host != format!("127.0.0.1:{}", ctx.port) && host != format!("localhost:{}", ctx.port) {
        return plain(StatusCode::MISDIRECTED_REQUEST, "Wrong host.");
    }
    if method != Method::GET && method != Method::HEAD {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "Only GET.");
    }
    let path = uri.path().trim_start_matches('/');
    let (token, rest) = path.split_once('/').unwrap_or((path, ""));
    let Some(root) = ctx.shared.root_for(token) else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    let Ok(rel) = urlencoding::decode(rest) else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    let file = match paths::resolve(&root, &rel) {
        Ok(f) => f,
        Err(Refusal::NotFound) => return plain(StatusCode::NOT_FOUND, "Not found."),
        Err(_) => return plain(StatusCode::FORBIDDEN, "Not served."),
    };
    match tokio::fs::metadata(&file).await {
        Ok(m) if m.len() > MAX_FILE => {
            return plain(StatusCode::PAYLOAD_TOO_LARGE, "Too large to preview.")
        }
        Ok(_) => {}
        Err(_) => return plain(StatusCode::NOT_FOUND, "Not found."),
    }
    let Ok(bytes) = tokio::fs::read(&file).await else {
        return plain(StatusCode::NOT_FOUND, "Not found.");
    };
    ctx.shared.served(token, &file);
    let mut res = Response::new(if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes)
    });
    let h = res.headers_mut();
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_static(crate::owner::server::content_type(&file)),
    );
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        "content-security-policy",
        HeaderValue::from_static(frame_ancestors()),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    res
}

#[cfg(test)]
mod tests {
    use super::super::PreviewServer;
    use std::fs;

    async fn serving() -> (tempfile::TempDir, PreviewServer, String) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("site/css")).unwrap();
        fs::write(dir.path().join("site/index.html"), "<p>x</p>").unwrap();
        fs::write(dir.path().join("site/css/a.css"), "p{}").unwrap();
        fs::write(dir.path().join(".env"), "KEY=1").unwrap();
        let server = PreviewServer::default();
        let url = server
            .serve("t", &dir.path().to_string_lossy(), "site/index.html")
            .await
            .unwrap();
        let base = url.trim_end_matches("site/index.html").to_string();
        (dir, server, base)
    }

    #[tokio::test]
    async fn files_come_with_their_type_and_headers() {
        let (_dir, server, base) = serving().await;
        let r = reqwest::get(format!("{base}site/css/a.css")).await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["content-type"], "text/css; charset=utf-8");
        assert_eq!(r.headers()["cache-control"], "no-store");
        assert!(r.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .starts_with("frame-ancestors "));
        let r = reqwest::get(format!("{base}site/")).await.unwrap();
        assert_eq!(r.headers()["content-type"], "text/html; charset=utf-8");
        assert_eq!(r.text().await.unwrap(), "<p>x</p>");
        server.stop("t");
    }

    /// The status for `GET <base path><rest>`, sent byte for byte.
    async fn raw(base: &str, rest: &str) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let after = base.strip_prefix("http://").unwrap();
        let (host, path) = after.split_once('/').unwrap();
        let mut s = tokio::net::TcpStream::connect(host).await.unwrap();
        let req =
            format!("GET /{path}{rest} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out[9..12].parse().unwrap()
    }

    #[tokio::test]
    async fn refusals() {
        let (_dir, server, base) = serving().await;
        let status =
            |url: String| async move { reqwest::get(url).await.unwrap().status().as_u16() };
        let origin = base.splitn(4, '/').take(3).collect::<Vec<_>>().join("/");
        assert_eq!(
            status(format!("{origin}/wrongtoken/site/index.html")).await,
            404
        );
        assert_eq!(status(format!("{base}.env")).await, 403);
        // A client normalises `%2e%2e` away; send it as a raw request line.
        assert_eq!(raw(&base, "%2e%2e/%2e%2e/etc/passwd").await, 403);
        assert_eq!(raw(&base, "..%2f..%2fetc/passwd").await, 403);
        assert_eq!(raw(&base, "site%5c..%5c..%5cx").await, 403);
        assert_eq!(status(format!("{base}site/nope.css")).await, 404);

        let client = reqwest::Client::new();
        let r = client
            .post(format!("{base}site/index.html"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 405);
        let r = client
            .get(format!("{base}site/index.html"))
            .header("host", "evil.example:80")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 421);
        server.stop("t");
    }
}
