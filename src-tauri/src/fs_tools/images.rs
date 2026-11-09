//! Image loading and normalization shared by `fs_read_image` and the deck
//! writer (ODP). Everything that touches `LoadedImage` lives here so the
//! deck module can stay focused on package layout rather than image I/O.

use super::path::{resolve_in_workdir, stat_within, stat_within_limit, workdir_path};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;

/// Max source-file size for `fs_read_image` before the agent gets an
/// error. Vision contexts can't usefully consume larger images anyway.
const MAX_IMAGE_BYTES: u64 = 20 * 1_048_576;

/// Resize dimension cap for `fs_read_image` — anything with a longer
/// side gets scaled down before being base64-encoded for the model.
const MAX_IMAGE_DIMENSION: u32 = 1536;

/// Max per-image size when embedding into a document. Larger than this
/// suggests the model is trying to embed a photo when it should use a
/// reference instead.
pub(super) const MAX_EMBEDDED_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// A bitmap image loaded from disk and ready to embed in a document.
/// `extension` drives both the filename in the zip package and the
/// Content-Type declaration — always lowercased and without the leading
/// dot (e.g. "png", "jpeg").
#[derive(Clone, Debug)]
pub struct LoadedImage {
    pub bytes: Vec<u8>,
    pub extension: String,
}

/// Normalize an image file extension to one we know how to embed. Rejects
/// anything outside png / jpg / jpeg / gif, which are the formats both
/// PPTX (Office) and ODP (LibreOffice) reliably display. This is narrower
/// than the frontend's thumbnail-preview list (`IMAGE_EXT_RE` in
/// src/lib/agent/tools/fs-read.ts, which also allows webp/bmp/ico/tiff) —
/// the two are intentionally different (preview vs document-embed). "jpg" is
/// collapsed to "jpeg" so the downstream media/Content-Type naming is
/// consistent.
pub(super) fn normalize_image_extension(path: &str) -> Result<String, String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .ok_or_else(|| format!("Image has no extension: {}", path))?;
    match ext.as_str() {
        "png" => Ok("png".to_string()),
        "jpg" | "jpeg" => Ok("jpeg".to_string()),
        "gif" => Ok("gif".to_string()),
        other => Err(format!(
            "Unsupported image extension '{}' for {} — only png, jpg, jpeg, gif are embeddable",
            other, path
        )),
    }
}

/// Stable per-image media index for a document. Built once so the manifest /
/// rels writer and the media writer agree on filenames (`image{i+1}.{ext}`).
/// Used by the odp writer.
pub(super) struct ImageIndex<'a> {
    /// Referenced image paths in first-appearance order — entry `i` maps to
    /// the media filename `image{i+1}.{ext}`.
    pub ordered: Vec<&'a String>,
    /// path → 1-based media index.
    pub by_path: HashMap<&'a String, usize>,
}

/// Build an [`ImageIndex`] from an ordered sequence of referenced image
/// paths; duplicates collapse to their first appearance. The caller decides
/// what counts as a reference (each slide's image).
pub(super) fn build_image_index<'a>(paths: impl IntoIterator<Item = &'a String>) -> ImageIndex<'a> {
    let mut ordered: Vec<&'a String> = Vec::new();
    let mut by_path: HashMap<&'a String, usize> = HashMap::new();
    for path in paths {
        if !by_path.contains_key(path) {
            by_path.insert(path, ordered.len() + 1);
            ordered.push(path);
        }
    }
    ImageIndex { ordered, by_path }
}

/// Load every image referenced by an iterator of relative paths into a
/// path → `LoadedImage` map. Used by the deck writer to pre-resolve
/// images before generating package bytes (so the builder itself can
/// stay pure, no filesystem I/O).
///
/// Duplicates are collapsed (HashMap keys are unique). Missing files,
/// oversized files, or unsupported extensions abort the load — the
/// model gets a clear error so it can retry with a valid path.
pub(super) fn load_image_set(
    workdir: &Path,
    paths: impl IntoIterator<Item = String>,
) -> Result<HashMap<String, LoadedImage>, String> {
    let mut out: HashMap<String, LoadedImage> = HashMap::new();
    for rel_path in paths {
        if out.contains_key(&rel_path) {
            continue;
        }
        let resolved = resolve_in_workdir(workdir, &rel_path)?;
        let metadata = std::fs::metadata(&resolved)
            .map_err(|e| format!("Failed to stat image {}: {}", rel_path, e))?;
        if metadata.len() > MAX_EMBEDDED_IMAGE_BYTES {
            return Err(format!(
                "Image {} is too large ({} bytes). Max is {} bytes.",
                rel_path,
                metadata.len(),
                MAX_EMBEDDED_IMAGE_BYTES
            ));
        }
        let bytes = std::fs::read(&resolved)
            .map_err(|e| format!("Failed to read image {}: {}", rel_path, e))?;
        let extension = normalize_image_extension(&rel_path)?;
        out.insert(rel_path, LoadedImage { bytes, extension });
    }
    Ok(out)
}

