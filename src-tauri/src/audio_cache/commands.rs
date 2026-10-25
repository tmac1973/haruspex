//! Tauri commands over the audio cache.
//!
//! Generated audio arrives by URL (a finished job on the server that made
//! it), so the store command downloads it here and streams it to disk: a
//! 40 MB WAV never crosses IPC as a number array.

use super::{cache_dir, clear_unlinked, commit_file, link_best_effort, normalize_mime, StoreMeta};
use super::{sweep_orphans, MAX_AUDIO_BYTES};
use crate::db::{AudioRow, Database};
use crate::image_cache::is_valid_hash;
use log::debug;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, State};

/// How long one download may take, start to finish.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// What a store returns: enough to build the player.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct StoredAudio {
    pub hash: String,
    pub mime: String,
    #[ts(type = "number")]
    pub bytes: u64,
}

/// Download `url` into the cache and link it to the chat or Code session
/// that made it.
///
/// `api_key`, when not empty, goes as a Bearer token: the server that made
/// the audio is usually the one serving it. The type comes from the
/// response's `Content-Type`, else `mime_hint`, and must be an audio type
/// the cache stores.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn audio_store_url(
    app: AppHandle,
    db: State<'_, Database>,
    url: String,
    api_key: Option<String>,
    mime_hint: Option<String>,
    title: Option<String>,
    conversation_id: Option<String>,
    code_session_id: Option<String>,
) -> Result<StoredAudio, String> {
    let dir = cache_dir(&app)?;
    let fetched = download(
        crate::comfy::lan_client(),
        &url,
        api_key.as_deref().unwrap_or(""),
        &dir,
    )
    .await?;
    store_download(
        &db,
        &dir,
        fetched,
        mime_hint.as_deref(),
        title,
        conversation_id.as_deref(),
        code_session_id.as_deref(),
    )
}

/// A finished download sitting in a temp file in the cache directory.
pub struct Downloaded {
    temp: PathBuf,
    hash: String,
    bytes: u64,
    content_type: Option<String>,
}

