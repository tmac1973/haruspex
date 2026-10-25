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
        Ok((hash, bytes)) => {
            let fetched = Downloaded {
                temp,
                hash,
                bytes,
                content_type,
            };
            match multipart_boundary(fetched.content_type.as_deref()) {
                Some(boundary) => keep_audio_part(fetched, &boundary, dir),
                None => Ok(fetched),
            }
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            Err(e)
        }
    }
}

/// The boundary of a `multipart/*` type, which ace-server's `/synth` result
/// is: the song, then its latent.
fn multipart_boundary(content_type: Option<&str>) -> Option<String> {
    let ct = content_type?;
    let (kind, params) = ct.split_once(';')?;
    if !kind.trim().to_ascii_lowercase().starts_with("multipart/") {
        return None;
    }
    params.split(';').find_map(|p| {
        let (k, v) = p.split_once('=')?;
        let v = v.trim().trim_matches('"');
        (k.trim().eq_ignore_ascii_case("boundary") && !v.is_empty()).then(|| v.to_string())
    })
}

/// The first `audio/*` part of a multipart body, and its type.
fn first_audio_part<'a>(body: &'a [u8], boundary: &str) -> Option<(&'a [u8], String)> {
    let delim = format!("--{boundary}").into_bytes();
    let find = |from: usize| {
        body.get(from..)?
            .windows(delim.len())
            .position(|w| w == delim.as_slice())
            .map(|i| from + i)
    };
    let mut at = find(0)?;
    while let Some(next) = find(at + delim.len()) {
        let part = &body[at + delim.len()..next];
        let part = part.strip_prefix(b"\r\n").unwrap_or(part);
        let part = part.strip_suffix(b"\r\n").unwrap_or(part);
        if let Some(split) = part.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&part[..split]);
            let kind = headers.lines().find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.trim()
                    .eq_ignore_ascii_case("content-type")
                    .then(|| v.trim().to_string())
            });
            if let Some(kind) = kind.filter(|k| k.to_ascii_lowercase().starts_with("audio/")) {
                return Some((&part[split + 4..], kind));
            }
        }
        at = next;
    }
    None
}

/// Swap a multipart download for its audio part, in a temp file of its own.
fn keep_audio_part(fetched: Downloaded, boundary: &str, dir: &Path) -> Result<Downloaded, String> {
    let read = std::fs::read(&fetched.temp);
    let _ = std::fs::remove_file(&fetched.temp);
    let body = read.map_err(|e| format!("Failed to read the audio: {}", e))?;
    let Some((audio, kind)) = first_audio_part(&body, boundary).filter(|(a, _)| !a.is_empty())
    else {
        return Err("The server's answer holds no audio.".to_string());
    };
    let temp = dir.join(temp_name());
    if let Err(e) = std::fs::write(&temp, audio) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Failed to write audio: {}", e));
    }
    Ok(Downloaded {
        temp,
        hash: crate::hash_util::hex(&Sha256::digest(audio)),
        bytes: audio.len() as u64,
        content_type: Some(kind),
    })
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

/// Copy a cached song to `path`, the file the user chose in a save dialog
/// (the player's Save as). The dialog asked about replacing a file already.
#[tauri::command]
pub async fn audio_save_as(
    app: AppHandle,
    db: State<'_, Database>,
    hash: String,
    path: String,
) -> Result<(), String> {
    save_as(&db, &cache_dir(&app)?, &hash, Path::new(&path))
}

pub fn save_as(db: &Database, dir: &Path, hash: &str, to: &Path) -> Result<(), String> {
    if !is_valid_hash(hash) || db.audio_by_hash(hash)?.is_none() {
        return Err("Audio not found".into());
    }
    std::fs::copy(super::audio_path(dir, hash), to)
        .map(|_| ())
        .map_err(|e| format!("Could not save the song to {}: {e}", to.display()))
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
                "/synth",
                get(|| async {
                    let mut body = b"--b\r\nContent-Type: audio/mpeg\r\n\r\n".to_vec();
                    body.extend([7u8; 1024]);
                    body.extend(b"\r\n--b\r\nContent-Type: application/octet-stream\r\n");
                    body.extend(b"Content-Disposition: form-data; name=\"latent\"\r\n\r\n");
                    body.extend([9u8; 64]);
                    body.extend(b"\r\n--b--\r\n");
                    ([(CONTENT_TYPE, "multipart/mixed; boundary=b")], body)
                }),
            )
            .route(
                "/latent-only",
                get(|| async {
                    (
                        [(CONTENT_TYPE, "multipart/mixed; boundary=b")],
                        b"--b\r\nContent-Type: application/octet-stream\r\n\r\nxx\r\n--b--\r\n"
                            .to_vec(),
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
    async fn a_multipart_answer_keeps_only_its_audio_part() {
        let base = serve().await;
        let (db, dir) = setup("audio-dl-multipart");
        let client = reqwest::Client::new();
        let got = download(&client, &format!("{base}/synth"), "", &dir)
            .await
            .unwrap();
        let stored = store_download(&db, &dir, got, None, None, None, None).unwrap();
        assert_eq!(stored.mime, "audio/mpeg");
        assert_eq!(
            read_bytes(&db, &dir, &stored.hash).unwrap(),
            vec![7u8; 1024]
        );
        assert_eq!(files(&dir), 1, "only the cached file, no .part");

        let none = download(&client, &format!("{base}/latent-only"), "", &dir).await;
        assert!(none.err().unwrap().contains("no audio"));
        assert_eq!(files(&dir), 1);
    }

    #[test]
    fn the_boundary_is_read_from_a_multipart_type_only() {
        assert_eq!(
            multipart_boundary(Some("multipart/mixed; boundary=\"x y\"")).as_deref(),
            Some("x y")
        );
        assert_eq!(multipart_boundary(Some("audio/mpeg")), None);
        assert_eq!(multipart_boundary(Some("audio/mpeg; boundary=x")), None);
        assert_eq!(multipart_boundary(None), None);
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
    async fn save_as_copies_a_cached_song_and_nothing_else() {
        let base = serve().await;
        let (db, dir) = setup("audio-save-as");
        let client = reqwest::Client::new();
        let got = download(&client, &format!("{base}/song"), "", &dir)
            .await
            .unwrap();
        let stored = store_download(&db, &dir, got, None, None, None, None).unwrap();
        let out = temp_dir("audio-save-as-out");
        let to = out.join("song.mp3");
        save_as(&db, &dir, &stored.hash, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), vec![7u8; 1024]);
        assert_eq!(
            save_as(&db, &dir, &"f".repeat(64), &out.join("x.mp3")).unwrap_err(),
            "Audio not found"
        );
        assert_eq!(
            save_as(&db, &dir, "../x", &out.join("y.mp3")).unwrap_err(),
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
