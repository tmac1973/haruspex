//! Fetching one image, safely.
//!
//! Every image the app displays comes through here. That is the point: the
//! user's HTTP proxy is applied inside `proxy::build_fetch_client`, which the
//! webview knows nothing about, so an image loaded by the webview would
//! silently bypass the privacy setting the user configured. Routing every
//! fetch through Rust is what keeps images consistent with search.
//!
//! Four gates, in order, and the order matters:
//!
//!   1. `validate_url` — SSRF. Rejects private ranges and non-HTTP schemes,
//!      and the shared client's redirect policy re-checks every hop.
//!   2. `Content-Length` — reject an oversized image before downloading it.
//!   3. Streaming cap — enforce the ceiling again while reading, because a
//!      server may omit or lie about the declared length.
//!   4. Decode — the bytes must actually parse as an image. This is what stops
//!      a server returning an HTML error page under `Content-Type: image/png`
//!      from poisoning the cache, and it is where the real dimensions come
//!      from rather than trusting a header.

use super::MAX_IMAGE_BYTES;
use crate::proxy::{build_fetch_client, validate_url, ProxyConfig, USER_AGENT};
use futures_util::StreamExt;
use log::debug;
use std::time::Duration;

/// Per-image ceiling. Deliberately tighter than `fs_download_url`'s 50 MB:
/// that path is a deliberate user-requested download, this one fires
/// automatically off a model's output.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Types worth caching. Two deliberate omissions:
///
///   - **SVG** is script-capable markup, not raster data, and the decode gate
///     below cannot vet it.
///   - **AVIF** cannot be decoded by our build. The `image` crate pulls in
///     `ravif`, which is an encoder; decoding needs the `avif-native` feature
///     and a libdav1d system dependency on all three platforms. Accepting the
///     MIME type would mean downloading up to 5 MB and then always failing at
///     gate 4, so it is rejected at the header instead. Revisit if `image`
///     gains pure-Rust AVIF decoding.
const ACCEPTED_MIME: &[&str] = &["image/jpeg", "image/png", "image/webp", "image/gif"];

/// Verified image bytes plus what decoding them revealed.
///
/// `Debug` skips the bytes: a megabyte of pixels in a log line or a test
/// failure message helps nobody.
pub struct FetchedImage {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

impl std::fmt::Debug for FetchedImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FetchedImage")
            .field("mime", &self.mime)
            .field("width", &self.width)
            .field("height", &self.height)
            .field("bytes", &format_args!("{} bytes", self.bytes.len()))
            .finish()
    }
}

/// Fetch and verify one image. Every failure is an `Err` the caller turns into
/// "this image does not exist" — no partial results, nothing cached.
pub async fn fetch_image(url: &str, proxy: Option<&ProxyConfig>) -> Result<FetchedImage, String> {
    validate_url(url)?;

    let client = build_fetch_client(proxy)?;
    let response = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Image fetch failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Image fetch failed with status: {}",
            response.status()
        ));
    }

    let declared_mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        // `image/jpeg; charset=binary` is legal and common.
        .map(normalize_mime)
        .unwrap_or_default();

    if !is_accepted_mime(&declared_mime) {
        return Err(format!("Not an accepted image type: {:?}", declared_mime));
    }

    // Gate 2: believe an honest Content-Length and skip the download entirely.
    if let Some(len) = response.content_length() {
        if len > MAX_IMAGE_BYTES {
            return Err(format!("Image too large: {} bytes declared", len));
        }
    }

    // Gate 3: enforce the cap while streaming, since the header is advisory.
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Image download failed: {}", e))?;
        if bytes.len() as u64 + chunk.len() as u64 > MAX_IMAGE_BYTES {
            return Err("Image too large: exceeded cap while downloading".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    let verified = verify_bytes(bytes, &declared_mime)?;

    debug!(
        "image fetched: {} ({}x{}, {} bytes, {})",
        url,
        verified.width,
        verified.height,
        verified.bytes.len(),
        verified.mime
    );

    Ok(verified)
}

/// Is this a content type worth downloading? Split out so the accept list is
/// testable without a server.
pub fn is_accepted_mime(declared: &str) -> bool {
    ACCEPTED_MIME.contains(&declared)
}

/// Normalise a `Content-Type` header value to a bare MIME type.
pub fn normalize_mime(raw: &str) -> String {
    raw.split(';').next().unwrap_or(raw).trim().to_lowercase()
}

/// Gate 4, standalone: the bytes must decode as a real image.
///
/// This is what stops a server returning an HTML error page under
/// `Content-Type: image/png` from poisoning the cache, and it is where the
/// dimensions come from — decoded, never taken from a header.
pub fn verify_bytes(bytes: Vec<u8>, declared_mime: &str) -> Result<FetchedImage, String> {
    if bytes.is_empty() {
        return Err("Image body was empty".to_string());
    }

    let decoded =
        image::load_from_memory(&bytes).map_err(|e| format!("Image failed to decode: {}", e))?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Err("Image decoded to zero dimensions".to_string());
    }

    // Trust the sniffed format over the header: they usually agree, and when
    // they do not the bytes are the truth.
    let mime = image::guess_format(&bytes)
        .ok()
        .map(|f| f.to_mime_type().to_string())
        .unwrap_or_else(|| declared_mime.to_string());

    Ok(FetchedImage {
        bytes,
        mime,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real 2×3 PNG, encoded here rather than checked in as a fixture.
    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::new(w, h);
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn html_masquerading_as_png_is_rejected() {
        let html = b"<!doctype html><html><body>404 Not Found</body></html>".to_vec();
        let err = verify_bytes(html, "image/png").unwrap_err();
        assert!(
            err.contains("failed to decode"),
            "expected a decode failure, got: {err}"
        );
    }

    #[test]
    fn an_empty_body_is_rejected() {
        assert!(verify_bytes(Vec::new(), "image/png").is_err());
    }

    #[test]
    fn dimensions_come_from_the_decoded_image() {
        let verified = verify_bytes(png_bytes(2, 3), "image/png").unwrap();
        assert_eq!((verified.width, verified.height), (2, 3));
    }

    /// A server that mislabels a PNG as JPEG should be recorded as PNG — the
    /// bytes are the truth, and the stored mime is what the protocol handler
    /// will later serve as `Content-Type`.
    #[test]
    fn the_sniffed_format_overrides_a_wrong_header() {
        let verified = verify_bytes(png_bytes(1, 1), "image/jpeg").unwrap();
        assert_eq!(verified.mime, "image/png");
    }

    #[test]
    fn accept_list_covers_what_we_can_decode_and_nothing_else() {
        for ok in ["image/jpeg", "image/png", "image/webp", "image/gif"] {
            assert!(is_accepted_mime(ok), "{ok} should be accepted");
        }
        // SVG is script-capable; AVIF cannot be decoded by this build. Both
        // must be refused at the header rather than downloaded and failed.
        for bad in [
            "image/svg+xml",
            "image/avif",
            "text/html",
            "application/octet-stream",
            "",
        ] {
            assert!(!is_accepted_mime(bad), "{bad} should be refused");
        }
    }

    #[test]
    fn content_type_parameters_are_stripped_before_matching() {
        assert_eq!(normalize_mime("image/jpeg; charset=binary"), "image/jpeg");
        assert_eq!(normalize_mime("  IMAGE/PNG  "), "image/png");
        assert!(is_accepted_mime(&normalize_mime("image/jpeg;charset=x")));
    }
}