/// Stream `url` into a temp file in `dir`, hashing as it goes. Refuses an
/// empty body or one over [`MAX_AUDIO_BYTES`], leaving nothing on disk.
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    dir: &Path,
) -> Result<Downloaded, String> {
    let mut req = client.get(url).timeout(DOWNLOAD_TIMEOUT);
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key.trim());
    }
    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("Could not download the audio: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "The server refused the audio download ({}).",
            resp.status()
        ));
    }
    if resp.content_length().is_some_and(|n| n > MAX_AUDIO_BYTES) {
        return Err(too_large());
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let temp = dir.join(temp_name());
    let result = async {
        let mut file =
            std::fs::File::create(&temp).map_err(|e| format!("Failed to write audio: {}", e))?;
        let mut hasher = Sha256::new();
        let mut bytes = 0u64;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("The audio download broke off: {}", e))?
        {
            bytes += chunk.len() as u64;
            if bytes > MAX_AUDIO_BYTES {
                return Err(too_large());
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write audio: {}", e))?;
        }
        if bytes == 0 {
            return Err("The server sent no audio.".to_string());
        }
        file.sync_all()
            .map_err(|e| format!("Failed to write audio: {}", e))?;
        Ok((crate::hash_util::hex(&hasher.finalize()), bytes))
    }
    .await;
    match result {
        Ok((hash, bytes)) => Ok(Downloaded {
            temp,
            hash,
            bytes,
            content_type,
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            Err(e)
        }
    }
}

/// Commit a download to the cache: check its type, then move, insert, link.
pub fn store_download(
    db: &Database,
    dir: &Path,
    fetched: Downloaded,
    mime_hint: Option<&str>,
    title: Option<String>,
    conversation_id: Option<&str>,
    code_session_id: Option<&str>,
) -> Result<StoredAudio, String> {
    let mime = fetched
        .content_type
        .as_deref()
        .and_then(normalize_mime)
        .or_else(|| mime_hint.and_then(normalize_mime));
    let Some(mime) = mime else {
        let _ = std::fs::remove_file(&fetched.temp);
        return Err(format!(
            "The server sent {}, not audio this cache stores (mp3, wav, ogg, flac).",
            fetched.content_type.as_deref().unwrap_or("no content type")
        ));
    };
    let meta = StoreMeta {
        mime,
        title,
        duration_ms: None,
        conversation_id,
        code_session_id,
    };
    commit_file(db, dir, &fetched.temp, &fetched.hash, fetched.bytes, &meta)?;
    debug!("stored audio {}", fetched.hash);
    Ok(StoredAudio {
        hash: fetched.hash,
        mime: mime.to_string(),
        bytes: fetched.bytes,
    })
}

fn too_large() -> String {
    format!(
        "The audio is over the {} MB cache limit.",
        MAX_AUDIO_BYTES / (1024 * 1024)
    )
}

/// A temp file name no other download in this process is using.
fn temp_name() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        "dl-{}-{}.part",
        crate::time_util::now_ms(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

/// The audio a chat's or Code session's messages show by hash, linked to it
/// so the sweep keeps it. Unknown and malformed hashes are skipped.
#[tauri::command]
pub async fn audio_rehydrate(
    db: State<'_, Database>,
    hashes: Vec<String>,
    conversation_id: Option<String>,
    code_session_id: Option<String>,
) -> Result<Vec<AudioRow>, String> {
    rehydrate(
        &db,
        &hashes,
        conversation_id.as_deref(),
        code_session_id.as_deref(),
    )
}

pub fn rehydrate(
    db: &Database,
    hashes: &[String],
    conversation_id: Option<&str>,
    code_session_id: Option<&str>,
) -> Result<Vec<AudioRow>, String> {
    let mut rows = Vec::new();
    for hash in hashes.iter().filter(|h| is_valid_hash(h)) {
        if let Some(row) = db.audio_by_hash(hash)? {
            link_best_effort(db, conversation_id, code_session_id, hash);
            rows.push(row);
        }
    }
    Ok(rows)
}

/// One cached file's bytes, for writing a song into a project
/// (`generate_music` with a `path`). As a raw response, not a number array.
#[tauri::command]
pub async fn audio_read_bytes(
    app: AppHandle,
    db: State<'_, Database>,
    hash: String,
) -> Result<tauri::ipc::Response, String> {
    read_bytes(&db, &cache_dir(&app)?, &hash).map(tauri::ipc::Response::new)
}

pub fn read_bytes(db: &Database, dir: &Path, hash: &str) -> Result<Vec<u8>, String> {
    if !is_valid_hash(hash) || db.audio_by_hash(hash)?.is_none() {
        return Err("Audio not found".into());
    }
    let path = super::audio_path(dir, hash);
    let len = std::fs::metadata(&path)
        .map_err(|_| "Audio not found".to_string())?
        .len();
    if len > MAX_AUDIO_BYTES {
        return Err(too_large());
    }
    std::fs::read(&path).map_err(|e| format!("Could not read the audio: {e}"))
}

/// Bytes the cache holds, linked or not.
#[tauri::command]
pub async fn audio_cache_size(db: State<'_, Database>) -> Result<i64, String> {
    db.audio_total_bytes()
}

/// Delete every unlinked file now. Linked audio stays.
#[tauri::command]
pub async fn audio_cache_clear(app: AppHandle, db: State<'_, Database>) -> Result<(), String> {
    clear_unlinked(&db, &cache_dir(&app)?)
}

/// The startup sweep, on demand.
#[tauri::command]
pub async fn audio_sweep(app: AppHandle, db: State<'_, Database>) -> Result<(), String> {
    sweep_orphans(&db, &cache_dir(&app)?, crate::time_util::now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;
    use axum::http::header::CONTENT_TYPE;
    use axum::routing::get;

    /// A server with `/song` (a small mp3), `/page` (HTML), `/big` (over the
    /// limit, with no length up front), `/empty` and `/secret` (needs a key).
    async fn serve() -> String {
        let app = axum::Router::new()
            .route(
                "/song",
                get(|| async { ([(CONTENT_TYPE, "audio/mpeg")], vec![7u8; 1024]) }),
            )
            .route(
                "/page",
                get(|| async { ([(CONTENT_TYPE, "text/html")], "<html>") }),
            )
            .route(
                "/big",
                get(|| async {
                    let chunk = vec![0u8; 1024 * 1024];
                    let chunks = (0..60).map(move |_| Ok::<_, std::io::Error>(chunk.clone()));
                    (
                        [(CONTENT_TYPE, "audio/wav")],
                        axum::body::Body::from_stream(futures_util::stream::iter(chunks)),
                    )
                }),
            )
            .route(
                "/empty",
                get(|| async { ([(CONTENT_TYPE, "audio/mpeg")], Vec::<u8>::new()) }),
            )
            .route(
                "/secret",
                get(|headers: axum::http::HeaderMap| async move {
                    if headers.get("authorization").and_then(|v| v.to_str().ok())
                        == Some("Bearer k")
                    {
                        Ok(([(CONTENT_TYPE, "audio/wav")], vec![1u8; 10]))
                    } else {
                        Err(axum::http::StatusCode::UNAUTHORIZED)
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn setup(name: &str) -> (Database, crate::test_util::TestDir) {
        let db = Database::open_in_memory();
        db.create_conversation("chat-1", "Chat").unwrap();
        (db, temp_dir(name))
    }

    fn files(dir: &Path) -> usize {
        std::fs::read_dir(dir).unwrap().count()
    }

    #[tokio::test]
    async fn a_song_is_downloaded_stored_and_linked() {
        let base = serve().await;
        let (db, dir) = setup("audio-dl");
        let client = reqwest::Client::new();
        let got = download(&client, &format!("{base}/song"), "", &dir)
            .await
            .unwrap();
        let stored = store_download(
            &db,
            &dir,
            got,
            None,
            Some("Rain".into()),
            Some("chat-1"),
            None,
        )
        .unwrap();
        assert_eq!(stored.mime, "audio/mpeg");
        assert_eq!(stored.bytes, 1024);
        let row = db.audio_by_hash(&stored.hash).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("Rain"));
        assert_eq!(files(&dir), 1, "only the cached file, no .part");
    }

    #[tokio::test]
    async fn too_large_or_empty_bodies_leave_nothing_behind() {
        let base = serve().await;
        let (_db, dir) = setup("audio-dl-big");
        let client = reqwest::Client::new();
        let big = download(&client, &format!("{base}/big"), "", &dir).await;
        assert!(big.err().unwrap().contains("50 MB"));
        let empty = download(&client, &format!("{base}/empty"), "", &dir).await;
        assert!(empty.is_err());
        assert_eq!(files(&dir), 0);
    }

    #[tokio::test]
    async fn a_body_that_is_not_audio_is_refused() {
        let base = serve().await;
        let (db, dir) = setup("audio-dl-html");
        let client = reqwest::Client::new();
        let got = download(&client, &format!("{base}/page"), "", &dir)
            .await
            .unwrap();
        let err = store_download(&db, &dir, got, None, None, None, None).unwrap_err();
        assert!(err.contains("text/html"), "{err}");
        assert_eq!(files(&dir), 0);
    }

    #[tokio::test]
    async fn the_key_goes_as_a_bearer_token() {
        let base = serve().await;
        let (_db, dir) = setup("audio-dl-key");
        let client = reqwest::Client::new();
        assert!(download(&client, &format!("{base}/secret"), "", &dir)
            .await
            .is_err());
        assert!(download(&client, &format!("{base}/secret"), "k", &dir)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn stored_bytes_read_back_and_unknown_hashes_do_not() {
        let base = serve().await;
        let (db, dir) = setup("audio-read");
        let client = reqwest::Client::new();
        let got = download(&client, &format!("{base}/song"), "", &dir)
            .await
            .unwrap();
        let stored = store_download(&db, &dir, got, None, None, None, None).unwrap();
        assert_eq!(
            read_bytes(&db, &dir, &stored.hash).unwrap(),
            vec![7u8; 1024]
        );
        assert_eq!(
            read_bytes(&db, &dir, &"f".repeat(64)).unwrap_err(),
            "Audio not found"
        );
        assert_eq!(
            read_bytes(&db, &dir, "../x").unwrap_err(),
            "Audio not found"
        );
    }

    #[tokio::test]
    async fn rehydrating_links_what_exists_and_skips_the_rest() {
        let base = serve().await;
        let (db, dir) = setup("audio-rehydrate");
        let client = reqwest::Client::new();
        let got = download(&client, &format!("{base}/song"), "", &dir)
            .await
            .unwrap();
        let stored = store_download(&db, &dir, got, None, None, None, None).unwrap();
        let rows = rehydrate(
            &db,
            &[stored.hash.clone(), "f".repeat(64), "../x".into()],
            Some("chat-1"),
            None,
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        let later = crate::time_util::now_ms() + 2 * super::super::UNLINKED_GRACE_MS;
        sweep_orphans(&db, &dir, later).unwrap();
        assert!(
            db.audio_by_hash(&stored.hash).unwrap().is_some(),
            "linked by the rehydrate"
        );
    }
}
