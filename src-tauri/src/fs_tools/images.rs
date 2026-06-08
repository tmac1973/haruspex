//! Image loading, normalization, and embedding helpers shared by
//! `fs_read_image`, the doc-builders (DOCX/ODT/PPTX/ODP/PDF), and the
//! markdown-image extractor used to scan document bodies.
//!
//! Everything that touches `LoadedImage` lives here so the doc-builder
//! modules can stay focused on package layout rather than image I/O.

use super::path::{resolve_in_workdir, workdir_path};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::collections::{BTreeSet, HashMap};
use std::io::Cursor;
use std::path::Path;
use tokio::fs;

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

/// Maximum displayed width for an embedded image in DOCX/ODT bodies,
/// in EMUs. ≈ 6 inches = 5_486_400 EMU. Images wider than this are
/// scaled down proportionally; smaller images render at natural size.
pub(super) const MAX_DOC_IMAGE_WIDTH_EMU: u64 = 5_486_400;

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

/// Decode just enough of an image to learn its pixel dimensions. Used
/// by the DOCX/ODT/PPTX/ODP builders to compute display sizes in EMUs.
pub(super) fn image_pixel_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    use image::GenericImageView;
    let img =
        image::load_from_memory(bytes).map_err(|e| format!("Failed to decode image: {}", e))?;
    Ok(img.dimensions())
}

/// Convert pixel width at assumed 96 dpi to EMUs (914400 EMU per inch).
/// 1 px @ 96 dpi = 914400 / 96 = 9525 EMU exactly.
pub(super) fn px_to_emu(px: u32) -> u64 {
    px as u64 * 9525
}

/// Stable per-image media index for a document. Built once so the manifest /
/// rels writer and the media writer agree on filenames (`image{i+1}.{ext}`).
/// Shared by the docx / odt / odp / pptx writers.
pub(super) struct ImageIndex<'a> {
    /// Referenced image paths in first-appearance order — entry `i` maps to
    /// the media filename `image{i+1}.{ext}`.
    pub ordered: Vec<&'a String>,
    /// path → 1-based media index.
    pub by_path: HashMap<&'a String, usize>,
    /// Unique extensions of the *loaded* images, sorted — for deterministic
    /// `[Content_Types].xml`. Paths absent from `images` contribute nothing.
    pub unique_exts: BTreeSet<&'a str>,
}

/// Build an [`ImageIndex`] from an ordered sequence of referenced image
/// paths; duplicates collapse to their first appearance. `unique_exts` is
/// derived from the loaded `images` map. The caller decides what counts as a
/// reference (docx/odt: standalone `![](…)` lines present in `images`;
/// pptx/odp: each slide's image).
pub(super) fn build_image_index<'a>(
    paths: impl IntoIterator<Item = &'a String>,
    images: &'a HashMap<String, LoadedImage>,
) -> ImageIndex<'a> {
    let mut ordered: Vec<&'a String> = Vec::new();
    let mut by_path: HashMap<&'a String, usize> = HashMap::new();
    for path in paths {
        if !by_path.contains_key(path) {
            by_path.insert(path, ordered.len() + 1);
            ordered.push(path);
        }
    }
    let mut unique_exts: BTreeSet<&'a str> = BTreeSet::new();
    for path in &ordered {
        if let Some(img) = images.get(*path) {
            unique_exts.insert(img.extension.as_str());
        }
    }
    ImageIndex {
        ordered,
        by_path,
        unique_exts,
    }
}

/// Fit an image's natural EMU dimensions into the document: width is either a
/// fraction of the max content width or the natural width capped at that max;
/// height preserves the aspect ratio. Both clamp to ≥ 1 EMU. Shared by the
/// docx and odt writers.
pub(super) fn fit_image_emu(nat_w: u64, nat_h: u64, width_fraction: Option<f32>) -> (u64, u64) {
    let w = match width_fraction {
        Some(frac) => ((MAX_DOC_IMAGE_WIDTH_EMU as f32) * frac).round() as u64,
        None => nat_w.min(MAX_DOC_IMAGE_WIDTH_EMU),
    }
    .max(1);
    let h = (((nat_h as f64) * (w as f64) / (nat_w.max(1) as f64)) as u64).max(1);
    (w, h)
}

