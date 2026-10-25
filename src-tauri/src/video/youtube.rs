//! Uploading a render to YouTube, after the user has confirmed it.
//!
//! Sign-in is Haruspex's Google OAuth client with only the `youtube.upload`
//! scope (plus who signed in), separate from the Calendar sign-in, so signing
//! out of one leaves the other. The refresh token lives in the secret store.
//!
//! The upload is YouTube's resumable protocol: the metadata starts a session,
//! the file goes up in 16 MiB pieces, and after a dropped connection or a
//! server error the session is asked how much arrived and continues from
//! there. A thumbnail, when there is one, is set afterwards; a channel that
//! may not use custom thumbnails gets a problem reported, not a failed upload.

use crate::integrations::dav::google;
use crate::proxy::ProxyConfig;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub const REFRESH_KEY: &str = "youtube:refresh";
pub const EMAIL_KEY: &str = "youtube:email";

/// Pieces must be a multiple of 256 KiB.
pub const CHUNK: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeAccount {
    pub email: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Private,
    Unlisted,
    Public,
}

impl Visibility {
    pub fn api(self) -> &'static str {
        match self {
            Visibility::Private => "private",
            Visibility::Unlisted => "unlisted",
            Visibility::Public => "public",
        }
    }
}

/// What the user confirmed in the upload dialog.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct VideoMeta {
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub category_id: String,
    pub visibility: Visibility,
    pub made_for_kids: bool,
}

impl VideoMeta {
    fn resource(&self) -> serde_json::Value {
        serde_json::json!({
            "snippet": {
                "title": self.title,
                "description": self.description,
                "tags": self.tags,
                "categoryId": self.category_id,
            },
            "status": {
                "privacyStatus": self.visibility.api(),
                "selfDeclaredMadeForKids": self.made_for_kids,
            }
        })
    }
}

/// YouTube's limits, checked before anything is sent.
pub fn check_meta(meta: &VideoMeta) -> Vec<String> {
    let mut out = Vec::new();
    let title = meta.title.trim();
    if title.is_empty() || title.chars().count() > 100 {
        out.push("The title must be 1 to 100 characters.".into());
    }
    if title.contains(['<', '>']) || meta.description.contains(['<', '>']) {
        out.push("YouTube doesn't allow < or > in a title or description.".into());
    }
    if meta.description.len() > 5000 {
        out.push(format!(
            "The description is {} bytes; YouTube allows 5,000.",
            meta.description.len()
        ));
    }
    let tags: usize = meta.tags.iter().map(|t| t.chars().count() + 1).sum();
    if tags > 500 {
        out.push("The tags are over YouTube's 500 characters in all.".into());
    }
    out
}

/// Where the upload goes. Real by default; a local mock in tests.
#[derive(Clone)]
pub struct Endpoints {
    pub videos: String,
    pub thumbnails: String,
    /// Waits before each retry after a dropped piece.
    pub backoff: Vec<Duration>,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            videos: "https://www.googleapis.com/upload/youtube/v3/videos".into(),
            thumbnails: "https://www.googleapis.com/upload/youtube/v3/thumbnails/set".into(),
            backoff: [2, 4, 8, 16, 32].map(Duration::from_secs).to_vec(),
        }
    }
}

type TokenFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
/// An access token; `true` asks for a fresh one (after a 401).
pub type Auth = Arc<dyn Fn(bool) -> TokenFuture + Send + Sync>;

/// The signed-in account's tokens.
pub fn account_auth(refresh: String, proxy: Option<ProxyConfig>) -> Auth {
    Arc::new(move |fresh| {
        let (refresh, proxy) = (refresh.clone(), proxy.clone());
        Box::pin(async move {
            if fresh {
                google::forget_access_token(&refresh);
            }
            google::access_token(&refresh, proxy.as_ref()).await
        })
    })
}

/// How far a resumable session has got: `Range: bytes=0-N` → N + 1.
fn received(resp: &reqwest::Response) -> u64 {
    resp.headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(|r| r.rsplit('-').next())
        .and_then(|n| n.parse::<u64>().ok())
        .map_or(0, |n| n + 1)
}

fn google_error(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("YouTube said {status}: {message}")
}

/// What one attempt at a piece came to.
enum Step {
    /// The session holds this many bytes now.
    At(u64),
    Done(String),
    /// Worth retrying: a dropped connection or a server error.
    Retry(String),
    Unauthorized,
}

