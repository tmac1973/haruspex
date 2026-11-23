//! Large media files for the webview, over loopback HTTP with `Range`.
//!
//! The webview plays media from `blob:` URLs, which hold the whole file in
//! memory, and won't play a custom scheme at all (WebKitGTK). So a tiny axum
//! server on `127.0.0.1:<random port>` serves files by range instead, which
//! lets a 2 GB recording seek to its end at once.
//!
//! Nothing is served unless it is asked for with this launch's token (32
//! random bytes, kept in memory only) and lies inside a root registered by
//! id: an editor window's folder, or a render's folder for its task card.
//! A path that leaves its root, once canonicalised, is a 404 like any other
//! miss. No CORS headers are sent, and the `Host` must be the loopback
//! address, so another site's page can't read through it.

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Request, Response, StatusCode};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// The bytes read from disk at a time.
const CHUNK: usize = 256 * 1024;

#[derive(Default)]
struct Roots {
    by_id: HashMap<String, PathBuf>,
}

/// The running server: its port, token and roots.
#[derive(Clone)]
pub struct MediaServer {
    port: u16,
    token: Arc<str>,
    roots: Arc<Mutex<Roots>>,
}

/// 32 random bytes, as hex: two v4 UUIDs' random bits are plenty.
fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

impl MediaServer {
    /// Bind `127.0.0.1:0` and serve on the async runtime.
    pub fn start() -> Result<Self, String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("media server: can't bind: {e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("media server: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let server = Self {
            port,
            token: new_token().into(),
            roots: Arc::default(),
        };
        let app = router(server.clone());
        tauri::async_runtime::spawn(async move {
            match tokio::net::TcpListener::from_std(listener) {
                Ok(l) => {
                    if let Err(e) = axum::serve(l, app).await {
                        log::error!("media server stopped: {e}");
                    }
                }
                Err(e) => log::error!("media server: {e}"),
            }
        });
        Ok(server)
    }

    /// A server that never started (the bind failed): every URL is refused.
    pub fn disabled() -> Self {
        Self {
            port: 0,
            token: new_token().into(),
            roots: Arc::default(),
        }
    }

    /// Serve files under `path` (a folder). The id names it in URLs.
    pub fn register(&self, path: &Path) -> Result<String, String> {
        let root = std::fs::canonicalize(path)
            .map_err(|e| format!("Can't serve {}: {e}", path.display()))?;
        if !root.is_dir() {
            return Err(format!("{} is not a folder.", path.display()));
        }
        let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        if let Ok(mut r) = self.roots.lock() {
            r.by_id.insert(id.clone(), root);
        }
        Ok(id)
    }

    pub fn release(&self, id: &str) {
        if let Ok(mut r) = self.roots.lock() {
            r.by_id.remove(id);
        }
    }

    /// The URL of `rel_path` under root `id`.
    pub fn url(&self, id: &str, rel_path: &str) -> Result<String, String> {
        if self.port == 0 {
            return Err(
                "Playing files from disk is not available: the media server did not start.".into(),
            );
        }
        let known = self.roots.lock().is_ok_and(|r| r.by_id.contains_key(id));
        if !known {
            return Err("That folder is not open for playing any more.".into());
        }
        let rel: Vec<String> = rel_path
            .split(['/', '\\'])
            .filter(|s| !s.is_empty())
            .map(|s| urlencoding::encode(s).into_owned())
            .collect();
        Ok(format!(
            "http://127.0.0.1:{}/m/{}/{id}/{}",
            self.port,
            self.token,
            rel.join("/")
        ))
    }

