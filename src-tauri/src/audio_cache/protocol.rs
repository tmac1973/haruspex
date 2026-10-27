//! The `haruspex-audio://` URI scheme: serves one cached audio file by hash,
//! honouring `Range` so an `<audio>` element can seek.
//!
//! Same URL shape as `haruspex-img` (see `image_cache::protocol` for why the
//! hash is in the path):
//!
//! ```text
//!   haruspex-audio://localhost/<hash>          Linux, macOS
//!   http://haruspex-audio.localhost/<hash>     Windows
//! ```

use super::range::{self, Slice};
use super::{audio_path, cache_dir};
use crate::blob_cache::is_valid_hash;
use crate::db::Database;
use log::debug;
use std::path::PathBuf;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

/// Serve one file, or the part of it the request's `Range` names. Every
/// failure is a status code.
pub fn handle(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(hash) = hash_from_path(request.uri().path()) else {
        return empty(StatusCode::BAD_REQUEST);
    };
    let (mime, path) = match locate(app, &hash) {
        Ok(found) => found,
        Err(status) => return empty(status),
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    let slice = match range::read(&path, range) {
        Ok(slice) => slice,
        Err(e) => {
            debug!("cached audio unreadable for {}: {}", hash, e);
            return empty(StatusCode::NOT_FOUND);
        }
    };
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
        // COEP: credentialless blocks cross-origin subresources that do not
        // opt in; see image_cache::protocol.
        .header("Cross-Origin-Resource-Policy", "cross-origin");
    let response = match slice {
        Slice::Whole(bytes) => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(bytes),
        Slice::Part {
            bytes,
            start,
            end,
            total,
        } => builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total}"),
            )
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(bytes),
        Slice::Unsatisfiable { total } => builder
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .body(Vec::new()),
    };
    response.unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

/// One cached file's type and path, by an already validated hash, marked as
/// played. Also what Settings → Remote control's page is served from.
pub fn locate(app: &AppHandle, hash: &str) -> Result<(String, PathBuf), StatusCode> {
    let db = app.state::<Database>();
    let row = match db.audio_by_hash(hash) {
        Ok(Some(row)) => row,
        Ok(None) => return Err(StatusCode::NOT_FOUND),
        Err(e) => {
            debug!("audio lookup failed for {}: {}", hash, e);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let dir = cache_dir(app).map_err(|e| {
        debug!("audio cache dir unavailable: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let path = audio_path(&dir, hash);
    if !path.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    if let Err(e) = db.touch_audio(hash) {
        debug!("failed to touch audio {}: {}", hash, e);
    }
    Ok((row.mime, path))
}

/// The last path segment, if it is exactly a hash. The path-traversal guard.
fn hash_from_path(path: &str) -> Option<String> {
    let candidate = path.rsplit('/').next()?;
    is_valid_hash(candidate).then(|| candidate.to_string())
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_malformed_paths() {
        for path in [
            "/../../etc/passwd",
            "/",
            "",
            "/short",
            &format!("/{}", "A".repeat(64)),
        ] {
            assert_eq!(hash_from_path(path), None, "{path:?}");
        }
        let hash = "c".repeat(64);
        assert_eq!(hash_from_path(&format!("/{hash}")), Some(hash));
    }
}