async fn put_piece(
    http: &reqwest::Client,
    session: &str,
    token: &str,
    body: Option<(u64, Vec<u8>)>,
    total: u64,
) -> Step {
    let mut req = http.put(session).bearer_auth(token);
    req = match body {
        Some((start, bytes)) => {
            let end = start + bytes.len() as u64 - 1;
            req.header("Content-Range", format!("bytes {start}-{end}/{total}"))
                .header("Content-Length", bytes.len())
                .body(bytes)
        }
        // "How much do you have?"
        None => req
            .header("Content-Range", format!("bytes */{total}"))
            .header("Content-Length", 0),
    };
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return Step::Retry(e.without_url().to_string()),
    };
    let status = resp.status();
    if status.as_u16() == 308 {
        return Step::At(received(&resp));
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Step::Unauthorized;
    }
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        return match serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["id"].as_str().map(str::to_string))
        {
            Some(id) => Step::Done(id),
            None => Step::Retry("YouTube's answer had no video id".into()),
        };
    }
    if status.is_server_error() {
        return Step::Retry(google_error(status, &text));
    }
    Step::Retry(format!("fatal:{}", google_error(status, &text)))
}

/// Upload `file` with `meta`; returns the video id. `cancelled` is checked
/// between pieces; `progress` gets bytes sent of the total.
pub async fn upload(
    http: &reqwest::Client,
    ep: &Endpoints,
    auth: &Auth,
    file: &Path,
    meta: &VideoMeta,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let total = std::fs::metadata(file)
        .map_err(|e| format!("can't read the render: {e}"))?
        .len();
    let mut token = auth(false).await?;
    let init = |token: String| {
        http.post(format!(
            "{}?uploadType=resumable&part=snippet,status",
            ep.videos
        ))
        .bearer_auth(token)
        .header("X-Upload-Content-Length", total)
        .header("X-Upload-Content-Type", "video/mp4")
        .json(&meta.resource())
        .send()
    };
    let mut resp = init(token.clone())
        .await
        .map_err(|e| format!("Could not reach YouTube: {}", e.without_url()))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        token = auth(true).await?;
        resp = init(token.clone())
            .await
            .map_err(|e| format!("Could not reach YouTube: {}", e.without_url()))?;
    }
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(google_error(status, &resp.text().await.unwrap_or_default()));
    }
    let session = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .ok_or("YouTube didn't start an upload session.")?
        .to_string();

    let mut f = tokio::fs::File::open(file)
        .await
        .map_err(|e| format!("can't read the render: {e}"))?;
    let mut at = 0u64;
    let mut retries = 0usize;
    let mut refreshed = false;
    loop {
        if cancelled() {
            return Err("Upload cancelled.".into());
        }
        let len = CHUNK.min(total - at);
        let mut buf = vec![0u8; len as usize];
        f.seek(std::io::SeekFrom::Start(at))
            .await
            .map_err(|e| e.to_string())?;
        f.read_exact(&mut buf)
            .await
            .map_err(|e| format!("can't read the render: {e}"))?;
        let mut step = put_piece(http, &session, &token, Some((at, buf)), total).await;
        // After a failure, ask the session where it got to before sending more.
        while let Step::Retry(why) = &step {
            if let Some(fatal) = why.strip_prefix("fatal:") {
                return Err(fatal.to_string());
            }
            let Some(wait) = ep.backoff.get(retries) else {
                return Err(format!("The upload kept failing: {why}"));
            };
            retries += 1;
            tokio::time::sleep(*wait).await;
            if cancelled() {
                return Err("Upload cancelled.".into());
            }
            step = put_piece(http, &session, &token, None, total).await;
        }
        match step {
            Step::Done(id) => {
                progress(total, total);
                return Ok(id);
            }
            Step::At(n) => {
                at = n;
                progress(at, total);
            }
            Step::Unauthorized if !refreshed => {
                refreshed = true;
                token = auth(true).await?;
            }
            Step::Unauthorized => {
                return Err(
                    "YouTube refused the sign-in. Sign in again in Settings → Video.".into(),
                )
            }
            Step::Retry(_) => unreachable!("retries are handled above"),
        }
    }
}

