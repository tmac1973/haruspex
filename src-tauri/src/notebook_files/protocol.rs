//! The `haruspex-notebook-file://` URI scheme: serves one notebook file by
//! hash, in the path as `haruspex-img` does (see `image_cache::protocol` on
//! why the hash is never the host).

use crate::blob_cache::is_valid_hash;
use crate::db::Database;
use crate::protocol_util::empty;
use log::warn;
use tauri::http::{Request, Response, StatusCode};
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
        Ok((mime, bytes)) => crate::protocol_util::immutable(mime, bytes),
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
            warn!("notebook file lookup failed for {hash}: {e}");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let dir = super::dir(app).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let bytes = std::fs::read(dir.join(hash)).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((mime, bytes))
}
