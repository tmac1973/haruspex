//! The `haruspex-notebook-file://` URI scheme: serves one notebook file by
//! hash, in the path as `haruspex-img` does (see `image_cache::protocol` on
//! why the hash is never the host).

use crate::blob_cache::is_valid_hash;
use crate::db::Database;
use log::debug;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

pub fn handle(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(hash) = request
        .uri()
        .path()
        .rsplit('/')
        .next()
        .filter(|h| is_valid_hash(h))
        .map(String::from)
    else {
        return empty(StatusCode::BAD_REQUEST);
    };
    match load(app, &hash) {
        Ok((mime, bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, bytes.len())
            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .body(bytes)
            .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
        Err(status) => empty(status),
    }
}

/// A kept file's type and bytes, by an already validated hash.
pub fn load(app: &AppHandle, hash: &str) -> Result<(String, Vec<u8>), StatusCode> {
    let db = app.state::<Database>();
    let mime = match db.notebook_file_mime(hash) {
        Ok(Some(m)) => m,
        Ok(None) => return Err(StatusCode::NOT_FOUND),
        Err(e) => {
            debug!("notebook file lookup failed for {hash}: {e}");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let dir = super::dir(app).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let bytes = std::fs::read(dir.join(hash)).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((mime, bytes))
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}