/// Set a video's thumbnail. Errors are for the report, not for failing.
pub async fn set_thumbnail(
    http: &reqwest::Client,
    ep: &Endpoints,
    auth: &Auth,
    video_id: &str,
    jpeg: Vec<u8>,
) -> Result<(), String> {
    let token = auth(false).await?;
    let resp = http
        .post(format!("{}?videoId={video_id}", ep.thumbnails))
        .bearer_auth(token)
        .header("Content-Type", "image/jpeg")
        .body(jpeg)
        .send()
        .await
        .map_err(|e| format!("Could not set the thumbnail: {}", e.without_url()))?;
    if resp.status().is_success() {
        return Ok(());
    }
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    Err(format!(
        "The thumbnail wasn't set. {}",
        google_error(status, &text)
    ))
}

/// The signed-in account, if any.
pub async fn account() -> Option<YoutubeAccount> {
    let email = crate::secrets::get(EMAIL_KEY).await.ok().flatten()?;
    crate::secrets::get(REFRESH_KEY).await.ok().flatten()?;
    Some(YoutubeAccount { email })
}

pub async fn sign_in(proxy: Option<&ProxyConfig>) -> Result<YoutubeAccount, String> {
    let consent = google::consent(google::YOUTUBE_SCOPES, proxy).await?;
    if !google::granted(&consent.granted, google::YOUTUBE_UPLOAD_SCOPE) {
        google::revoke(&consent.refresh_token, proxy).await;
        return Err("Google didn't grant upload access. Sign in again and allow it.".into());
    }
    crate::secrets::secret_set(REFRESH_KEY.into(), consent.refresh_token).await?;
    crate::secrets::secret_set(EMAIL_KEY.into(), consent.email.clone()).await?;
    Ok(YoutubeAccount {
        email: consent.email,
    })
}

