//! The `haruspex-img://` URI scheme: serves one cached image by hash.
//!
//! Why a custom scheme rather than data: URLs over IPC — the alternative the
//! codebase already uses for `fs_read_image` thumbnails. A thumbnail is one
//! transient tool step; chat images persist for the life of a conversation,
//! and Svelte renders every message in it. Base64 for a 50-message chat would
//! sit in webview memory all at once. Streaming from disk keeps that flat.
//!
//! **URL shape.** The hash goes in the *path*, never the host:
//!
//! ```text
//!   haruspex-img://localhost/<hash>          Linux, macOS
//!   http://haruspex-img.localhost/<hash>     Windows
//! ```
//!
//! A DNS label caps at 63 characters and our hash is 64, so a hash-as-host URL
//! is malformed and would be rejected or mangled before it ever reached this
//! handler. Tauri's own `asset://localhost/` scheme uses the same
//! host-plus-path shape for the same reason. Parsing the last path segment
//! works unchanged across both platform forms.

use super::{cache_dir, image_path, is_valid_hash};
use crate::db::Database;
use log::debug;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

/// Serve one image. Every failure is a status code — a broken `<img>` at
/// worst, never a panic in the webview's resource loader.
pub fn handle(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(hash) = hash_from_path(request.uri().path()) else {
        return empty(StatusCode::BAD_REQUEST);
    };

    let db = app.state::<Database>();
    let row = match db.image_by_hash(&hash) {
        Ok(Some(row)) => row,
        Ok(None) => return empty(StatusCode::NOT_FOUND),
        Err(e) => {
            debug!("image lookup failed for {}: {}", hash, e);
            return empty(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };

    let dir = match cache_dir(app) {
        Ok(dir) => dir,
        Err(e) => {
            debug!("image cache dir unavailable: {}", e);
            return empty(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };

    let bytes = match std::fs::read(image_path(&dir, &hash)) {
        Ok(bytes) => bytes,
        // A row without its file: the sweep will collect it on next launch.
        // Until then this is simply an image that does not render.
        Err(e) => {
            debug!("cached image file missing for {}: {}", hash, e);
            return empty(StatusCode::NOT_FOUND);
        }
    };

    // Display counts as use. Without this, eviction would rank an image
    // fetched once and viewed daily below one fetched yesterday and never
    // looked at. Failure here is not worth failing the response over.
    if let Err(e) = db.touch_images(std::slice::from_ref(&hash)) {
        debug!("failed to touch image {}: {}", hash, e);
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, row.mime)
        .header(header::CONTENT_LENGTH, bytes.len())
        // Content-addressed bytes never change, so a viewer should never
        // re-request one it already holds.
        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
        // The app sets Cross-Origin-Embedder-Policy: credentialless, which
        // blocks cross-origin subresources that do not opt in. A custom scheme
        // is a different origin from the page, so without this every image is
        // silently blocked by COEP — the same reason sandbox_fetch sets it.
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(bytes)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

/// Pull the hash out of a request path, rejecting anything that is not exactly
/// 64 lowercase hex characters.
///
/// This is the path-traversal guard. Because the shape is checked before the
/// value is ever joined to the cache directory, `..`, separators and absolute
/// paths cannot survive it — so the caller may treat the result as a safe
/// filename with no further sanitising.
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
    fn accepts_a_real_hash_in_either_platform_url_shape() {
        let hash = "0123456789abcdef".repeat(4);
        // Linux/macOS: haruspex-img://localhost/<hash>
        assert_eq!(hash_from_path(&format!("/{hash}")), Some(hash.clone()));
        // Windows: http://haruspex-img.localhost/<hash> — same path.
        assert_eq!(
            hash_from_path(&format!("/{hash}")).as_deref(),
            Some(hash.as_str())
        );
    }

    #[test]
    fn rejects_traversal_and_malformed_hashes() {
        for path in [
            "/../../etc/passwd",
            "/..%2f..%2fetc%2fpasswd",
            "/",
            "",
            "/short",
            // Uppercase is not the shape we emit; refusing it keeps exactly
            // one spelling of any given path.
            &format!("/{}", "A".repeat(64)),
            &format!("/{}", "a".repeat(63)),
            &format!("/{}", "a".repeat(65)),
            &format!("/{}", "g".repeat(64)),
        ] {
            assert_eq!(hash_from_path(path), None, "should reject {path:?}");
        }
    }

    /// A path with extra segments still resolves to its last one, and that
    /// segment is validated — so a nested path cannot smuggle anything past.
    #[test]
    fn only_the_final_segment_is_considered_and_it_is_still_validated() {
        let hash = "a".repeat(64);
        assert_eq!(
            hash_from_path(&format!("/anything/else/{hash}")),
            Some(hash)
        );
        assert_eq!(hash_from_path("/deadbeef/../../secret"), None);
    }
}