    /// The file a request path names, if it is one this server may serve.
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let rest = path.strip_prefix("/m/")?;
        let (token, rest) = rest.split_once('/')?;
        if !constant_time_eq(token.as_bytes(), self.token.as_bytes()) {
            return None;
        }
        let (id, rel) = rest.split_once('/')?;
        let root = self.roots.lock().ok()?.by_id.get(id)?.clone();
        let mut file = root.clone();
        for seg in rel.split('/') {
            let seg = urlencoding::decode(seg).ok()?;
            if seg.is_empty() || seg == "." || seg == ".." || seg.contains(['/', '\\']) {
                return None;
            }
            file.push(seg.as_ref());
        }
        let real = std::fs::canonicalize(&file).ok()?;
        (real.starts_with(&root) && real.is_file()).then_some(real)
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn router(server: MediaServer) -> axum::Router {
    axum::Router::new().fallback(move |req: Request<Body>| {
        let server = server.clone();
        async move { serve(&server, req).await }
    })
}

fn status(code: StatusCode) -> Response<Body> {
    Response::builder()
        .status(code)
        .body(Body::empty())
        .unwrap_or_default()
}

/// The `Content-Type` for a file's extension.
pub fn mime_of(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        _ => "application/octet-stream",
    }
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` of a `len`-byte file, as an
/// inclusive range; `Err` when it can't be met. Only the first of several.
pub fn parse_range(value: &str, len: u64) -> Result<(u64, u64), ()> {
    let spec = value.trim().strip_prefix("bytes=").ok_or(())?;
    let first = spec.split(',').next().ok_or(())?.trim();
    let (a, b) = first.split_once('-').ok_or(())?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().map_err(|_| ())?;
            if n == 0 {
                return Err(());
            }
            (len.saturating_sub(n), len.checked_sub(1).ok_or(())?)
        }
        (a, "") => (a.parse().map_err(|_| ())?, len.checked_sub(1).ok_or(())?),
        (a, b) => {
            let (a, b): (u64, u64) = (a.parse().map_err(|_| ())?, b.parse().map_err(|_| ())?);
            (a, b.min(len.saturating_sub(1)))
        }
    };
    if start > end || start >= len {
        return Err(());
    }
    Ok((start, end))
}

/// Whether the request's `Host` is this loopback server.
fn host_ok(headers: &HeaderMap, port: u16) -> bool {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"))
}

async fn serve(server: &MediaServer, req: Request<Body>) -> Response<Body> {
    let head = req.method() == Method::HEAD;
    if !head && req.method() != Method::GET {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    if !host_ok(req.headers(), server.port) {
        return status(StatusCode::NOT_FOUND);
    }
    let Some(file) = server.resolve(req.uri().path()) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Ok(len) = tokio::fs::metadata(&file).await.map(|m| m.len()) else {
        return status(StatusCode::NOT_FOUND);
    };
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    let (code, start, end) = match range {
        None => (StatusCode::OK, 0, len.saturating_sub(1)),
        Some(r) => match parse_range(r, len) {
            Ok((a, b)) => (StatusCode::PARTIAL_CONTENT, a, b),
            Err(()) => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .body(Body::empty())
                    .unwrap_or_default();
            }
        },
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut resp = Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, mime_of(&file))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, count)
        .header(header::CACHE_CONTROL, "no-store");
    if code == StatusCode::PARTIAL_CONTENT {
        resp = resp.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    let body = if head || count == 0 {
        Body::empty()
    } else {
        match stream_file(&file, start, count).await {
            Ok(b) => b,
            Err(_) => return status(StatusCode::NOT_FOUND),
        }
    };
    resp.body(body).unwrap_or_default()
}

/// `count` bytes of `file` from `start`, read a chunk at a time.
async fn stream_file(file: &Path, start: u64, count: u64) -> std::io::Result<Body> {
    let mut f = tokio::fs::File::open(file).await?;
    f.seek(std::io::SeekFrom::Start(start)).await?;
    let stream = futures_util::stream::unfold((f, count), |(mut f, left)| async move {
        if left == 0 {
            return None;
        }
        let mut buf = vec![0u8; CHUNK.min(left as usize)];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(buf), (f, left - n as u64)))
            }
            Err(e) => Some((Err(e), (f, 0))),
        }
    });
    Ok(Body::from_stream(
        stream.map(|r| r.map(axum::body::Bytes::from)),
    ))
}

// Tauri commands

/// Serve the files in `path`, a folder, to this window's players.
#[tauri::command]
pub fn media_root_register(
    server: tauri::State<'_, MediaServer>,
    path: String,
) -> Result<String, String> {
    server.register(Path::new(&path))
}

#[tauri::command]
pub fn media_root_release(server: tauri::State<'_, MediaServer>, id: String) {
    server.release(&id);
}

/// The loopback URL a `<video>` plays `rel_path` under the root `root` from.
#[tauri::command]
pub fn media_url(
    server: tauri::State<'_, MediaServer>,
    root: String,
    rel_path: String,
) -> Result<String, String> {
    server.url(&root, &rel_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    async fn started() -> (MediaServer, crate::test_util::TestDir, String) {
        let server = MediaServer::start().unwrap();
        let dir = temp_dir("media_http");
        std::fs::create_dir_all(dir.join("root/sub")).unwrap();
        let bytes: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        std::fs::write(dir.join("root/sub/clip one.mp4"), &bytes).unwrap();
        std::fs::write(dir.join("secret.txt"), b"no").unwrap();
        let id = server.register(&dir.join("root")).unwrap();
        (server, dir, id)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn a_range_request_returns_the_exact_bytes() {
        let (server, _dir, id) = started().await;
        let url = server.url(&id, "sub/clip one.mp4").unwrap();
        assert!(url.contains("/sub/clip%20one.mp4"));
        let resp = client()
            .get(&url)
            .header("Range", "bytes=100-199")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 206);
        assert_eq!(resp.headers()["content-range"], "bytes 100-199/1000");
        assert_eq!(resp.headers()["content-type"], "video/mp4");
        assert!(resp.headers().get("access-control-allow-origin").is_none());
        let body = resp.bytes().await.unwrap();
        let want: Vec<u8> = (0..=255u8).cycle().skip(100).take(100).collect();
        assert_eq!(body.to_vec(), want);

        let whole = client().get(&url).send().await.unwrap();
        assert_eq!(whole.status(), 200);
        assert_eq!(whole.bytes().await.unwrap().len(), 1000);

        let tail = client()
            .get(&url)
            .header("Range", "bytes=-10")
            .send()
            .await
            .unwrap();
        assert_eq!(tail.headers()["content-range"], "bytes 990-999/1000");
        let past = client()
            .get(&url)
            .header("Range", "bytes=5000-")
            .send()
            .await
            .unwrap();
        assert_eq!(past.status(), 416);
        let head = client().head(&url).send().await.unwrap();
        assert_eq!(head.headers()["content-length"], "1000");
    }

    #[tokio::test]
    async fn a_wrong_token_an_escape_or_a_released_root_is_404() {
        let (server, _dir, id) = started().await;
        let good = server.url(&id, "sub/clip one.mp4").unwrap();
        let bad_token = good.replace(&*server.token, &"0".repeat(64));
        assert_eq!(client().get(&bad_token).send().await.unwrap().status(), 404);
        let base = format!("http://127.0.0.1:{}/m/{}/{id}", server.port, server.token);
        for escape in [
            "/../secret.txt",
            "/sub/%2e%2e/%2e%2e/secret.txt",
            "/sub%2F..%2F..%2Fsecret.txt",
        ] {
            let r = client()
                .get(format!("{base}{escape}"))
                .send()
                .await
                .unwrap();
            assert_eq!(r.status(), 404, "{escape}");
        }
        let unknown = good.replace(&id, "000000000000");
        assert_eq!(client().get(&unknown).send().await.unwrap().status(), 404);
        server.release(&id);
        assert_eq!(client().get(&good).send().await.unwrap().status(), 404);
        assert!(server.url(&id, "sub/clip one.mp4").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_link_out_of_the_root_is_404() {
        let (server, dir, id) = started().await;
        std::os::unix::fs::symlink(dir.join("secret.txt"), dir.join("root/link.txt")).unwrap();
        let url = server.url(&id, "link.txt").unwrap();
        assert_eq!(client().get(&url).send().await.unwrap().status(), 404);
    }

    #[tokio::test]
    async fn another_host_is_refused() {
        let (server, _dir, id) = started().await;
        let url = server.url(&id, "sub/clip one.mp4").unwrap();
        let r = client()
            .get(&url)
            .header("Host", "evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 404);
    }

    /// Serve a folder for a browser to play, printing each file's URL:
    /// `HARUSPEX_MEDIA_DIR=/dir cargo test -- --ignored serve_a_folder --nocapture`.
    #[tokio::test]
    #[ignore = "serves a folder for 90 s"]
    async fn serve_a_folder_for_a_browser() {
        let dir = std::env::var("HARUSPEX_MEDIA_DIR").expect("set HARUSPEX_MEDIA_DIR");
        let server = MediaServer::start().unwrap();
        let id = server.register(Path::new(&dir)).unwrap();
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            println!("URL {}", server.url(&id, &name).unwrap());
        }
        tokio::time::sleep(std::time::Duration::from_secs(90)).await;
    }

    #[test]
    fn ranges_parse() {
        assert_eq!(parse_range("bytes=0-0", 10), Ok((0, 0)));
        assert_eq!(parse_range("bytes=5-", 10), Ok((5, 9)));
        assert_eq!(parse_range("bytes=2-100", 10), Ok((2, 9)));
        assert_eq!(parse_range("bytes=-3", 10), Ok((7, 9)));
        assert_eq!(parse_range("bytes=1-2,5-6", 10), Ok((1, 2)));
        assert!(parse_range("bytes=9-3", 10).is_err());
        assert!(parse_range("bytes=10-", 10).is_err());
        assert!(parse_range("items=0-1", 10).is_err());
        assert!(parse_range("bytes=0-", 0).is_err());
    }
}
