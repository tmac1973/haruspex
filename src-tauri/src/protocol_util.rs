//! Responses shared by the custom URI scheme handlers (`haruspex-image:`,
//! `haruspex-audio:`, `haruspex-file:`).

use tauri::http::{header, Response, StatusCode};

/// A response with no body.
pub fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Content-addressed bytes, which never change: a viewer never asks for one
/// it already holds.
pub fn immutable(mime: String, bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
        // The app sets Cross-Origin-Embedder-Policy: credentialless, which
        // blocks cross-origin subresources that do not opt in. A custom scheme
        // is a different origin from the page, so without this every image is
        // silently blocked by COEP — the same reason sandbox_fetch sets it.
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(bytes)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_immutable_response_says_so_and_opts_in_to_cross_origin() {
        let r = immutable("image/png".into(), vec![1, 2, 3]);
        assert_eq!(r.status(), StatusCode::OK);
        let h = r.headers();
        assert_eq!(h[header::CONTENT_LENGTH], "3");
        assert_eq!(h[header::CACHE_CONTROL], "max-age=31536000, immutable");
        assert_eq!(h["Cross-Origin-Resource-Policy"], "cross-origin");
    }
}