/// Extract every `![alt](path)` image reference from a markdown-shaped
/// document, in order of first appearance, deduplicated. The returned
/// vector preserves source order so the document builders can assign
/// stable media indices (`image1`, `image2`, …). Used by the PDF, DOCX,
/// and ODT writers.
///
/// Matches the subset of CommonMark we actually want to support:
///   - `![alt text](path)` — single line, no nested brackets
///   - paths must end in a supported image extension (png/jpg/jpeg/gif)
///   - URLs are intentionally NOT supported — only workdir-relative paths,
///     because the writers load bytes from disk and the model shouldn't
///     be smuggling network fetches into a document write
pub fn extract_markdown_image_paths(content: &str) -> Vec<String> {
    use std::collections::HashSet;
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();

    let bytes = content.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] != b'!' || bytes[i + 1] != b'[' {
            i += 1;
            continue;
        }
        let alt_start = i + 2;
        let Some(alt_end_rel) = bytes[alt_start..].iter().position(|&b| b == b']') else {
            break;
        };
        let alt_end = alt_start + alt_end_rel;
        if alt_end + 1 >= bytes.len() || bytes[alt_end + 1] != b'(' {
            i = alt_end + 1;
            continue;
        }
        let path_start = alt_end + 2;
        let Some(path_end_rel) = bytes[path_start..].iter().position(|&b| b == b')') else {
            break;
        };
        let path_end = path_start + path_end_rel;
        // The body of the parens may be either `path` or `path "title"` —
        // the title field carries layout hints like `"center 50%"`. Split
        // on the first whitespace so loading only sees the path.
        let body = std::str::from_utf8(&bytes[path_start..path_end]).unwrap_or("");
        let path = match body.find(char::is_whitespace) {
            Some(idx) => body[..idx].trim().to_string(),
            None => body.trim().to_string(),
        };
        i = path_end + 1;
        if path.is_empty() {
            continue;
        }
        let lower = path.to_ascii_lowercase();
        if lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("data:")
        {
            continue;
        }
        if !seen.insert(path.clone()) {
            continue;
        }
        out.push(path);
    }
    out
}

/// Load every image referenced by an iterator of relative paths into a
/// path → `LoadedImage` map. Used by the doc-builders to pre-resolve
/// images before generating package bytes (so the builders themselves
/// can stay pure, no filesystem I/O).
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

/// Convenience wrapper: load every image referenced by a markdown body.
/// Used by the DOCX/ODT/PDF writers.
pub(super) fn load_markdown_images(
    workdir: &Path,
    content: &str,
) -> Result<HashMap<String, LoadedImage>, String> {
    load_image_set(workdir, extract_markdown_image_paths(content))
}

#[tauri::command]
pub async fn fs_read_image(workdir: String, rel_path: String) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }

    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "Image too large ({} bytes). Maximum source image is {} bytes.",
            metadata.len(),
            MAX_IMAGE_BYTES
        ));
    }

    let resolved_clone = resolved.clone();
    let data_url = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let img =
            image::open(&resolved_clone).map_err(|e| format!("Failed to decode image: {}", e))?;

        // Resize if larger than MAX_IMAGE_DIMENSION on the longest side
        let (w, h) = (img.width(), img.height());
        let max_side = w.max(h);
        let resized = if max_side > MAX_IMAGE_DIMENSION {
            let scale = MAX_IMAGE_DIMENSION as f32 / max_side as f32;
            let new_w = (w as f32 * scale) as u32;
            let new_h = (h as f32 * scale) as u32;
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
    })
    .await
    .map_err(|e| format!("image task failed: {}", e))??;

    Ok(data_url)
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

    #[test]
    fn extract_markdown_image_paths_handles_basic_cases() {
        let content = "
intro paragraph
![alt](first.png)
some prose
![other](sub/dir/second.jpg)
![first repeat](first.png)
trailing
";
        let paths = extract_markdown_image_paths(content);
        // Order: first appearance, dedup.
        assert_eq!(
            paths,
            vec!["first.png".to_string(), "sub/dir/second.jpg".to_string()]
        );
    }

    #[test]
    fn extract_markdown_image_paths_rejects_urls_and_empty_paths() {
        let content = "![empty-path]()
![ok](inline.png)
![web](https://example.com/img.png)
![data](data:image/png;base64,xxx)
![empty-alt](also-loaded.png)";
        let paths = extract_markdown_image_paths(content);
        // URL/data refs and empty-path refs drop out; empty alt text is fine.
        assert_eq!(
            paths,
            vec!["inline.png".to_string(), "also-loaded.png".to_string()]
        );
    }
}