pub async fn sign_out(proxy: Option<&ProxyConfig>) -> Result<(), String> {
    if let Ok(Some(refresh)) = crate::secrets::get(REFRESH_KEY).await {
        google::revoke(&refresh, proxy).await;
    }
    crate::secrets::secret_delete(REFRESH_KEY.into()).await?;
    crate::secrets::secret_delete(EMAIL_KEY.into()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::{post, put};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Mock {
        received: Vec<u8>,
        total: u64,
        meta: Option<serde_json::Value>,
        /// Fail the Nth piece once, dropping what it carried.
        fail_piece: Option<usize>,
        pieces: usize,
        /// Answer the first piece with 401 once.
        unauthorized_once: bool,
        tokens: Vec<String>,
        thumbnail: Option<Vec<u8>>,
        thumbnail_status: u16,
    }

    type Shared = Arc<Mutex<Mock>>;

    async fn start(State(m): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
        let mut m = m.lock().unwrap();
        m.total = headers["x-upload-content-length"]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        m.meta = serde_json::from_slice(&body).ok();
        m.tokens
            .push(headers["authorization"].to_str().unwrap().to_string());
        let mut h = HeaderMap::new();
        let host = headers["host"].to_str().unwrap();
        h.insert(
            "location",
            format!("http://{host}/SESSION").parse().unwrap(),
        );
        (StatusCode::OK, h).into_response()
    }

    async fn piece(State(m): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
        let mut m = m.lock().unwrap();
        m.tokens
            .push(headers["authorization"].to_str().unwrap().to_string());
        let range = headers["content-range"].to_str().unwrap().to_string();
        if !range.starts_with("bytes */") {
            if m.unauthorized_once {
                m.unauthorized_once = false;
                return StatusCode::UNAUTHORIZED.into_response();
            }
            m.pieces += 1;
            if m.fail_piece == Some(m.pieces) {
                m.fail_piece = None;
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
            m.received.extend_from_slice(&body);
        }
        if m.received.len() as u64 == m.total {
            return (StatusCode::OK, r#"{"id":"vid123"}"#).into_response();
        }
        let mut h = HeaderMap::new();
        if !m.received.is_empty() {
            h.insert(
                "range",
                format!("bytes=0-{}", m.received.len() - 1).parse().unwrap(),
            );
        }
        (StatusCode::PERMANENT_REDIRECT, h).into_response()
    }

    async fn thumb(State(m): State<Shared>, body: Bytes) -> Response {
        let mut m = m.lock().unwrap();
        m.thumbnail = Some(body.to_vec());
        StatusCode::from_u16(m.thumbnail_status)
            .unwrap()
            .into_response()
    }

    async fn serve(mock: Mock) -> (Endpoints, Shared) {
        let shared: Shared = Arc::new(Mutex::new(mock));
        let app = axum::Router::new()
            .route("/videos", post(start))
            .route("/SESSION", put(piece))
            .route("/thumbs", post(thumb))
            .layer(axum::extract::DefaultBodyLimit::disable())
            .with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let base = format!("http://{addr}");
        let ep = Endpoints {
            videos: format!("{base}/videos"),
            thumbnails: format!("{base}/thumbs"),
            backoff: vec![Duration::from_millis(5); 5],
        };
        (ep, shared)
    }

    fn auth() -> Auth {
        let n = Arc::new(Mutex::new(0));
        Arc::new(move |fresh| {
            let n = n.clone();
            Box::pin(async move {
                let mut n = n.lock().unwrap();
                if fresh {
                    *n += 1;
                }
                Ok(format!("token{n}"))
            })
        })
    }

    fn meta() -> VideoMeta {
        VideoMeta {
            title: "Episode 12".into(),
            description: "0:00 Intro\n1:05 Building".into(),
            tags: vec!["games".into()],
            category_id: "22".into(),
            visibility: Visibility::Unlisted,
            made_for_kids: false,
        }
    }

    fn file(len: usize) -> (crate::test_util::TestDir, std::path::PathBuf, Vec<u8>) {
        let dir = crate::test_util::temp_dir("yt_upload");
        let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        let path = dir.join("render.mp4");
        std::fs::write(&path, &data).unwrap();
        (dir, path, data)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::new()
    }

    async fn run(ep: &Endpoints, path: &Path) -> Result<String, String> {
        upload(&client(), ep, &auth(), path, &meta(), &|| false, &|_, _| {}).await
    }

    #[tokio::test]
    async fn a_file_goes_up_in_pieces_with_its_metadata() {
        let (ep, shared) = serve(Mock::default()).await;
        let (_d, path, data) = file((CHUNK + 1000) as usize);
        let id = run(&ep, &path).await.unwrap();
        assert_eq!(id, "vid123");
        let m = shared.lock().unwrap();
        assert_eq!(m.received, data);
        assert_eq!(m.pieces, 2);
        let meta = m.meta.as_ref().unwrap();
        assert_eq!(meta["status"]["privacyStatus"], "unlisted");
        assert_eq!(meta["status"]["selfDeclaredMadeForKids"], false);
        assert_eq!(meta["snippet"]["title"], "Episode 12");
    }

    #[tokio::test]
    async fn a_dropped_piece_resumes_from_what_arrived() {
        let (ep, shared) = serve(Mock {
            fail_piece: Some(2),
            ..Default::default()
        })
        .await;
        let (_d, path, data) = file((2 * CHUNK + 10) as usize);
        assert_eq!(run(&ep, &path).await.unwrap(), "vid123");
        assert_eq!(shared.lock().unwrap().received, data);
    }

    #[tokio::test]
    async fn a_401_refreshes_the_token_once() {
        let (ep, shared) = serve(Mock {
            unauthorized_once: true,
            ..Default::default()
        })
        .await;
        let (_d, path, _) = file(1000);
        assert_eq!(run(&ep, &path).await.unwrap(), "vid123");
        let tokens = shared.lock().unwrap().tokens.clone();
        assert!(tokens.last().unwrap().ends_with("token1"), "{tokens:?}");
    }

    #[tokio::test]
    async fn a_refused_thumbnail_is_a_reported_problem() {
        let (ep, shared) = serve(Mock {
            thumbnail_status: 403,
            ..Default::default()
        })
        .await;
        let err = set_thumbnail(&client(), &ep, &auth(), "vid123", vec![1, 2, 3])
            .await
            .unwrap_err();
        assert!(err.contains("thumbnail wasn't set"), "{err}");
        assert_eq!(
            shared.lock().unwrap().thumbnail.as_deref(),
            Some(&[1u8, 2, 3][..])
        );
    }

    #[tokio::test]
    async fn cancelling_stops_before_the_next_piece() {
        let (ep, shared) = serve(Mock::default()).await;
        let (_d, path, _) = file((CHUNK + 10) as usize);
        let err = upload(
            &client(),
            &ep,
            &auth(),
            &path,
            &meta(),
            &|| true,
            &|_, _| {},
        )
        .await
        .unwrap_err();
        assert!(err.contains("cancelled"));
        assert_eq!(shared.lock().unwrap().pieces, 0);
    }

    #[test]
    fn metadata_limits_are_checked() {
        assert!(check_meta(&meta()).is_empty());
        let bad = VideoMeta {
            title: "<b>".into(),
            description: "x".repeat(5001),
            ..meta()
        };
        let p = check_meta(&bad);
        assert!(p.iter().any(|x| x.contains("< or >")));
        assert!(p.iter().any(|x| x.contains("5,000")));
    }
}