/// Decode an image from disk, resize it to fit [`MAX_IMAGE_DIMENSION`] on its
/// longest side, and return a high-quality JPEG `data:` URL. Synchronous and
/// CPU-bound — call inside `spawn_blocking`. Shared by `fs_read_image` (workdir
/// path) and `read_dropped_image` (absolute path from a native file drop).
fn encode_resized_jpeg_data_url(path: &Path) -> Result<String, String> {
    let img = image::open(path).map_err(|e| format!("Failed to decode image: {}", e))?;
    encode_jpeg_data_url(img, MAX_IMAGE_DIMENSION)
}

/// Downscale an already-decoded image to `max_dimension` on its longest side
/// and encode it as a JPEG `data:` URL.
///
/// Split out from [`encode_resized_jpeg_data_url`] so screen capture, which
/// produces its pixels in memory rather than on disk, uses one downscale and
/// encode policy rather than a second opinion about it. The cap is a parameter
/// because a screenshot and a photograph do not want the same one — see
/// `desktop::MAX_SCREENSHOT_DIMENSION`.
pub(crate) fn encode_jpeg_data_url(
    img: image::DynamicImage,
    max_dimension: u32,
) -> Result<String, String> {
    let (w, h) = (img.width(), img.height());
    let max_side = w.max(h);
    let resized = if max_side > max_dimension {
        let scale = max_dimension as f32 / max_side as f32;
        // `.max(1)` because a very long, very thin image (a 4000x1 strip of a
        // progress bar) would otherwise scale its short side to zero, and
        // `resize` panics on a zero dimension.
        let new_w = ((w as f32 * scale) as u32).max(1);
        let new_h = ((h as f32 * scale) as u32).max(1);
        img.resize(new_w, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    // Encode as high-quality JPEG — low quality blurs small text/digits
    // (a decimal point can shift with aggressive chroma subsampling).
    let mut bytes = Vec::new();
    let mut cursor = Cursor::new(&mut bytes);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 92);
    let rgb = resized.to_rgb8();
    image::DynamicImage::ImageRgb8(rgb)
        .write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode image: {}", e))?;

    let encoded = B64.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{}", encoded))
}

#[tauri::command]
pub async fn fs_read_image(workdir: String, rel_path: String) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(super::path::not_a_file(&resolved, &rel_path));
    }

    stat_within(&resolved, MAX_IMAGE_BYTES, |len| {
        format!(
            "Image too large ({} bytes). Maximum source image is {} bytes.",
            len, MAX_IMAGE_BYTES
        )
    })
    .await?;

    tokio::task::spawn_blocking(move || encode_resized_jpeg_data_url(&resolved))
        .await
        .map_err(|e| format!("image task failed: {}", e))?
}

/// Read an image at an absolute path (from a native file-drop) and return a
/// resized JPEG `data:` URL for attaching to the chat. Unlike `fs_read_image`
/// this isn't workdir-scoped — the user explicitly dropped the file.
#[tauri::command]
pub async fn read_dropped_image(path: String) -> Result<String, String> {
    let resolved = std::path::PathBuf::from(&path);

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    stat_within_limit(&resolved, MAX_IMAGE_BYTES, "Image").await?;

    tokio::task::spawn_blocking(move || encode_resized_jpeg_data_url(&resolved))
        .await
        .map_err(|e| format!("image task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_image_extension_accepts_supported_formats() {
        assert_eq!(normalize_image_extension("foo.png").unwrap(), "png");
        assert_eq!(normalize_image_extension("foo.jpg").unwrap(), "jpeg");
        assert_eq!(normalize_image_extension("foo.JPEG").unwrap(), "jpeg");
        assert_eq!(normalize_image_extension("foo.gif").unwrap(), "gif");
        assert!(normalize_image_extension("foo.bmp").is_err());
        assert!(normalize_image_extension("foo").is_err());
    }
}
