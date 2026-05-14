pub mod images;
pub mod markdown_inline;
pub mod path;

pub use images::LoadedImage;
use images::{
    image_pixel_dimensions, load_image_set, load_markdown_images, px_to_emu,
    MAX_DOC_IMAGE_WIDTH_EMU,
};

use markdown_inline::{
    ascii_fold_for_pdf, escape_xml, format_table_as_monoblock, is_horizontal_rule,
    is_table_separator, normalize_list_marker, pad_right, parse_heading, parse_inline_markdown,
    parse_standalone_image_line, preprocess_lines, runs_to_words, strip_inline_markdown,
    wrap_styled_words, wrap_to_width, DocumentBlock, ImageAlignment, ImageOptions, InlineRun,
};

pub use path::resolve_in_workdir;
use path::{refuse_if_exists, workdir_path};

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::fs;

/// Tracks whether pdfium has been successfully bound to its shared library.
/// Set once at app startup via init_pdfium(). If pdfium is available we use
/// it for PDF text extraction (high quality, handles forms and custom fonts
/// correctly). If not, we fall back to the pure-Rust pdf-extract crate.
static PDFIUM_AVAILABLE: OnceLock<bool> = OnceLock::new();

/// Initialize pdfium by loading libpdfium from the resource dir. Should be
/// called once at app startup. Safe to call multiple times.
pub fn init_pdfium(resource_dir: &Path) {
    if PDFIUM_AVAILABLE.get().is_some() {
        return;
    }

    let libs_dir = resource_dir.join("binaries").join("libs");
    let lib_name = pdfium_render::prelude::Pdfium::pdfium_platform_library_name_at_path(&libs_dir);

    match pdfium_render::prelude::Pdfium::bind_to_library(&lib_name) {
        Ok(bindings) => {
            // Pdfium::new() takes ownership of the bindings and calls
            // FPDF_InitLibrary. After this, text extraction uses the
            // global bindings.
            let _ = pdfium_render::prelude::Pdfium::new(bindings);
            log::info!("PDFium initialized from {}", lib_name.display());
            let _ = PDFIUM_AVAILABLE.set(true);
        }
        Err(e) => {
            log::warn!(
                "PDFium not available ({}); PDF extraction will use fallback",
                e
            );
            let _ = PDFIUM_AVAILABLE.set(false);
        }
    }
}

fn pdfium_available() -> bool {
    *PDFIUM_AVAILABLE.get().unwrap_or(&false)
}

/// Extract text from a PDF using PDFium with position-aware layout
/// reconstruction. PDFium's built-in `text.all()` returns characters in
/// document order, which is NOT reading order for form PDFs (tax forms,
/// invoices, etc.) — the text stream can be generated top-to-bottom in
/// arbitrary order. We walk every character with its bounding box, group
/// by vertical row (Y coordinate), then sort left-to-right within each
/// row. This reconstructs the visual reading order and matches what
/// `pdftotext -layout` produces.
fn extract_pdf_with_pdfium(path: &Path) -> Result<String, String> {
    use pdfium_render::prelude::*;

    if !pdfium_available() {
        return Err("pdfium unavailable".to_string());
    }

    let pdfium = Pdfium {};
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {}", e))?;

    let mut out = String::new();
    let total_pages = document.pages().len();

    for (idx, page) in document.pages().iter().enumerate() {
        let page_text = page
            .text()
            .map_err(|e| format!("Failed to read page {}: {}", idx + 1, e))?;

        if total_pages > 1 {
            out.push_str(&format!("--- Page {} ---\n", idx + 1));
        }

        let reconstructed = reconstruct_page_layout(&page_text);
        out.push_str(&reconstructed);
        out.push_str("\n\n");
    }

    Ok(out)
}

/// A single character with its position on the page.
#[derive(Debug, Clone)]
struct PositionedChar {
    ch: char,
    left: f32,
    right: f32,
    /// Vertical center of the char (PDF y-axis: bigger = higher on page)
    y: f32,
    height: f32,
}

/// Reconstruct visual reading order from a PdfPageText by grouping
/// characters into rows by Y coordinate and sorting left-to-right
/// within each row.
fn reconstruct_page_layout(page_text: &pdfium_render::prelude::PdfPageText) -> String {
    // Collect all positioned characters
    let mut chars: Vec<PositionedChar> = Vec::new();
    for pdf_char in page_text.chars().iter() {
        let ch = match pdf_char.unicode_char() {
            Some(c) => c,
            None => continue,
        };
        // Skip newlines/control characters — we'll insert our own
        if ch == '\n' || ch == '\r' {
            continue;
        }
        let bounds = match pdf_char.loose_bounds() {
            Ok(b) => b,
            Err(_) => continue,
        };
        let top = bounds.top().value;
        let bottom = bounds.bottom().value;
        let left = bounds.left().value;
        let right = bounds.right().value;
        let height = (top - bottom).abs();
        let y = (top + bottom) / 2.0;
        chars.push(PositionedChar {
            ch,
            left,
            right,
            y,
            height: if height > 0.0 { height } else { 10.0 },
        });
    }

    if chars.is_empty() {
        return String::new();
    }

    // Sort by Y (descending: PDF y-axis has origin at bottom-left), then X
    chars.sort_by(|a, b| {
        b.y.partial_cmp(&a.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                a.left
                    .partial_cmp(&b.left)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    // Compute a line-height threshold from the median character height
    let mut heights: Vec<f32> = chars.iter().map(|c| c.height).collect();
    heights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_height = heights[heights.len() / 2];
    // Two characters are in the same row if their Y centers are within
    // half the median character height.
    let row_threshold = (median_height * 0.5).max(2.0);

    // Group into rows. We scan Y-sorted characters and start a new row
    // whenever the Y jump exceeds row_threshold.
    let mut rows: Vec<Vec<PositionedChar>> = Vec::new();
    let mut current_row: Vec<PositionedChar> = Vec::new();
    let mut current_y = chars[0].y;

    for c in chars {
        if (current_y - c.y).abs() > row_threshold {
            if !current_row.is_empty() {
                rows.push(std::mem::take(&mut current_row));
            }
            current_y = c.y;
        }
        current_row.push(c);
    }
    if !current_row.is_empty() {
        rows.push(current_row);
    }

    // Sort each row left-to-right, then emit with spacing based on
    // horizontal gaps so form columns stay separated
    let mut out = String::new();
    for row in rows {
        let mut row = row;
        row.sort_by(|a, b| {
            a.left
                .partial_cmp(&b.left)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut last_right = f32::NEG_INFINITY;
        let mut last_height = median_height;
        for c in row {
            let gap = c.left - last_right;
            if last_right > f32::NEG_INFINITY {
                // Large gaps become multiple spaces (preserves column
                // structure for tabular data). Small gaps become a single
                // space. Very small or zero gaps mean adjacent characters
                // in the same word — no space.
                let avg_char_width = last_height * 0.3;
                if gap > avg_char_width * 2.0 {
                    // Column break — use multiple spaces proportional to gap
                    let spaces = ((gap / avg_char_width).min(12.0) as usize).max(2);
                    out.push_str(&" ".repeat(spaces));
                } else if gap > avg_char_width * 0.3 {
                    out.push(' ');
                }
            }
            out.push(c.ch);
            last_right = c.right;
            last_height = c.height;
        }
        out.push('\n');
    }

    out
}

// Size limits — see plan phase-09 "Size / safety limits"
const MAX_TEXT_READ_BYTES: u64 = 1_048_576; // 1 MB
const MAX_WRITE_BYTES: usize = 10 * 1_048_576; // 10 MB
const MAX_PDF_READ_BYTES: u64 = 50 * 1_048_576; // 50 MB
// --- Tauri commands ---

#[tauri::command]
pub async fn fs_read_text(workdir: String, rel_path: String) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }

    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_TEXT_READ_BYTES {
        return Err(format!(
            "File too large ({} bytes). Maximum text read is {} bytes. Read it in chunks or use a format-specific tool.",
            metadata.len(),
            MAX_TEXT_READ_BYTES
        ));
    }

    let bytes = fs::read(&resolved)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Reject binary files — if there's a NUL byte in the first 8 KB, treat as binary
    let sample_len = bytes.len().min(8192);
    if bytes[..sample_len].contains(&0) {
        return Err("File appears to be binary. Use a format-specific tool (fs_read_pdf, fs_read_image, etc.)".to_string());
    }

    String::from_utf8(bytes).map_err(|e| format!("File is not valid UTF-8: {}", e))
}

#[tauri::command]
pub async fn fs_write_text(
    workdir: String,
    rel_path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Content too large ({} bytes). Maximum write is {} bytes.",
            content.len(),
            MAX_WRITE_BYTES
        ));
    }

    // Refuse to clobber an existing file unless the caller explicitly
    // confirmed overwrite. The old behavior here was .unwrap_or(true)
    // which silently replaced; the new default is .unwrap_or(false)
    // through the shared refuse_if_exists helper, matching every other
    // fs_write_* command.
    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    // Create parent directories if needed (still within workdir — the
    // sandbox check already verified the full path is inside)
    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    fs::write(&resolved, content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

/// Max bytes we'll accept from a single HTTP download into the working
/// directory. Generous enough for a typical image, PDF, or font file, and
/// small enough to prevent a rogue URL from filling the disk. This caps
/// both the Content-Length header (pre-fetch) and the actual bytes read.
const MAX_DOWNLOAD_BYTES: u64 = 50 * 1024 * 1024; // 50 MB

/// File extensions we refuse to save via `fs_download_url`, even if the
/// URL is otherwise valid. This is a blocklist, not an allowlist — the
/// goal is to prevent the model from being tricked (or tricking itself)
/// into staging an executable payload in the user's working directory,
/// while still letting it download the long tail of legitimate binary
/// content (images, PDFs, office docs, archives, fonts, media, data).
///
/// Everything in here is a file format that can be executed or installed
/// on at least one mainstream OS without user supervision. `.sh` and
/// `.py` are NOT in the list because they're plain text and won't run
/// without an explicit chmod/invocation by the user — same bar as the
/// existing fs_write_text tool applies.
const EXECUTABLE_EXTENSION_BLOCKLIST: &[&str] = &[
    "exe", "msi", "scr", "com", "bat", "cmd", "ps1", "vbs", "vbe", "jse", "wsf", "wsh", "hta",
    "dll", "sys", "drv", "cpl", "ocx", "so", "dylib", "app", "pkg", "dmg", "deb", "rpm", "apk",
    "appimage", "snap", "flatpak", "jar",
];

/// Return an error if `rel_path` ends with an extension on the executable
/// blocklist. Case-insensitive. No extension at all is allowed — we can't
/// guess whether it's benign data or a shell script the caller forgot to
/// name.
fn reject_executable_extension(rel_path: &str) -> Result<(), String> {
    let ext = std::path::Path::new(rel_path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    if let Some(ext) = ext {
        if EXECUTABLE_EXTENSION_BLOCKLIST.contains(&ext.as_str()) {
            return Err(format!(
                "Refusing to download '{}': .{} files are blocked to prevent staging \
                 executable payloads in the working directory.",
                rel_path, ext
            ));
        }
    }
    Ok(())
}

/// Download the bytes at `url` and save them to `rel_path` inside the
/// working directory. Shared SSRF protection with the web-search fetch
/// path (private IPs, localhost, non-HTTP schemes are all rejected).
///
/// Failure modes:
///   - URL fails `proxy::validate_url`
///   - Extension is on the executable blocklist
///   - HTTP response is not 2xx
///   - Declared `Content-Length` exceeds the size limit
///   - Actual streamed bytes exceed the size limit (caught mid-download)
///
/// On success, the returned string is a short confirmation including the
/// resolved local path so the model can reuse it in follow-up tool calls
/// (e.g. embedding a downloaded image in a slide via fs_write_pptx).
#[tauri::command]
pub async fn fs_download_url(
    workdir: String,
    url: String,
    rel_path: String,
    overwrite: Option<bool>,
) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    // SSRF + scheme + private-IP guard. Uses the same helper as proxy_fetch.
    crate::proxy::validate_url(&url)?;

    // Extension-level safety net.
    reject_executable_extension(&rel_path)?;

    // Conflict guard — refuse to overwrite unless explicitly confirmed.
    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .header("User-Agent", crate::proxy::USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    // Pre-check the declared size if the server provided it. This catches
    // obvious over-size cases before we start streaming bytes. The actual
    // streamed length is re-checked below (some servers lie or omit the
    // header entirely, so this is advisory).
    if let Some(len) = response.content_length() {
        if len > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "Remote file is too large ({} bytes). Maximum is {} bytes.",
                len, MAX_DOWNLOAD_BYTES
            ));
        }
    }

    // Make sure the parent directory exists before we open the file.
    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    // Stream the body to disk, counting bytes as we go so an oversized
    // response trips the limit even if the server omitted Content-Length.
    let mut file = fs::File::create(&resolved)
        .await
        .map_err(|e| format!("Failed to open output file: {}", e))?;

    let mut total: u64 = 0;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            // Tear down the partially-written file so we don't leave
            // half-downloaded garbage in the workdir.
            drop(file);
            let _ = fs::remove_file(&resolved).await;
            return Err(format!(
                "Download exceeded size limit ({} bytes streamed, max {}).",
                total, MAX_DOWNLOAD_BYTES
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write chunk: {}", e))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {}", e))?;

    Ok(format!("Downloaded {} bytes to {}", total, rel_path))
}

/// Extract text from a .docx file by reading word/document.xml from the zip
/// and scanning for <w:t>...</w:t> elements. Paragraphs (<w:p>) become line
/// breaks. This is much simpler than walking the full docx AST and handles
/// 95% of real-world documents correctly.
fn extract_docx_text(path: &Path) -> Result<String, String> {
    use std::io::Read;

    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open docx: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Not a valid docx (zip) file: {}", e))?;

    let mut doc_xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|e| format!("docx missing word/document.xml: {}", e))?
        .read_to_string(&mut doc_xml)
        .map_err(|e| format!("Failed to read word/document.xml: {}", e))?;

    // Scan for text runs and paragraph breaks. This is a forward scan — not
    // a full XML parser, but it handles the flat structure of word text
    // elements reliably.
    let mut out = String::new();
    let bytes = doc_xml.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"<w:t") {
            // Find the end of the opening tag
            if let Some(open_end) = bytes[i..].iter().position(|&b| b == b'>') {
                let text_start = i + open_end + 1;
                if let Some(close_rel) = find_subslice(&bytes[text_start..], b"</w:t>") {
                    let text_end = text_start + close_rel;
                    // Decode XML entities in the text range
                    out.push_str(&decode_xml_entities(&doc_xml[text_start..text_end]));
                    i = text_end + "</w:t>".len();
                    continue;
                }
            }
        } else if bytes[i..].starts_with(b"</w:p>") {
            out.push('\n');
            i += "</w:p>".len();
            continue;
        } else if bytes[i..].starts_with(b"<w:br") {
            out.push('\n');
            // Skip to end of tag
            if let Some(end) = bytes[i..].iter().position(|&b| b == b'>') {
                i += end + 1;
                continue;
            }
        } else if bytes[i..].starts_with(b"<w:tab/>") {
            out.push('\t');
            i += "<w:tab/>".len();
            continue;
        }
        i += 1;
    }

    Ok(out.trim().to_string())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn decode_xml_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// Read an image file and return it as a base64 data URL, resized if
/// larger than MAX_IMAGE_DIMENSION on the longest side. The returned URL
/// can be passed directly as an image_url content part to the vision model.
/// Build a minimal valid .docx file from a list of paragraphs. Each
/// paragraph string becomes a <w:p> with a single <w:t> run. Basic
/// formatting (bold, italic) is not supported in this first pass —
/// the content parameter is plain text with newline-separated paragraphs.
fn build_docx(
    paragraphs: &[&str],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use std::collections::BTreeSet;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    // Walk paragraphs once to assign stable media indices to each unique
    // image path. Duplicate paths share a single word/media/imageN.{ext}.
    let mut ordered_image_paths: Vec<&String> = Vec::new();
    let mut image_index: std::collections::HashMap<&String, usize> =
        std::collections::HashMap::new();
    for para in paragraphs {
        if let Some((path, _)) = parse_standalone_image_line(para) {
            if let Some(loaded_path) = images.keys().find(|k| **k == path) {
                if !image_index.contains_key(loaded_path) {
                    image_index.insert(loaded_path, ordered_image_paths.len() + 1);
                    ordered_image_paths.push(loaded_path);
                }
            }
        }
    }
    // Decode pixel dimensions for each image once. Each image's natural EMU
    // size lives here; the per-paragraph rendering loop applies per-image
    // ImageOptions (alignment, width%) on top of these natural dimensions.
    let mut natural_emu: std::collections::HashMap<&String, (u64, u64)> =
        std::collections::HashMap::new();
    for path in &ordered_image_paths {
        let img = images
            .get(*path)
            .ok_or_else(|| format!("Image {} missing from loaded map", path))?;
        let (px_w, px_h) = image_pixel_dimensions(&img.bytes)?;
        natural_emu.insert(*path, (px_to_emu(px_w), px_to_emu(px_h)));
    }
    let mut unique_exts: BTreeSet<&str> = BTreeSet::new();
    for path in &ordered_image_paths {
        if let Some(img) = images.get(*path) {
            unique_exts.insert(img.extension.as_str());
        }
    }

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // [Content_Types].xml — adds Default entries for any image
        // extensions actually used.
        let mut content_types = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
"#,
        );
        for ext in &unique_exts {
            content_types.push_str(&format!(
                r#"<Default Extension="{}" ContentType="image/{}"/>
"#,
                ext, ext
            ));
        }
        content_types.push_str(
            r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#,
        );
        zip.start_file("[Content_Types].xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(content_types.as_bytes())
            .map_err(|e| e.to_string())?;

        // _rels/.rels — package-level relationship to the main document.
        zip.start_file("_rels/.rels", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#,
        )
        .map_err(|e| e.to_string())?;

        // word/_rels/document.xml.rels — only emitted when there's at
        // least one image to reference. Word tolerates a missing file
        // when there are no images, and we'd rather not write empty
        // <Relationships> XML.
        if !ordered_image_paths.is_empty() {
            let mut rels = String::from(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
"#,
            );
            for path in &ordered_image_paths {
                let idx = image_index[*path];
                let ext = &images[*path].extension;
                rels.push_str(&format!(
                    r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image{}.{}"/>
"#,
                    idx, idx, ext
                ));
            }
            rels.push_str("</Relationships>");
            zip.start_file("word/_rels/document.xml.rels", options)
                .map_err(|e| e.to_string())?;
            zip.write_all(rels.as_bytes()).map_err(|e| e.to_string())?;
        }

        // word/media/imageN.{ext} — one per unique image.
        for path in &ordered_image_paths {
            let idx = image_index[*path];
            let img = &images[*path];
            zip.start_file(
                format!("word/media/image{}.{}", idx, img.extension),
                options,
            )
            .map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }

        // word/document.xml — body XML. The root <w:document> needs every
        // namespace prefix any drawing markup uses, so add wp/a/r/pic now
        // even when there are no images (cheap, simpler than branching).
        let mut body_xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>"#,
        );
        let mut drawing_id: u32 = 0;
        for para in paragraphs {
            if let Some((path, opts)) = parse_standalone_image_line(para) {
                if let Some(&idx) = image_index.get(&path) {
                    let (nat_w, nat_h) = natural_emu[&path];
                    // Apply width% if specified, else auto-fit to content
                    // width (capping at MAX_DOC_IMAGE_WIDTH_EMU). Aspect
                    // ratio is always preserved.
                    let target_w = match opts.width_fraction {
                        Some(frac) => ((MAX_DOC_IMAGE_WIDTH_EMU as f32) * frac).round() as u64,
                        None => nat_w.min(MAX_DOC_IMAGE_WIDTH_EMU),
                    };
                    let target_w = target_w.max(1);
                    let target_h = ((nat_h as f64) * (target_w as f64) / (nat_w as f64)) as u64;
                    let target_h = target_h.max(1);
                    let jc = match opts.alignment {
                        ImageAlignment::Center => "center",
                        ImageAlignment::Right => "right",
                        ImageAlignment::Left => "left",
                    };
                    drawing_id += 1;
                    // Wrap the drawing in a paragraph with w:jc alignment
                    // when not default-left. Word treats absent w:jc as
                    // left-aligned, so we can skip the w:pPr block in that
                    // case to keep the XML lean.
                    let ppr = if opts.alignment == ImageAlignment::Left {
                        String::new()
                    } else {
                        format!(r#"<w:pPr><w:jc w:val="{}"/></w:pPr>"#, jc)
                    };
                    body_xml.push_str(&format!(
                        r#"<w:p>{ppr}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{w}" cy="{h}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{id}" name="Picture {id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="image{idx}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId{idx}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{w}" cy="{h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"#,
                        ppr = ppr,
                        w = target_w,
                        h = target_h,
                        id = drawing_id,
                        idx = idx,
                    ));
                    continue;
                }
                // Image referenced but not loaded — render the markdown
                // verbatim as a paragraph so the user can see what went
                // wrong instead of silently dropping content.
            }
            // Treat as a heading if the line starts with # (simple markdown-ish)
            let (text, heading_level) = parse_heading(para);
            let escaped = escape_xml(text);
            if let Some(level) = heading_level {
                body_xml.push_str(&format!(
                    r#"<w:p><w:pPr><w:pStyle w:val="Heading{}"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="{}"/></w:rPr><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                    level,
                    32 - level * 2,
                    escaped
                ));
            } else {
                body_xml.push_str(&format!(
                    r#"<w:p><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                    escaped
                ));
            }
        }
        body_xml.push_str("</w:body></w:document>");

        zip.start_file("word/document.xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(body_xml.as_bytes())
            .map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf)
}

/// Build a minimal OpenDocument Text (.odt) file from a slice of
/// paragraph-shaped lines. Same markdown-ish convention as `build_docx`:
/// lines starting with `# ` / `## ` / `### ` become `<text:h>` headings
/// with `text:outline-level` 1/2/3, everything else becomes `<text:p>`.
///
/// ODF's first-entry-must-be-uncompressed-mimetype requirement:
/// the ODF spec mandates that the archive's first file is named
/// `mimetype`, is stored uncompressed (`CompressionMethod::Stored`),
/// has no extra field, and contains the exact ODF media-type string for
/// the format. This lets tools identify the document type from the raw
/// zip header without decoding the full archive. LibreOffice won't open
/// a file that violates this — it'll treat it as a generic zip.
fn build_odt(
    paragraphs: &[&str],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use std::collections::BTreeSet;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    // Walk paragraphs once to assign stable Pictures/imageN.{ext} indices
    // to each unique image path referenced via standalone `![alt](path)`.
    let mut ordered_image_paths: Vec<&String> = Vec::new();
    let mut image_index: std::collections::HashMap<&String, usize> =
        std::collections::HashMap::new();
    for para in paragraphs {
        if let Some((path, _)) = parse_standalone_image_line(para) {
            if let Some(loaded_path) = images.keys().find(|k| **k == path) {
                if !image_index.contains_key(loaded_path) {
                    image_index.insert(loaded_path, ordered_image_paths.len() + 1);
                    ordered_image_paths.push(loaded_path);
                }
            }
        }
    }
    // Per-image natural sizes, in EMU. Width%/auto-fit and aspect-ratio
    // scaling happen in the body loop so per-reference options can apply.
    // ODF svg attributes need cm (1 cm = 360000 EMU).
    let mut natural_emu: std::collections::HashMap<&String, (u64, u64)> =
        std::collections::HashMap::new();
    for path in &ordered_image_paths {
        let img = images
            .get(*path)
            .ok_or_else(|| format!("Image {} missing from loaded map", path))?;
        let (px_w, px_h) = image_pixel_dimensions(&img.bytes)?;
        natural_emu.insert(*path, (px_to_emu(px_w), px_to_emu(px_h)));
    }
    let mut unique_exts: BTreeSet<&str> = BTreeSet::new();
    for path in &ordered_image_paths {
        if let Some(img) = images.get(*path) {
            unique_exts.insert(img.extension.as_str());
        }
    }

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let stored =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflated =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // 1) `mimetype` — MUST be the first entry, MUST be STORED.
        zip.start_file("mimetype", stored)
            .map_err(|e| e.to_string())?;
        zip.write_all(b"application/vnd.oasis.opendocument.text")
            .map_err(|e| e.to_string())?;

        // 2) META-INF/manifest.xml — lists every file in the package and
        //    its media type. The root `/` entry declares the document type.
        //    Each embedded image needs its own file-entry, and so does the
        //    Pictures/ directory entry that LibreOffice expects when any
        //    Pictures/* file is present.
        let mut manifest = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
"#,
        );
        if !ordered_image_paths.is_empty() {
            manifest.push_str(
                r#"<manifest:file-entry manifest:full-path="Pictures/" manifest:media-type=""/>
"#,
            );
        }
        for path in &ordered_image_paths {
            let idx = image_index[*path];
            let ext = &images[*path].extension;
            manifest.push_str(&format!(
                r#"<manifest:file-entry manifest:full-path="Pictures/image{}.{}" manifest:media-type="image/{}"/>
"#,
                idx, ext, ext
            ));
        }
        manifest.push_str("</manifest:manifest>");
        let _ = unique_exts; // captured into manifest above; var kept for symmetry with DOCX path
        zip.start_file("META-INF/manifest.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(manifest.as_bytes())
            .map_err(|e| e.to_string())?;

        // 3) meta.xml — minimal doc metadata. Optional but polite.
        zip.start_file("meta.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2">
<office:meta><meta:generator>Haruspex</meta:generator></office:meta>
</office:document-meta>"#,
        )
        .map_err(|e| e.to_string())?;

        // 4) styles.xml — defines the paragraph styles referenced from
        //    content.xml. LibreOffice uses `Heading_20_1`, etc.
        //    (`_20_` is the encoded space character).
        zip.start_file("styles.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br##"<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
<office:styles>
<style:default-style style:family="paragraph"><style:text-properties fo:font-size="11pt"/></style:default-style>
<style:style style:name="Heading_20_1" style:family="paragraph" style:display-name="Heading 1" style:default-outline-level="1"><style:text-properties fo:font-size="20pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_2" style:family="paragraph" style:display-name="Heading 2" style:default-outline-level="2"><style:text-properties fo:font-size="16pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_3" style:family="paragraph" style:display-name="Heading 3" style:default-outline-level="3"><style:text-properties fo:font-size="13pt" fo:font-weight="bold"/></style:style>
</office:styles>
</office:document-styles>"##,
        )
        .map_err(|e| e.to_string())?;

        // 6) Pictures/imageN.{ext} — embedded image binaries. ODF stores
        //    these in a top-level Pictures/ directory referenced by
        //    relative xlink:href from content.xml.
        for path in &ordered_image_paths {
            let idx = image_index[*path];
            let img = &images[*path];
            zip.start_file(format!("Pictures/image{}.{}", idx, img.extension), deflated)
                .map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }

        // 7) content.xml — the document body. The root element needs the
        //    draw/svg/xlink namespaces since image paragraphs use them.
        //    Declare automatic paragraph styles for image alignment up
        //    front so the body loop can reference them by name.
        let mut body_xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">
<office:automatic-styles>
<style:style style:name="ImageCenter" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>
<style:style style:name="ImageRight" style:family="paragraph"><style:paragraph-properties fo:text-align="end"/></style:style>
</office:automatic-styles>
<office:body><office:text>"#,
        );
        for para in paragraphs {
            if let Some((path, opts)) = parse_standalone_image_line(para) {
                if let Some(&idx) = image_index.get(&path) {
                    let (nat_w, nat_h) = natural_emu[&path];
                    let target_w_emu = match opts.width_fraction {
                        Some(frac) => ((MAX_DOC_IMAGE_WIDTH_EMU as f32) * frac).round() as u64,
                        None => nat_w.min(MAX_DOC_IMAGE_WIDTH_EMU),
                    };
                    let target_w_emu = target_w_emu.max(1);
                    let target_h_emu =
                        ((nat_h as f64) * (target_w_emu as f64) / (nat_w.max(1) as f64)) as u64;
                    let target_h_emu = target_h_emu.max(1);
                    let cm_w = target_w_emu as f32 / 360000.0;
                    let cm_h = target_h_emu as f32 / 360000.0;
                    let style_attr = match opts.alignment {
                        ImageAlignment::Center => r#" text:style-name="ImageCenter""#,
                        ImageAlignment::Right => r#" text:style-name="ImageRight""#,
                        ImageAlignment::Left => "",
                    };
                    let ext = &images[&path].extension;
                    body_xml.push_str(&format!(
                        r#"<text:p{style_attr}><draw:frame draw:name="image{idx}" text:anchor-type="paragraph" svg:width="{w:.3}cm" svg:height="{h:.3}cm"><draw:image xlink:href="Pictures/image{idx}.{ext}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>"#,
                        style_attr = style_attr,
                        idx = idx,
                        w = cm_w,
                        h = cm_h,
                        ext = ext,
                    ));
                    continue;
                }
                // Loaded-image lookup miss falls through to plain-text rendering
                // of the markdown so the user can see what went wrong.
            }
            let (text, heading_level) = parse_heading(para);
            let escaped = escape_xml(text);
            if let Some(level) = heading_level {
                body_xml.push_str(&format!(
                    r#"<text:h text:style-name="Heading_20_{}" text:outline-level="{}">{}</text:h>"#,
                    level, level, escaped
                ));
            } else {
                body_xml.push_str(&format!("<text:p>{}</text:p>", escaped));
            }
        }
        body_xml.push_str("</office:text></office:body></office:document-content>");

        zip.start_file("content.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(body_xml.as_bytes())
            .map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf)
}

/// Build a minimal OpenDocument Spreadsheet (.ods) file from a slice of
/// sheets. Each `XlsxSheet` becomes a `<table:table>` with rows and cells.
/// Numeric strings are emitted as `office:value-type="float"` (same
/// number-vs-text detection as the xlsx writer); everything else is a
/// `string` cell. Same ODF first-entry-stored-mimetype requirement as
/// `build_odt`.
fn build_ods(sheets: &[XlsxSheet]) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let stored =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflated =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // 1) mimetype — STORED, must be first
        zip.start_file("mimetype", stored)
            .map_err(|e| e.to_string())?;
        zip.write_all(b"application/vnd.oasis.opendocument.spreadsheet")
            .map_err(|e| e.to_string())?;

        // 2) manifest.xml
        zip.start_file("META-INF/manifest.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>"#,
        )
        .map_err(|e| e.to_string())?;

        // 3) meta.xml
        zip.start_file("meta.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2">
<office:meta><meta:generator>Haruspex</meta:generator></office:meta>
</office:document-meta>"#,
        )
        .map_err(|e| e.to_string())?;

        // 4) styles.xml — minimal; LibreOffice fills in defaults for
        //    anything not declared here.
        zip.start_file("styles.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:version="1.2">
<office:styles/>
</office:document-styles>"#,
        )
        .map_err(|e| e.to_string())?;

        // 5) content.xml — one <table:table> per sheet.
        let mut body_xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:version="1.2">
<office:body><office:spreadsheet>"#,
        );
        for sheet in sheets {
            // Column count = widest row, so we can declare table-column once.
            let num_cols = sheet.rows.iter().map(|r| r.len()).max().unwrap_or(0).max(1);
            body_xml.push_str(&format!(
                r#"<table:table table:name="{}"><table:table-column table:number-columns-repeated="{}"/>"#,
                escape_xml(&sheet.name),
                num_cols
            ));
            for row in &sheet.rows {
                body_xml.push_str("<table:table-row>");
                for cell in row {
                    if let Ok(n) = cell.parse::<f64>() {
                        // Numeric cell: office:value holds the canonical
                        // value, <text:p> holds the display string.
                        body_xml.push_str(&format!(
                            r#"<table:table-cell office:value-type="float" office:value="{}"><text:p>{}</text:p></table:table-cell>"#,
                            n,
                            escape_xml(cell)
                        ));
                    } else {
                        body_xml.push_str(&format!(
                            r#"<table:table-cell office:value-type="string"><text:p>{}</text:p></table:table-cell>"#,
                            escape_xml(cell)
                        ));
                    }
                }
                body_xml.push_str("</table:table-row>");
            }
            body_xml.push_str("</table:table>");
        }
        body_xml.push_str("</office:spreadsheet></office:body></office:document-content>");

        zip.start_file("content.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(body_xml.as_bytes())
            .map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf)
}

/// One bullet line inside a content slide. Supports two wire formats via
/// `#[serde(untagged)]`:
///
///   "First bullet"                              // level 0 (plain string)
///   { "text": "Sub bullet", "level": 1 }        // explicit level
///
/// The plain-string form keeps the common case ergonomic for the model to
/// emit; the object form is only needed when the model wants to nest.
/// Levels 0, 1, 2 are rendered; anything higher is clamped to 2.
#[derive(Clone, Debug)]
pub struct PptxBullet {
    pub text: String,
    pub level: u32,
}

impl<'de> serde::Deserialize<'de> for PptxBullet {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Plain(String),
            Structured { text: String, level: Option<u32> },
        }
        match Raw::deserialize(deserializer)? {
            Raw::Plain(text) => Ok(PptxBullet { text, level: 0 }),
            Raw::Structured { text, level } => Ok(PptxBullet {
                text,
                level: level.unwrap_or(0),
            }),
        }
    }
}

/// Slide layout selector — "content" (default) renders a title + bullet
/// body, "section" renders a single large centered title (plus optional
/// subtitle) with no content body, intended as a section divider between
/// groups of content slides.
#[derive(Clone, Debug, Default, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PptxLayout {
    #[default]
    Content,
    Section,
}

/// Data shape for a single slide in a PPTX / ODP presentation. Shared by
/// both `build_pptx` and `build_odp`. Layout, subtitle, nested bullets,
/// and image were added as optional fields so old callers (and the
/// model's existing mental model of the tool) keep working — a slide
/// that only sets title and a flat list of string bullets behaves
/// exactly as before the extension.
#[derive(serde::Deserialize)]
pub struct PptxSlide {
    pub title: String,
    #[serde(default)]
    pub bullets: Vec<PptxBullet>,
    /// Only used when `layout = Section`. Rendered below the main title
    /// in a smaller font for an optional tagline.
    #[serde(default)]
    pub subtitle: Option<String>,
    /// Relative path (inside the working directory) to an image file to
    /// embed on this slide. Supported extensions: png, jpg, jpeg, gif.
    /// When set, the content area is split — bullets occupy the left
    /// half and the image occupies the right half.
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub layout: PptxLayout,
}

/// Maximum per-image byte budget when embedding into a presentation.
/// Images are loaded into memory and held until the whole deck is
/// serialized, so keeping this modest protects against a single rogue
/// slide blowing memory. 10 MB is generous for a screen-resolution PNG
/// or JPEG.
/// Build a minimal PowerPoint (.pptx) file from a slice of slides. Each
/// slide gets a 32pt bold title at the top and a bullet list below in
/// 18pt text. The generated deck is 16:9 widescreen (12192000 × 6858000
/// EMUs) with a single blank slide layout shared by every slide.
///
/// PPTX is structurally more involved than docx because a presentation
/// requires a master/layout/theme scaffold in addition to the slides
/// themselves. The minimum-viable package is ~10 files even for a single-
/// slide deck, and PowerPoint rejects anything that's missing required
/// pieces. This function hand-rolls all of it in a single pass to avoid
/// pulling in a full OOXML crate.
fn build_pptx(
    slides: &[PptxSlide],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use std::collections::BTreeSet;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    if slides.is_empty() {
        return Err("At least one slide is required".to_string());
    }

    // Walk slides once up front to assign a stable media index to each
    // unique image path. Duplicate paths across slides share the same
    // ppt/media/image{N} file. The resulting `image_index` maps a
    // slide-declared relative path to a 1-based media index; the order
    // is determined by first-appearance in the slides slice so file
    // naming is deterministic.
    let mut ordered_image_paths: Vec<&String> = Vec::new();
    let mut image_index: std::collections::HashMap<&String, usize> =
        std::collections::HashMap::new();
    for slide in slides {
        if let Some(path) = &slide.image {
            if !image_index.contains_key(path) {
                image_index.insert(path, ordered_image_paths.len() + 1);
                ordered_image_paths.push(path);
            }
        }
    }
    // Unique extensions, for the Content_Types Default entries. BTreeSet
    // keeps ordering deterministic in the generated XML.
    let mut unique_exts: BTreeSet<&str> = BTreeSet::new();
    for path in &ordered_image_paths {
        if let Some(img) = images.get(*path) {
            unique_exts.insert(img.extension.as_str());
        }
    }

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // -----------------------------------------------------------
        // 1) [Content_Types].xml — declares the MIME type of every
        //    part in the package. One Override per slide plus one
        //    Default per unique image extension actually used.
        // -----------------------------------------------------------
        let mut content_types = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
"#,
        );
        // Only declare image extensions we actually use — otherwise
        // PowerPoint is fine but LibreOffice warns about unused parts.
        for ext in &unique_exts {
            content_types.push_str(&format!(
                r#"<Default Extension="{}" ContentType="image/{}"/>
"#,
                ext, ext
            ));
        }
        content_types.push_str(
            r#"<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
"#,
        );
        for i in 1..=slides.len() {
            content_types.push_str(&format!(
                r#"<Override PartName="/ppt/slides/slide{}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
"#,
                i
            ));
        }
        content_types.push_str("</Types>");
        zip.start_file("[Content_Types].xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(content_types.as_bytes())
            .map_err(|e| e.to_string())?;

        // -----------------------------------------------------------
        // 2) _rels/.rels — root relationships point to the presentation.
        // -----------------------------------------------------------
        zip.start_file("_rels/.rels", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>"#,
        )
        .map_err(|e| e.to_string())?;

        // -----------------------------------------------------------
        // 3) ppt/presentation.xml — lists slide master + slide IDs,
        //    declares 16:9 slide dimensions.
        // -----------------------------------------------------------
        let mut presentation = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>"#,
        );
        // Slide IDs must be >= 256 per OOXML spec. rId2.. because rId1
        // is used for the slide master.
        for (i, _) in slides.iter().enumerate() {
            presentation.push_str(&format!(
                r#"<p:sldId id="{}" r:id="rId{}"/>"#,
                256 + i,
                2 + i
            ));
        }
        presentation.push_str(
            r#"</p:sldIdLst>
<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>"#,
        );
        zip.start_file("ppt/presentation.xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(presentation.as_bytes())
            .map_err(|e| e.to_string())?;

        // -----------------------------------------------------------
        // 4) ppt/_rels/presentation.xml.rels — master + one slide ref
        //    per slide. rId1 = master, rId2..rId(N+1) = slides.
        // -----------------------------------------------------------
        let mut pres_rels = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
"#,
        );
        for i in 1..=slides.len() {
            pres_rels.push_str(&format!(
                r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{}.xml"/>
"#,
                1 + i,
                i
            ));
        }
        pres_rels.push_str("</Relationships>");
        zip.start_file("ppt/_rels/presentation.xml.rels", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(pres_rels.as_bytes())
            .map_err(|e| e.to_string())?;

        // -----------------------------------------------------------
        // 5) ppt/slideMasters/slideMaster1.xml — minimal master with
        //    an empty shape tree and a color map. Required but we
        //    don't put anything visible on it (each slide carries its
        //    own title and body).
        // -----------------------------------------------------------
        zip.start_file("ppt/slideMasters/slideMaster1.xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>"#,
        )
        .map_err(|e| e.to_string())?;

        // Master rels: points to the layout and theme.
        zip.start_file("ppt/slideMasters/_rels/slideMaster1.xml.rels", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"#,
        )
        .map_err(|e| e.to_string())?;

        // -----------------------------------------------------------
        // 6) ppt/slideLayouts/slideLayout1.xml — single blank layout
        //    shared by every slide in the deck.
        // -----------------------------------------------------------
        zip.start_file("ppt/slideLayouts/slideLayout1.xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>"#,
        )
        .map_err(|e| e.to_string())?;

        zip.start_file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>"#,
        )
        .map_err(|e| e.to_string())?;

        // -----------------------------------------------------------
        // 7) ppt/theme/theme1.xml — minimal but spec-compliant theme.
        //    OOXML requires exactly 3 fill, line, effect, and bg-fill
        //    style entries, hence the triplets below.
        // -----------------------------------------------------------
        zip.start_file("ppt/theme/theme1.xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
<a:themeElements>
<a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Office">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Office">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>"##,
        )
        .map_err(|e| e.to_string())?;

        // -----------------------------------------------------------
        // 7.5) ppt/media/image{N}.{ext} — embed each referenced image
        //      as a binary part. Order matches `ordered_image_paths`
        //      from the upfront indexing pass.
        // -----------------------------------------------------------
        for (i, path) in ordered_image_paths.iter().enumerate() {
            let img = images
                .get(*path)
                .ok_or_else(|| format!("Image not loaded: {}", path))?;
            zip.start_file(
                format!("ppt/media/image{}.{}", i + 1, img.extension),
                options,
            )
            .map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }

        // -----------------------------------------------------------
        // 8) ppt/slides/slide{N}.xml — one per slide, plus its rels.
        //    Layout branches:
        //      Content → title (32pt bold) at top, bullets below;
        //                when an image is attached, bullets occupy the
        //                left half and the image the right half.
        //      Section → single large (44pt bold) centered title with
        //                optional subtitle (24pt) below, no body.
        //    Bullets honor their `level` (0/1/2), each deeper level
        //    gets more left margin and a smaller font.
        //    Positions are in EMUs (914400 per inch).
        // -----------------------------------------------------------
        // EMU constants shared across slides.
        const SLIDE_CX: i64 = 12192000; // 13.33"
        const FULL_BULLET_CX: i64 = 11277600; // full content width
        const HALF_BULLET_CX: i64 = 5486400; // ~6" — left half when image present
        const BULLET_Y: i64 = 1828800; // 2" from top
        const BULLET_CY: i64 = 4572000; // ~5"
        const IMAGE_X: i64 = 6400800; // start of right half
        const IMAGE_Y: i64 = 1828800;
        const IMAGE_CX: i64 = 5334000; // ~5.83"
        const IMAGE_CY: i64 = 4000500; // ~4.38"

        for (i, slide) in slides.iter().enumerate() {
            let slide_num = i + 1;
            let title_escaped = escape_xml(slide.title.trim());
            let mut slide_xml = String::from(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
"#,
            );

            match slide.layout {
                PptxLayout::Section => {
                    // Single large centered title, horizontally and
                    // vertically anchored in the middle of the slide.
                    // Title box is centered in the slide's full width.
                    let title_cx: i64 = 10287000; // ~11.25"
                    let title_x: i64 = (SLIDE_CX - title_cx) / 2;
                    slide_xml.push_str(&format!(
                        r#"<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="SectionTitle"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr>
<a:xfrm><a:off x="{}" y="2286000"/><a:ext cx="{}" cy="1524000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
<p:txBody>
<a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/>
<a:lstStyle/>
<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="4400" b="1"/><a:t>{}</a:t></a:r></a:p>
</p:txBody>
</p:sp>
"#,
                        title_x, title_cx, title_escaped
                    ));

                    // Optional subtitle below the main title.
                    if let Some(subtitle) = slide
                        .subtitle
                        .as_ref()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                    {
                        slide_xml.push_str(&format!(
                            r#"<p:sp>
<p:nvSpPr><p:cNvPr id="3" name="Subtitle"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr>
<a:xfrm><a:off x="{}" y="3962400"/><a:ext cx="{}" cy="762000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
<p:txBody>
<a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/>
<a:lstStyle/>
<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="2400"/><a:t>{}</a:t></a:r></a:p>
</p:txBody>
</p:sp>
"#,
                            title_x,
                            title_cx,
                            escape_xml(subtitle)
                        ));
                    }
                }
                PptxLayout::Content => {
                    // Title at top — full width, 32pt bold.
                    slide_xml.push_str(&format!(
                        r#"<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr>
<a:xfrm><a:off x="457200" y="457200"/><a:ext cx="11277600" cy="1143000"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
<p:txBody>
<a:bodyPr wrap="square" rtlCol="0" anchor="t"/>
<a:lstStyle/>
<a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>{}</a:t></a:r></a:p>
</p:txBody>
</p:sp>
"#,
                        title_escaped
                    ));

                    // Body bullets. Width shrinks when an image is
                    // attached so the two shapes don't overlap.
                    let has_image = slide.image.is_some();
                    let bullet_cx = if has_image {
                        HALF_BULLET_CX
                    } else {
                        FULL_BULLET_CX
                    };
                    slide_xml.push_str(&format!(
                        r#"<p:sp>
<p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr>
<a:xfrm><a:off x="457200" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
<p:txBody>
<a:bodyPr wrap="square" rtlCol="0" anchor="t"/>
<a:lstStyle/>
"#,
                        BULLET_Y, bullet_cx, BULLET_CY
                    ));
                    if slide.bullets.is_empty() {
                        // An empty text body still needs at least one
                        // paragraph or PowerPoint complains about the shape.
                        slide_xml.push_str("<a:p/>");
                    } else {
                        for bullet in &slide.bullets {
                            let level = bullet.level.min(2);
                            // Per-level spacing and font size. Level 0 =
                            // 18pt, Level 1 = 16pt, Level 2 = 14pt.
                            let (mar_l, sz) = match level {
                                0 => (457200, 1800),
                                1 => (914400, 1600),
                                _ => (1371600, 1400),
                            };
                            slide_xml.push_str(&format!(
                                r#"<a:p><a:pPr marL="{}" indent="-457200" lvl="{}"><a:buChar char="-"/></a:pPr><a:r><a:rPr lang="en-US" sz="{}"/><a:t>{}</a:t></a:r></a:p>"#,
                                mar_l,
                                level,
                                sz,
                                escape_xml(bullet.text.trim())
                            ));
                        }
                    }
                    slide_xml.push_str("</p:txBody></p:sp>\n");

                    // Optional image on the right half.
                    if let Some(image_path) = &slide.image {
                        slide_xml.push_str(&format!(
                            r#"<p:pic>
<p:nvPicPr><p:cNvPr id="4" name="Image"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr>
<a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
</p:spPr>
</p:pic>
"#,
                            IMAGE_X, IMAGE_Y, IMAGE_CX, IMAGE_CY
                        ));
                        // Silence unused warning in the else branch —
                        // image_path is used implicitly via rId2 which
                        // the slide rels below assigns based on this
                        // same slide.image check.
                        let _ = image_path;
                    }
                }
            }

            slide_xml.push_str("</p:spTree></p:cSld></p:sld>");

            zip.start_file(format!("ppt/slides/slide{}.xml", slide_num), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(slide_xml.as_bytes())
                .map_err(|e| e.to_string())?;

            // Slide rels: always points to the shared layout as rId1,
            // plus an image relationship as rId2 when the slide has one.
            let mut slide_rels = String::from(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
"#,
            );
            if let Some(image_path) = &slide.image {
                let idx = image_index
                    .get(image_path)
                    .copied()
                    .ok_or_else(|| format!("Image index missing for {}", image_path))?;
                let ext = images
                    .get(image_path)
                    .map(|i| i.extension.as_str())
                    .ok_or_else(|| format!("Image not loaded: {}", image_path))?;
                slide_rels.push_str(&format!(
                    r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image{}.{}"/>
"#,
                    idx, ext
                ));
            }
            slide_rels.push_str("</Relationships>");
            zip.start_file(
                format!("ppt/slides/_rels/slide{}.xml.rels", slide_num),
                options,
            )
            .map_err(|e| e.to_string())?;
            zip.write_all(slide_rels.as_bytes())
                .map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf)
}

/// Build a minimal OpenDocument Presentation (.odp) file from a slice of
/// slides. Same input model as `build_pptx`: a `PptxSlide` with a title,
/// optional subtitle, bullet list with per-bullet levels, optional image,
/// and a layout choice (content or section). Reuses the ODF zip
/// scaffolding from `build_odt` (STORED mimetype first, manifest, meta,
/// styles, content).
fn build_odp(
    slides: &[PptxSlide],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    if slides.is_empty() {
        return Err("At least one slide is required".to_string());
    }

    // Assign a stable index to each unique image path — same logic as
    // build_pptx. ODP puts the media files under Pictures/ and references
    // them by relative path in content.xml and manifest.xml.
    let mut ordered_image_paths: Vec<&String> = Vec::new();
    let mut image_index: std::collections::HashMap<&String, usize> =
        std::collections::HashMap::new();
    for slide in slides {
        if let Some(path) = &slide.image {
            if !image_index.contains_key(path) {
                image_index.insert(path, ordered_image_paths.len() + 1);
                ordered_image_paths.push(path);
            }
        }
    }

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let stored =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflated =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // 1) mimetype — STORED, first entry
        zip.start_file("mimetype", stored)
            .map_err(|e| e.to_string())?;
        zip.write_all(b"application/vnd.oasis.opendocument.presentation")
            .map_err(|e| e.to_string())?;

        // 2) manifest.xml — enumerates every file in the package
        //    (core parts + one Pictures/ entry per image).
        let mut manifest = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
"#,
        );
        for (i, path) in ordered_image_paths.iter().enumerate() {
            let img = images
                .get(*path)
                .ok_or_else(|| format!("Image not loaded: {}", path))?;
            manifest.push_str(&format!(
                r#"<manifest:file-entry manifest:full-path="Pictures/image{}.{}" manifest:media-type="image/{}"/>
"#,
                i + 1,
                img.extension,
                img.extension
            ));
        }
        manifest.push_str("</manifest:manifest>");
        zip.start_file("META-INF/manifest.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(manifest.as_bytes())
            .map_err(|e| e.to_string())?;

        // 3) meta.xml
        zip.start_file("meta.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2">
<office:meta><meta:generator>Haruspex</meta:generator></office:meta>
</office:document-meta>"#,
        )
        .map_err(|e| e.to_string())?;

        // 4) styles.xml — widescreen page layout + master page. Body
        //    paragraph styles are defined in content.xml's automatic
        //    style section so they can be tweaked per-deck if needed.
        zip.start_file("styles.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br##"<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2">
<office:styles>
<style:default-style style:family="paragraph"><style:text-properties fo:font-size="18pt"/></style:default-style>
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="PageLayout1">
<style:page-layout-properties fo:page-width="25.4cm" fo:page-height="14.288cm" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" style:print-orientation="landscape"/>
</style:page-layout>
</office:automatic-styles>
<office:master-styles>
<style:master-page style:name="Default" style:page-layout-name="PageLayout1"/>
</office:master-styles>
</office:document-styles>"##,
        )
        .map_err(|e| e.to_string())?;

        // 5) content.xml — one <draw:page> per slide.
        //    Automatic styles declare:
        //      - TitleText (28pt bold) for content-slide titles
        //      - SectionTitle (40pt bold, centered) for section slides
        //      - BulletText0/1/2 — nested bullets with increasing
        //        fo:margin-left and decreasing font size
        let mut body = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">
<office:automatic-styles>
<style:style style:name="TitleText" style:family="paragraph"><style:text-properties fo:font-size="28pt" fo:font-weight="bold"/></style:style>
<style:style style:name="SectionTitle" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="40pt" fo:font-weight="bold"/></style:style>
<style:style style:name="SectionSubtitle" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="22pt"/></style:style>
<style:style style:name="BulletText0" style:family="paragraph"><style:paragraph-properties fo:margin-left="0cm"/><style:text-properties fo:font-size="18pt"/></style:style>
<style:style style:name="BulletText1" style:family="paragraph"><style:paragraph-properties fo:margin-left="1cm"/><style:text-properties fo:font-size="16pt"/></style:style>
<style:style style:name="BulletText2" style:family="paragraph"><style:paragraph-properties fo:margin-left="2cm"/><style:text-properties fo:font-size="14pt"/></style:style>
</office:automatic-styles>
<office:body><office:presentation>
"#,
        );
        for (i, slide) in slides.iter().enumerate() {
            body.push_str(&format!(
                r#"<draw:page draw:name="Slide{}" draw:master-page-name="Default">
"#,
                i + 1
            ));

            match slide.layout {
                PptxLayout::Section => {
                    // Centered title frame in the vertical middle of the
                    // slide. 25.4cm wide slide → title frame 23cm wide at
                    // x=1.2cm is effectively centered.
                    body.push_str(&format!(
                        r#"<draw:frame svg:x="1.2cm" svg:y="5cm" svg:width="23cm" svg:height="2.5cm"><draw:text-box><text:p text:style-name="SectionTitle">{}</text:p></draw:text-box></draw:frame>
"#,
                        escape_xml(slide.title.trim())
                    ));
                    if let Some(subtitle) = slide
                        .subtitle
                        .as_ref()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                    {
                        body.push_str(&format!(
                            r#"<draw:frame svg:x="1.2cm" svg:y="8cm" svg:width="23cm" svg:height="1.5cm"><draw:text-box><text:p text:style-name="SectionSubtitle">{}</text:p></draw:text-box></draw:frame>
"#,
                            escape_xml(subtitle)
                        ));
                    }
                }
                PptxLayout::Content => {
                    // Title frame — full width at the top.
                    body.push_str(&format!(
                        r#"<draw:frame svg:x="1cm" svg:y="0.8cm" svg:width="23cm" svg:height="2cm"><draw:text-box><text:p text:style-name="TitleText">{}</text:p></draw:text-box></draw:frame>
"#,
                        escape_xml(slide.title.trim())
                    ));

                    // Bullet frame width shrinks to the left half when
                    // an image is attached. Full width: 23cm. Split
                    // width: 11cm left, 11cm right with 1cm gap.
                    let has_image = slide.image.is_some();
                    let bullet_width = if has_image { "11cm" } else { "23cm" };
                    body.push_str(&format!(
                        r#"<draw:frame svg:x="1cm" svg:y="3.2cm" svg:width="{}" svg:height="10cm"><draw:text-box>
"#,
                        bullet_width
                    ));
                    if slide.bullets.is_empty() {
                        body.push_str("<text:p/>");
                    } else {
                        for bullet in &slide.bullets {
                            let level = bullet.level.min(2);
                            body.push_str(&format!(
                                r#"<text:p text:style-name="BulletText{}">- {}</text:p>
"#,
                                level,
                                escape_xml(bullet.text.trim())
                            ));
                        }
                    }
                    body.push_str("</draw:text-box></draw:frame>\n");

                    // Image frame on the right half.
                    if let Some(image_path) = &slide.image {
                        let idx = image_index
                            .get(image_path)
                            .copied()
                            .ok_or_else(|| format!("Image index missing for {}", image_path))?;
                        let ext = images
                            .get(image_path)
                            .map(|i| i.extension.as_str())
                            .ok_or_else(|| format!("Image not loaded: {}", image_path))?;
                        body.push_str(&format!(
                            r#"<draw:frame svg:x="13cm" svg:y="3.2cm" svg:width="11cm" svg:height="9cm"><draw:image xlink:href="Pictures/image{}.{}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>
"#,
                            idx, ext
                        ));
                    }
                }
            }

            body.push_str("</draw:page>\n");
        }
        body.push_str("</office:presentation></office:body></office:document-content>");

        zip.start_file("content.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;

        // 6) Pictures/image{N}.{ext} — embed the binary image files.
        for (i, path) in ordered_image_paths.iter().enumerate() {
            let img = images
                .get(*path)
                .ok_or_else(|| format!("Image not loaded: {}", path))?;
            zip.start_file(
                format!("Pictures/image{}.{}", i + 1, img.extension),
                deflated,
            )
            .map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf)
}


/// Build a simple PDF from markdown-ish text. Supports:
///   - `#`, `##`, `###` headings (rendered bold, larger)
///   - `**bold**`, `*italic*`, `` `code` ``, `[text](url)` inline markdown
///   - `-` / `*` / `+` bullet lists (converted to `•`)
///   - `![alt](path)` on a line by itself — embeds the referenced image
///     pre-loaded into `images` (paths point into the workdir)
///
/// Content is word-wrapped to fit the page and flows across multiple pages.
fn build_pdf(
    lines: &[&str],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use printpdf::*;

    let mut doc = PdfDocument::new("Document");

    // Register each unique referenced image with the PDF document once,
    // up front, so the rendering loop only has to do lookups and emit
    // `Op::UseXobject` ops. We track natural pixel dimensions alongside
    // each XObjectId so the renderer can preserve aspect ratio.
    let mut registered_images: std::collections::HashMap<String, (XObjectId, u32, u32)> =
        std::collections::HashMap::new();
    for (path, img) in images {
        let mut warnings = Vec::new();
        let raw = RawImage::decode_from_bytes(&img.bytes, &mut warnings)
            .map_err(|e| format!("Failed to decode image {}: {}", path, e))?;
        let (w, h) = (raw.width as u32, raw.height as u32);
        let id = doc.add_image(&raw);
        registered_images.insert(path.clone(), (id, w, h));
    }

    // US Letter: 215.9 mm × 279.4 mm. Keep a 20 mm margin on all sides.
    let page_width_mm = 215.9_f32;
    let page_height_mm = 279.4_f32;
    let margin_mm = 20.0_f32;
    let content_width_mm = page_width_mm - (margin_mm * 2.0);

    // Font sizes (points)
    let body_pt = 11.0_f32;
    let h1_pt = 20.0_f32;
    let h2_pt = 16.0_f32;
    let h3_pt = 13.0_f32;

    // Approximate character width in points for Helvetica at given size.
    fn char_width_pt(font_pt: f32) -> f32 {
        font_pt * 0.55
    }

    // Convert mm to Pt (1 mm ≈ 2.8346 pt)
    let mm_to_pt = 2.834_645_7_f32;
    let content_width_pt = content_width_mm * mm_to_pt;

    fn classify(line: &str, h1: f32, h2: f32, h3: f32, body: f32) -> (String, f32, f32, bool) {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            (rest.to_string(), h1, h1 * 0.5, true)
        } else if let Some(rest) = trimmed.strip_prefix("## ") {
            (rest.to_string(), h2, h2 * 0.5, true)
        } else if let Some(rest) = trimmed.strip_prefix("### ") {
            (rest.to_string(), h3, h3 * 0.5, true)
        } else {
            (line.to_string(), body, body * 0.4, false)
        }
    }

    /// Font family selector — Helvetica for normal prose, Courier for
    /// monospace tables where column alignment via space padding matters.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum FontFamily {
        Helvetica,
        Courier,
    }

    fn pick_font(family: FontFamily, bold: bool, italic: bool) -> printpdf::BuiltinFont {
        use printpdf::BuiltinFont::*;
        match (family, bold, italic) {
            (FontFamily::Helvetica, true, true) => HelveticaBoldOblique,
            (FontFamily::Helvetica, true, false) => HelveticaBold,
            (FontFamily::Helvetica, false, true) => HelveticaOblique,
            (FontFamily::Helvetica, false, false) => Helvetica,
            (FontFamily::Courier, true, true) => CourierBoldOblique,
            (FontFamily::Courier, true, false) => CourierBold,
            (FontFamily::Courier, false, true) => CourierOblique,
            (FontFamily::Courier, false, false) => Courier,
        }
    }

    let top_y_mm = page_height_mm - margin_mm;
    let bottom_y_mm = margin_mm;
    let margin_pt = margin_mm * mm_to_pt;

    let mut all_pages: Vec<PdfPage> = Vec::new();
    let mut current_ops: Vec<Op> = Vec::new();
    let mut cursor_y_mm = top_y_mm;

    // Helper: emit page-start ops. `Op::SetTextCursor` serializes to the PDF
    // `Td` operator which is RELATIVE, so we can't use it for absolute
    // positioning. `Op::SetTextMatrix(Translate(x, y))` serializes to `Tm`
    // which is absolute in page coordinates (origin at bottom-left).
    fn start_page_ops(ops: &mut Vec<printpdf::Op>) {
        use printpdf::*;
        ops.push(Op::SaveGraphicsState);
        ops.push(Op::StartTextSection);
        // Black fill so text is visible (default is actually black but be explicit)
        ops.push(Op::SetFillColor {
            col: Color::Rgb(Rgb {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                icc_profile: None,
            }),
        });
    }

    fn finish_page_ops(ops: &mut Vec<printpdf::Op>) {
        use printpdf::*;
        ops.push(Op::EndTextSection);
        ops.push(Op::RestoreGraphicsState);
    }

    start_page_ops(&mut current_ops);

    // (font_pt, family, bold, italic) — tracks the last SetFont op so we
    // can avoid re-emitting it when the next run has the same style.
    let mut last_font: Option<(u32, FontFamily, bool, bool)> = None;

    // Preprocess: split the input into DocumentBlocks. Markdown tables
    // become MonoBlocks (aligned monospace), everything else becomes Line.
    let preprocessed = preprocess_lines(lines);

    // Helper that emits a page break at the current cursor position. Used
    // when a line won't fit in the remaining vertical space. Horizontal
    // rules (`---`) are NOT treated as page breaks — they're skipped
    // entirely, since in markdown they're typically section dividers, and
    // forcing a page break on every divider produced too many pages.
    let page_break = |current_ops: &mut Vec<Op>,
                      all_pages: &mut Vec<PdfPage>,
                      cursor_y_mm: &mut f32,
                      last_font: &mut Option<(u32, FontFamily, bool, bool)>| {
        finish_page_ops(current_ops);
        all_pages.push(PdfPage::new(
            Mm(page_width_mm),
            Mm(page_height_mm),
            std::mem::take(current_ops),
        ));
        *cursor_y_mm = top_y_mm;
        start_page_ops(current_ops);
        *last_font = None;
    };

    for block in &preprocessed {
        match block {
            DocumentBlock::Line(line) => {
                if line.trim().is_empty() {
                    cursor_y_mm -= 4.0;
                    continue;
                }

                // Horizontal rules (`---`, `***`, `___`) are treated as
                // visual section dividers with a bit of extra spacing — NOT
                // page breaks. The previous `--- = page break` rule pushed
                // every divider to a new page, which generated 5–10 page
                // breaks in a single report.
                if is_horizontal_rule(line) {
                    cursor_y_mm -= 4.0;
                    continue;
                }

                // Fold Unicode to ASCII before anything else sees the line
                // so the PDF only ever contains ASCII bytes (sidesteps the
                // lopdf WinAnsi bug documented in `ascii_fold_for_pdf`).
                let folded = ascii_fold_for_pdf(line);

                let (text_after_heading, font_pt, spacing_after_pt, is_heading) =
                    classify(&folded, h1_pt, h2_pt, h3_pt, body_pt);

                // Always run inline parsing, even for headings. Models
                // routinely emit `### **Section Title**` — if we skipped
                // inline parsing inside headings the literal `**` would
                // end up rendered in the PDF. Force `bold = true` on every
                // resulting run so the heading stays visually bold
                // regardless of its markdown shape.
                let runs = if is_heading {
                    let mut parsed = parse_inline_markdown(&text_after_heading);
                    if parsed.is_empty() {
                        parsed.push(InlineRun {
                            text: text_after_heading,
                            bold: true,
                            italic: false,
                        });
                    } else {
                        for run in &mut parsed {
                            run.bold = true;
                        }
                    }
                    parsed
                } else {
                    let normalized = normalize_list_marker(&text_after_heading);
                    parse_inline_markdown(&normalized)
                };

                let words = runs_to_words(&runs);
                if words.is_empty() {
                    cursor_y_mm -= spacing_after_pt / mm_to_pt;
                    continue;
                }

                let max_chars =
                    ((content_width_pt / char_width_pt(font_pt)).floor() as usize).max(1);
                let wrapped_lines = wrap_styled_words(&words, max_chars);
                let line_height_mm = (font_pt * 1.2) / mm_to_pt;
                let font_pt_key = font_pt.to_bits();

                for wrapped_line in wrapped_lines {
                    if cursor_y_mm - line_height_mm < bottom_y_mm {
                        page_break(
                            &mut current_ops,
                            &mut all_pages,
                            &mut cursor_y_mm,
                            &mut last_font,
                        );
                    }

                    let baseline_pt = (cursor_y_mm - line_height_mm) * mm_to_pt + (font_pt * 0.2);
                    current_ops.push(Op::SetTextMatrix {
                        matrix: TextMatrix::Translate(Pt(margin_pt), Pt(baseline_pt)),
                    });

                    for (idx, sw) in wrapped_line.iter().enumerate() {
                        let bold = sw.bold;
                        let italic = sw.italic;
                        let key = (font_pt_key, FontFamily::Helvetica, bold, italic);
                        if last_font != Some(key) {
                            let font = pick_font(FontFamily::Helvetica, bold, italic);
                            current_ops.push(Op::SetFont {
                                font: PdfFontHandle::Builtin(font),
                                size: Pt(font_pt),
                            });
                            current_ops.push(Op::SetLineHeight {
                                lh: Pt(font_pt * 1.2),
                            });
                            last_font = Some(key);
                        }

                        let piece = if idx == 0 {
                            sw.word.clone()
                        } else {
                            format!(" {}", sw.word)
                        };
                        current_ops.push(Op::ShowText {
                            items: vec![TextItem::Text(piece)],
                        });
                    }

                    cursor_y_mm -= line_height_mm;
                }

                cursor_y_mm -= spacing_after_pt / mm_to_pt;
            }

            DocumentBlock::MonoBlock(mono_lines) => {
                // Tables render as pre-aligned monospace lines in Courier.
                // The line text already contains exact column padding from
                // `format_table_as_monoblock`, so we emit each line as one
                // ShowText op at the correct baseline with no inline parsing
                // or wrapping.
                let font_pt = body_pt;
                let line_height_mm = (font_pt * 1.2) / mm_to_pt;
                let font_pt_key = font_pt.to_bits();

                // Small visual gap before the table.
                cursor_y_mm -= 2.0;

                for mono in mono_lines {
                    if cursor_y_mm - line_height_mm < bottom_y_mm {
                        page_break(
                            &mut current_ops,
                            &mut all_pages,
                            &mut cursor_y_mm,
                            &mut last_font,
                        );
                    }

                    let bold = mono.bold;
                    let key = (font_pt_key, FontFamily::Courier, bold, false);
                    if last_font != Some(key) {
                        let font = pick_font(FontFamily::Courier, bold, false);
                        current_ops.push(Op::SetFont {
                            font: PdfFontHandle::Builtin(font),
                            size: Pt(font_pt),
                        });
                        current_ops.push(Op::SetLineHeight {
                            lh: Pt(font_pt * 1.2),
                        });
                        last_font = Some(key);
                    }

                    let baseline_pt = (cursor_y_mm - line_height_mm) * mm_to_pt + (font_pt * 0.2);
                    current_ops.push(Op::SetTextMatrix {
                        matrix: TextMatrix::Translate(Pt(margin_pt), Pt(baseline_pt)),
                    });

                    // Fold non-ASCII (same WinAnsi bug defense as Line path).
                    let text = ascii_fold_for_pdf(&mono.text);
                    current_ops.push(Op::ShowText {
                        items: vec![TextItem::Text(text)],
                    });

                    cursor_y_mm -= line_height_mm;
                }

                // Small visual gap after the table.
                cursor_y_mm -= 3.0;
            }
            DocumentBlock::Image(path, opts) => {
                // Look up the pre-registered image. If it's missing (loading
                // failed earlier or the model referenced a path we didn't
                // load), render a one-line italic placeholder so the
                // document still flows.
                let Some(&(ref image_id, px_w, px_h)) = registered_images.get(path) else {
                    let line_height_mm = (body_pt * 1.2) / mm_to_pt;
                    if cursor_y_mm - line_height_mm < bottom_y_mm {
                        page_break(
                            &mut current_ops,
                            &mut all_pages,
                            &mut cursor_y_mm,
                            &mut last_font,
                        );
                    }
                    let font_pt_key = body_pt.to_bits();
                    let key = (font_pt_key, FontFamily::Helvetica, false, true);
                    if last_font != Some(key) {
                        current_ops.push(Op::SetFont {
                            font: PdfFontHandle::Builtin(pick_font(
                                FontFamily::Helvetica,
                                false,
                                true,
                            )),
                            size: Pt(body_pt),
                        });
                        last_font = Some(key);
                    }
                    let baseline_pt = (cursor_y_mm - line_height_mm) * mm_to_pt + (body_pt * 0.2);
                    current_ops.push(Op::SetTextMatrix {
                        matrix: TextMatrix::Translate(Pt(margin_pt), Pt(baseline_pt)),
                    });
                    let placeholder = format!("[image: {}]", path);
                    current_ops.push(Op::ShowText {
                        items: vec![TextItem::Text(ascii_fold_for_pdf(&placeholder))],
                    });
                    cursor_y_mm -= line_height_mm;
                    continue;
                };

                // Compute display size in points. Treat the bitmap's native
                // pixel size as 96 dpi (a reasonable default for screenshots
                // and matplotlib output). If the user specified width%, that
                // becomes a fraction of the content width; otherwise fit
                // to content width on overflow. Aspect ratio is preserved.
                let dpi = 96.0_f32;
                let natural_w_pt = (px_w as f32) * (72.0 / dpi);
                let natural_h_pt = (px_h as f32) * (72.0 / dpi);
                let (display_w_pt, display_h_pt) = match opts.width_fraction {
                    Some(frac) => {
                        let w = content_width_pt * frac;
                        let h = if natural_w_pt > 0.0 {
                            natural_h_pt * (w / natural_w_pt)
                        } else {
                            natural_h_pt
                        };
                        (w, h)
                    }
                    None => {
                        let scale = (content_width_pt / natural_w_pt).min(1.0);
                        (natural_w_pt * scale, natural_h_pt * scale)
                    }
                };
                let display_h_mm = display_h_pt / mm_to_pt;
                let translate_x_pt = match opts.alignment {
                    ImageAlignment::Left => margin_pt,
                    ImageAlignment::Center => margin_pt + (content_width_pt - display_w_pt) / 2.0,
                    ImageAlignment::Right => margin_pt + (content_width_pt - display_w_pt),
                };

                // Force a page break if the image won't fit in the remaining
                // vertical space. Don't try to shrink past natural size to fit
                // — the page break preserves intent better than a tiny image.
                if cursor_y_mm - display_h_mm < bottom_y_mm {
                    page_break(
                        &mut current_ops,
                        &mut all_pages,
                        &mut cursor_y_mm,
                        &mut last_font,
                    );
                }

                // Small vertical gap above the image so it doesn't kiss the
                // line of text immediately above.
                cursor_y_mm -= 2.0;

                let y_baseline_pt = (cursor_y_mm - display_h_mm) * mm_to_pt;

                // printpdf draws raster XObjects outside the text section. We
                // close the section, emit the image op, then reopen it so the
                // following text blocks render correctly. SetFont state is
                // section-scoped, so reset our tracker.
                current_ops.push(Op::EndTextSection);
                // printpdf 0.9 applies a baseline px-to-pt transform at
                // `dpi` *first*, then multiplies by `scale_x`/`scale_y`.
                // With dpi=None (default 300), 1 px = 0.24 pt up front;
                // a "scale 0.5" then meant "half of natural-at-300dpi",
                // not "half of an inch worth of pixels". We tell printpdf
                // to treat the bitmap as 96 dpi (a screenshot/matplotlib
                // assumption that lines up with `natural_w_pt` below) and
                // pass `scale_x` as the fraction of *that* baseline we
                // want. The two together produce display_w_pt exactly.
                current_ops.push(Op::UseXobject {
                    id: image_id.clone(),
                    transform: XObjectTransform {
                        translate_x: Some(Pt(translate_x_pt)),
                        translate_y: Some(Pt(y_baseline_pt)),
                        rotate: None,
                        scale_x: Some(display_w_pt / natural_w_pt),
                        scale_y: Some(display_h_pt / natural_h_pt),
                        dpi: Some(dpi),
                    },
                });
                current_ops.push(Op::StartTextSection);
                last_font = None;

                cursor_y_mm -= display_h_mm;
                cursor_y_mm -= 3.0;
            }
        }
    }

    finish_page_ops(&mut current_ops);
    all_pages.push(PdfPage::new(
        Mm(page_width_mm),
        Mm(page_height_mm),
        current_ops,
    ));

    let bytes = doc
        .with_pages(all_pages)
        .save(&PdfSaveOptions::default(), &mut Vec::new());

    Ok(bytes)
}

#[tauri::command]
pub async fn fs_write_pdf(
    workdir: String,
    rel_path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("Content too large ({} bytes)", content.len()));
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    // Pre-load every `![alt](path)` image while we still have async runtime
    // access. build_pdf itself does no I/O.
    let images = load_markdown_images(&workdir, &content)?;

    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let lines: Vec<&str> = content.lines().collect();
        build_pdf(&lines, &images)
    })
    .await
    .map_err(|e| format!("PDF build task failed: {}", e))??;

    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    fs::write(&resolved, bytes)
        .await
        .map_err(|e| format!("Failed to write PDF: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn fs_write_docx(
    workdir: String,
    rel_path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("Content too large ({} bytes)", content.len()));
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    let images = load_markdown_images(&workdir, &content)?;

    // Split content into paragraphs on newlines, drop empty lines
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let paragraphs: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        build_docx(&paragraphs, &images)
    })
    .await
    .map_err(|e| format!("docx build task failed: {}", e))??;

    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    fs::write(&resolved, bytes)
        .await
        .map_err(|e| format!("Failed to write docx: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn fs_write_odt(
    workdir: String,
    rel_path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("Content too large ({} bytes)", content.len()));
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    let images = load_markdown_images(&workdir, &content)?;

    // Same markdown-ish line model as fs_write_docx: split on newlines,
    // drop empties, pass through build_odt for the zip+ODF packaging.
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let paragraphs: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        build_odt(&paragraphs, &images)
    })
    .await
    .map_err(|e| format!("odt build task failed: {}", e))??;

    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    fs::write(&resolved, bytes)
        .await
        .map_err(|e| format!("Failed to write odt: {}", e))?;
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct XlsxSheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

#[tauri::command]
pub async fn fs_write_xlsx(
    workdir: String,
    rel_path: String,
    sheets: Vec<XlsxSheet>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if sheets.is_empty() {
        return Err("At least one sheet is required".to_string());
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    let resolved_str = resolved.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use rust_xlsxwriter::Workbook;

        let mut workbook = Workbook::new();
        for sheet_data in &sheets {
            let worksheet = workbook.add_worksheet();
            worksheet
                .set_name(&sheet_data.name)
                .map_err(|e| format!("Failed to set sheet name: {}", e))?;
            for (row_idx, row) in sheet_data.rows.iter().enumerate() {
                for (col_idx, cell) in row.iter().enumerate() {
                    // Try to parse as number first, else write as string
                    if let Ok(n) = cell.parse::<f64>() {
                        worksheet
                            .write_number(row_idx as u32, col_idx as u16, n)
                            .map_err(|e| format!("Failed to write cell: {}", e))?;
                    } else {
                        worksheet
                            .write_string(row_idx as u32, col_idx as u16, cell)
                            .map_err(|e| format!("Failed to write cell: {}", e))?;
                    }
                }
            }
        }
        workbook
            .save(&resolved_str)
            .map_err(|e| format!("Failed to save xlsx: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("xlsx write task failed: {}", e))??;

    Ok(())
}

#[tauri::command]
pub async fn fs_write_ods(
    workdir: String,
    rel_path: String,
    sheets: Vec<XlsxSheet>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if sheets.is_empty() {
        return Err("At least one sheet is required".to_string());
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    // Reuse XlsxSheet since the data shape (name + rows of strings) is
    // identical for both xlsx and ods. Hand-rolled zip+ODF packaging
    // lives in build_ods — no extra crate dependency.
    let bytes =
        tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> { build_ods(&sheets) })
            .await
            .map_err(|e| format!("ods build task failed: {}", e))??;

    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    fs::write(&resolved, bytes)
        .await
        .map_err(|e| format!("Failed to write ods: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn fs_write_pptx(
    workdir: String,
    rel_path: String,
    slides: Vec<PptxSlide>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if slides.is_empty() {
        return Err("At least one slide is required".to_string());
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    // Pre-load every referenced image while we still have the workdir
    // and the async runtime. The build function itself does no I/O.
    let images = load_image_set(&workdir, slides.iter().filter_map(|s| s.image.clone()))?;

    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        build_pptx(&slides, &images)
    })
    .await
    .map_err(|e| format!("pptx build task failed: {}", e))??;

    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    fs::write(&resolved, bytes)
        .await
        .map_err(|e| format!("Failed to write pptx: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn fs_write_odp(
    workdir: String,
    rel_path: String,
    slides: Vec<PptxSlide>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if slides.is_empty() {
        return Err("At least one slide is required".to_string());
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    // ODP reuses the same PptxSlide struct since the data shape (title
    // + bullet list + optional image) is format-agnostic. Hand-rolled
    // ODF packaging in build_odp.
    let images = load_image_set(&workdir, slides.iter().filter_map(|s| s.image.clone()))?;

    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        build_odp(&slides, &images)
    })
    .await
    .map_err(|e| format!("odp build task failed: {}", e))??;

    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    fs::write(&resolved, bytes)
        .await
        .map_err(|e| format!("Failed to write odp: {}", e))?;
    Ok(())
}

/// Return the raw bytes of a PDF file as base64, for rendering via PDF.js
/// in the frontend. Sandboxed like all fs commands.
#[tauri::command]
pub async fn fs_read_pdf_bytes(workdir: String, rel_path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }

    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_PDF_READ_BYTES {
        return Err(format!(
            "PDF too large ({} bytes). Maximum is {} bytes.",
            metadata.len(),
            MAX_PDF_READ_BYTES
        ));
    }

    let bytes = fs::read(&resolved)
        .await
        .map_err(|e| format!("Failed to read PDF: {}", e))?;

    // Verify it looks like a PDF (starts with %PDF)
    if bytes.len() < 4 || &bytes[..4] != b"%PDF" {
        return Err("File does not appear to be a valid PDF".to_string());
    }

    Ok(B64.encode(&bytes))
}

#[tauri::command]
pub async fn fs_read_docx(workdir: String, rel_path: String) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }

    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    // docx size limit: 50 MB (same as PDF)
    if metadata.len() > MAX_PDF_READ_BYTES {
        return Err(format!(
            "docx too large ({} bytes). Maximum is {} bytes.",
            metadata.len(),
            MAX_PDF_READ_BYTES
        ));
    }

    let resolved_clone = resolved.clone();
    let text = tokio::task::spawn_blocking(move || extract_docx_text(&resolved_clone))
        .await
        .map_err(|e| format!("docx extraction task failed: {}", e))??;

    if text.is_empty() {
        return Err("docx has no extractable text".to_string());
    }

    Ok(text)
}

#[tauri::command]
pub async fn fs_read_xlsx(
    workdir: String,
    rel_path: String,
    sheet: Option<String>,
) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }

    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_PDF_READ_BYTES {
        return Err(format!(
            "xlsx too large ({} bytes). Maximum is {} bytes.",
            metadata.len(),
            MAX_PDF_READ_BYTES
        ));
    }

    let resolved_clone = resolved.clone();
    let sheet_name = sheet.clone();
    let csv = tokio::task::spawn_blocking(move || -> Result<String, String> {
        use calamine::{open_workbook_auto, Data, Reader};

        let mut workbook = open_workbook_auto(&resolved_clone)
            .map_err(|e| format!("Failed to open xlsx: {}", e))?;

        let sheet_names = workbook.sheet_names().to_vec();
        if sheet_names.is_empty() {
            return Err("xlsx has no sheets".to_string());
        }

        // Pick sheet: named if specified, else the first
        let target_sheet = match sheet_name {
            Some(name) => {
                if !sheet_names.iter().any(|s| s == &name) {
                    return Err(format!(
                        "Sheet '{}' not found. Available sheets: {}",
                        name,
                        sheet_names.join(", ")
                    ));
                }
                name
            }
            None => sheet_names[0].clone(),
        };

        let range = workbook
            .worksheet_range(&target_sheet)
            .map_err(|e| format!("Failed to read sheet '{}': {}", target_sheet, e))?;

        // Convert to CSV-like text
        let mut out = String::new();
        if sheet_names.len() > 1 {
            out.push_str(&format!("# Sheet: {}\n", target_sheet));
            out.push_str(&format!(
                "# Available sheets: {}\n\n",
                sheet_names.join(", ")
            ));
        }

        for row in range.rows() {
            let row_text: Vec<String> = row
                .iter()
                .map(|cell| match cell {
                    Data::Empty => String::new(),
                    Data::String(s) => {
                        if s.contains(',') || s.contains('"') || s.contains('\n') {
                            format!("\"{}\"", s.replace('"', "\"\""))
                        } else {
                            s.clone()
                        }
                    }
                    Data::Float(f) => f.to_string(),
                    Data::Int(i) => i.to_string(),
                    Data::Bool(b) => b.to_string(),
                    Data::DateTime(dt) => dt.to_string(),
                    Data::DateTimeIso(s) => s.clone(),
                    Data::DurationIso(s) => s.clone(),
                    Data::Error(e) => format!("#ERR:{:?}", e),
                })
                .collect();
            out.push_str(&row_text.join(","));
            out.push('\n');
        }

        Ok(out)
    })
    .await
    .map_err(|e| format!("xlsx extraction task failed: {}", e))??;

    const MAX_XLSX_CHARS: usize = 500_000;
    if csv.len() > MAX_XLSX_CHARS {
        return Ok(format!(
            "{}\n\n[... truncated: {} characters total, showing first {}]",
            &csv[..MAX_XLSX_CHARS],
            csv.len(),
            MAX_XLSX_CHARS
        ));
    }

    Ok(csv)
}

#[tauri::command]
pub async fn fs_read_pdf(workdir: String, rel_path: String) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }

    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_PDF_READ_BYTES {
        return Err(format!(
            "PDF too large ({} bytes). Maximum is {} bytes.",
            metadata.len(),
            MAX_PDF_READ_BYTES
        ));
    }

    // Try pdfium first — it's the same library Chrome uses, handles forms
    // and custom fonts correctly. Fall back to pdf-extract if pdfium isn't
    // available (missing native lib).
    let resolved_clone = resolved.clone();
    let text = tokio::task::spawn_blocking(move || -> Result<String, String> {
        if pdfium_available() {
            match extract_pdf_with_pdfium(&resolved_clone) {
                Ok(t) => return Ok(t),
                Err(e) => log::warn!("pdfium extraction failed: {}; falling back", e),
            }
        }
        pdf_extract::extract_text(&resolved_clone)
            .map_err(|e| format!("Failed to extract PDF text: {}", e))
    })
    .await
    .map_err(|e| format!("PDF extraction task failed: {}", e))??;

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(
            "PDF has no extractable text (it may be a scanned document without OCR). \
             Try fs_read_pdf_pages to read it visually."
                .to_string(),
        );
    }

    // Cap the extracted text to avoid blowing up the context
    const MAX_PDF_TEXT_CHARS: usize = 500_000;
    if trimmed.len() > MAX_PDF_TEXT_CHARS {
        return Ok(format!(
            "{}\n\n[... truncated: {} characters total, showing first {}]",
            &trimmed[..MAX_PDF_TEXT_CHARS],
            trimmed.len(),
            MAX_PDF_TEXT_CHARS
        ));
    }

    Ok(trimmed.to_string())
}

#[tauri::command]
pub async fn fs_edit_text(
    workdir: String,
    rel_path: String,
    old_str: String,
    new_str: String,
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }

    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_TEXT_READ_BYTES {
        return Err(format!(
            "File too large to edit ({} bytes). Maximum is {} bytes.",
            metadata.len(),
            MAX_TEXT_READ_BYTES
        ));
    }

    let content = fs::read_to_string(&resolved)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Find all occurrences. old_str must appear exactly once to prevent
    // ambiguous edits.
    let occurrences = content.matches(&old_str).count();
    if occurrences == 0 {
        return Err(format!("old_str not found in {}", rel_path));
    }
    if occurrences > 1 {
        return Err(format!(
            "old_str appears {} times in {}. It must be unique — include more surrounding context.",
            occurrences, rel_path
        ));
    }

    let new_content = content.replacen(&old_str, &new_str, 1);
    fs::write(&resolved, new_content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_fs_test_{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_inline_markdown_bold_italic() {
        let runs = parse_inline_markdown("plain **bold** and *italic* end");
        let collected: Vec<(String, bool, bool)> = runs
            .iter()
            .map(|r| (r.text.clone(), r.bold, r.italic))
            .collect();
        // Expected: "plain " plain, "bold" bold, " and " plain, "italic" italic, " end" plain
        assert_eq!(collected.len(), 5);
        assert_eq!(collected[0], ("plain ".to_string(), false, false));
        assert_eq!(collected[1], ("bold".to_string(), true, false));
        assert_eq!(collected[2], (" and ".to_string(), false, false));
        assert_eq!(collected[3], ("italic".to_string(), false, true));
        assert_eq!(collected[4], (" end".to_string(), false, false));
    }

    #[test]
    fn parse_inline_markdown_strips_code_and_links() {
        let runs = parse_inline_markdown("use `cargo` then see [docs](https://example.com).");
        // Concatenated plain text should have the backticks and link URL stripped.
        let joined: String = runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(joined, "use cargo then see docs.");
        // None of the runs should carry the URL itself.
        assert!(!joined.contains("https://"));
        assert!(!joined.contains('`'));
        assert!(!joined.contains('['));
    }

    #[test]
    fn parse_inline_markdown_unclosed_emphasis_is_tolerated() {
        // Unclosed ** — everything after becomes bold, but at least the
        // literal asterisks don't leak through to the PDF.
        let runs = parse_inline_markdown("before **unfinished");
        let joined: String = runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(joined, "before unfinished");
    }

    #[test]
    fn normalize_list_marker_disambiguates_star_and_plus() {
        // `- ` passes through unchanged (already unambiguous)
        assert_eq!(normalize_list_marker("- one"), "- one");
        // `* ` and `+ ` get rewritten so the inline parser doesn't mistake
        // the opening `*` for italic emphasis
        assert_eq!(normalize_list_marker("* two"), "- two");
        assert_eq!(normalize_list_marker("+ three"), "- three");
        // Indented list marker preserves indentation
        assert_eq!(normalize_list_marker("  * nested"), "  - nested");
        // Numbered lists pass through untouched
        assert_eq!(normalize_list_marker("1. first"), "1. first");
        // Leading `*italic*` shouldn't match (no space after opening *)
        assert_eq!(normalize_list_marker("*italic*"), "*italic*");
    }

    #[test]
    fn ascii_fold_for_pdf_replaces_bullets_and_arrows() {
        // Bullets, arrows, and smart punctuation — the exact characters
        // that previously produced `â€¢` / `â†'` mojibake in the PDF.
        assert_eq!(ascii_fold_for_pdf("a \u{2022} b"), "a - b");
        assert_eq!(ascii_fold_for_pdf("\u{2192} and \u{2193}"), "-> and v");
        assert_eq!(ascii_fold_for_pdf("\u{2190}\u{2191}\u{2194}"), "<-^<->");
        // Smart quotes
        assert_eq!(ascii_fold_for_pdf("\u{2018}hi\u{2019}"), "'hi'");
        assert_eq!(ascii_fold_for_pdf("\u{201C}hi\u{201D}"), "\"hi\"");
        // Dashes and ellipsis
        assert_eq!(ascii_fold_for_pdf("a\u{2013}b"), "a-b");
        assert_eq!(ascii_fold_for_pdf("a\u{2014}b"), "a--b");
        assert_eq!(ascii_fold_for_pdf("loading\u{2026}"), "loading...");
    }

    #[test]
    fn ascii_fold_for_pdf_strips_accents() {
        assert_eq!(ascii_fold_for_pdf("café"), "cafe");
        assert_eq!(ascii_fold_for_pdf("naïve"), "naive");
        assert_eq!(ascii_fold_for_pdf("Ångström"), "Angstrom");
        assert_eq!(ascii_fold_for_pdf("mañana"), "manana");
        assert_eq!(ascii_fold_for_pdf("Straße"), "Strasse");
    }

    #[test]
    fn ascii_fold_for_pdf_handles_box_drawing() {
        // Box-drawing characters fold to ASCII pipes/dashes/pluses so any
        // ASCII-art tables or diagrams the model emits stay legible.
        assert_eq!(ascii_fold_for_pdf("\u{250C}\u{2500}\u{2510}"), "+-+");
        assert_eq!(
            ascii_fold_for_pdf("\u{2502} a \u{2502} b \u{2502}"),
            "| a | b |"
        );
    }

    #[test]
    fn ascii_fold_for_pdf_passes_through_ascii() {
        let text = "Hello, World! 123 + 456 = 579. `code` and **bold**.";
        assert_eq!(ascii_fold_for_pdf(text), text);
    }

    #[test]
    fn is_horizontal_rule_matches_common_forms() {
        assert!(is_horizontal_rule("---"));
        assert!(is_horizontal_rule("----"));
        assert!(is_horizontal_rule("***"));
        assert!(is_horizontal_rule("___"));
        assert!(is_horizontal_rule("  ---  "));
        assert!(is_horizontal_rule("- - -"));
        assert!(is_horizontal_rule("-- -")); // 3 dashes with a space is still a valid HR
                                             // Not rules
        assert!(!is_horizontal_rule("--")); // only 2 dashes
        assert!(!is_horizontal_rule("abc"));
        assert!(!is_horizontal_rule(""));
        assert!(!is_horizontal_rule("-*-"));
    }

    #[test]
    fn format_table_as_monoblock_strips_inline_markdown_from_cells() {
        // The exact failure mode the user reported: table cells contain
        // `**Bold**` for emphasis, which the Courier table renderer was
        // dumping verbatim. After stripping, the asterisks should be gone
        // but the content preserved.
        let header = vec!["**Feature**".to_string(), "Service".to_string()];
        let rows = vec![
            vec!["**Cost:**".to_string(), "Low".to_string()],
            vec!["`focus`".to_string(), "*IT*".to_string()],
            vec!["[link](url)".to_string(), "Med".to_string()],
        ];
        let out = format_table_as_monoblock(&header, &rows);
        let all_text: String = out
            .iter()
            .map(|l| l.text.clone())
            .collect::<Vec<_>>()
            .join("\n");

        // Literal markdown syntax characters must not leak into any line.
        assert!(!all_text.contains("**"));
        assert!(!all_text.contains('`'));
        assert!(!all_text.contains("["));
        assert!(!all_text.contains("]("));

        // But the underlying content survives.
        assert!(all_text.contains("Feature"));
        assert!(all_text.contains("Cost:"));
        assert!(all_text.contains("focus"));
        assert!(all_text.contains("IT"));
        assert!(all_text.contains("link"));
    }

    /// Parse the bytes returned by build_odt / build_ods / build_odp as a
    /// zip archive and verify the ODF first-entry-stored-mimetype
    /// invariants: (1) first file is named "mimetype", (2) it uses
    /// Stored compression, (3) its contents match the expected media
    /// type for the format. Shared helper for the three ODF tests below.
    fn assert_odf_mimetype(bytes: &[u8], expected_mime: &str) {
        let cursor = std::io::Cursor::new(bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
        let mut first = zip.by_index(0).expect("at least one entry");
        assert_eq!(first.name(), "mimetype", "first entry must be mimetype");
        assert_eq!(
            first.compression(),
            zip::CompressionMethod::Stored,
            "mimetype must be stored uncompressed"
        );
        let mut content = String::new();
        use std::io::Read;
        first.read_to_string(&mut content).unwrap();
        assert_eq!(content, expected_mime);
    }

    /// Read an entire file out of a zip archive as a UTF-8 string.
    fn read_zip_entry(bytes: &[u8], name: &str) -> String {
        let cursor = std::io::Cursor::new(bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
        let mut entry = zip
            .by_name(name)
            .unwrap_or_else(|_| panic!("{} missing", name));
        let mut content = String::new();
        use std::io::Read;
        entry.read_to_string(&mut content).unwrap();
        content
    }

    #[test]
    fn build_odt_produces_valid_odf_zip() {
        let bytes = build_odt(
            &["# Main Title", "## Subsection", "A paragraph."],
            &no_images(),
        )
        .unwrap();
        assert_odf_mimetype(&bytes, "application/vnd.oasis.opendocument.text");

        // Required files exist
        let manifest = read_zip_entry(&bytes, "META-INF/manifest.xml");
        assert!(manifest.contains("application/vnd.oasis.opendocument.text"));
        assert!(manifest.contains("content.xml"));
        assert!(manifest.contains("styles.xml"));

        // content.xml has the expected headings and paragraph
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"text:outline-level="1""#));
        assert!(content.contains("Main Title"));
        assert!(content.contains(r#"text:outline-level="2""#));
        assert!(content.contains("Subsection"));
        assert!(content.contains("<text:p>A paragraph.</text:p>"));
    }

    /// Build a real PNG of the given dimensions for image-embedding tests.
    /// `image::load_from_memory` has to be able to decode it, so we can't
    /// use a bytestring placeholder — go through the `image` crate.
    fn make_png(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbImage::new(width, height);
        let mut bytes: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }

    #[test]
    fn parse_standalone_image_line_matches_only_whole_line_refs() {
        assert_eq!(
            parse_standalone_image_line("![alt](pic.png)"),
            Some(("pic.png".to_string(), ImageOptions::default()))
        );
        assert_eq!(
            parse_standalone_image_line("   ![alt](pic.png)   "),
            Some(("pic.png".to_string(), ImageOptions::default()))
        );
        // Trailing prose disqualifies — image must be the entire line.
        assert_eq!(parse_standalone_image_line("![alt](pic.png) caption"), None);
        // Leading prose also disqualifies — only whole-line refs are blocks.
        assert_eq!(parse_standalone_image_line("see ![alt](pic.png)"), None);
        assert_eq!(parse_standalone_image_line("not an image"), None);
        assert_eq!(parse_standalone_image_line("![alt]()"), None);
    }

    #[test]
    fn parse_standalone_image_line_extracts_title_options() {
        let (path, opts) = parse_standalone_image_line(r#"![alt](pic.png "center 50%")"#).unwrap();
        assert_eq!(path, "pic.png");
        assert_eq!(opts.alignment, ImageAlignment::Center);
        assert!((opts.width_fraction.unwrap() - 0.5).abs() < 1e-6);

        // Single-quoted title and reversed token order both work.
        let (path, opts) =
            parse_standalone_image_line(r#"![hero](img/hero.png '75% right')"#).unwrap();
        assert_eq!(path, "img/hero.png");
        assert_eq!(opts.alignment, ImageAlignment::Right);
        assert!((opts.width_fraction.unwrap() - 0.75).abs() < 1e-6);

        // Unknown tokens are ignored, valid ones still apply.
        let (path, opts) =
            parse_standalone_image_line(r#"![a](pic.png "shrink center bogus 30%")"#).unwrap();
        assert_eq!(path, "pic.png");
        assert_eq!(opts.alignment, ImageAlignment::Center);
        assert!((opts.width_fraction.unwrap() - 0.3).abs() < 1e-6);

        // Out-of-range width gets clamped to [5%, 100%].
        let (_, opts) = parse_standalone_image_line(r#"![a](pic.png "200%")"#).unwrap();
        assert!((opts.width_fraction.unwrap() - 1.0).abs() < 1e-6);
        let (_, opts) = parse_standalone_image_line(r#"![a](pic.png "1%")"#).unwrap();
        assert!((opts.width_fraction.unwrap() - 0.05).abs() < 1e-6);
    }

    #[test]
    fn build_docx_embeds_referenced_image() {
        let mut images = std::collections::HashMap::new();
        let png = make_png(64, 32);
        images.insert(
            "hero.png".to_string(),
            LoadedImage {
                bytes: png.clone(),
                extension: "png".to_string(),
            },
        );

        let paragraphs = vec!["# Title", "intro", "![hero](hero.png)", "outro"];
        let bytes = build_docx(&paragraphs, &images).unwrap();

        // Image bytes land in word/media/image1.png.
        let media = read_zip_entry_bytes(&bytes, "word/media/image1.png");
        assert_eq!(media, png);

        // Content_Types declares the png extension default.
        let ct = read_zip_entry(&bytes, "[Content_Types].xml");
        assert!(ct.contains(r#"<Default Extension="png" ContentType="image/png"/>"#));

        // document.xml.rels has the image relationship.
        let rels = read_zip_entry(&bytes, "word/_rels/document.xml.rels");
        assert!(rels.contains(r#"Id="rId1""#));
        assert!(rels.contains("media/image1.png"));

        // document.xml contains a <w:drawing> with the expected r:embed ref.
        let doc = read_zip_entry(&bytes, "word/document.xml");
        assert!(doc.contains("<w:drawing>"));
        assert!(doc.contains(r#"r:embed="rId1""#));
        // Headings and prose still render normally alongside the image.
        assert!(doc.contains("Title"));
        assert!(doc.contains("intro"));
        assert!(doc.contains("outro"));
    }

    #[test]
    fn build_docx_without_images_skips_rels_file() {
        let paragraphs = vec!["# Title", "just text"];
        let bytes = build_docx(&paragraphs, &no_images()).unwrap();
        // word/_rels/document.xml.rels should not be present when there
        // are no images to reference.
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
        assert!(zip.by_name("word/_rels/document.xml.rels").is_err());
    }

    #[test]
    fn build_odt_embeds_referenced_image() {
        let mut images = std::collections::HashMap::new();
        let png = make_png(48, 24);
        images.insert(
            "logo.png".to_string(),
            LoadedImage {
                bytes: png.clone(),
                extension: "png".to_string(),
            },
        );

        let paragraphs = vec!["# Heading", "![logo](logo.png)", "footer"];
        let bytes = build_odt(&paragraphs, &images).unwrap();

        // Image bytes land in Pictures/image1.png.
        let media = read_zip_entry_bytes(&bytes, "Pictures/image1.png");
        assert_eq!(media, png);

        // Manifest lists the Pictures directory and the image file.
        let manifest = read_zip_entry(&bytes, "META-INF/manifest.xml");
        assert!(manifest.contains(r#"manifest:full-path="Pictures/""#));
        assert!(manifest.contains(r#"manifest:full-path="Pictures/image1.png""#));
        assert!(manifest.contains(r#"manifest:media-type="image/png""#));

        // content.xml has a draw:frame referencing the picture.
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"xlink:href="Pictures/image1.png""#));
        assert!(content.contains("<draw:frame"));
        // Heading and trailing paragraph still render.
        assert!(content.contains("Heading"));
        assert!(content.contains("footer"));
    }

    #[test]
    fn build_docx_honors_image_alignment_and_width() {
        let mut images = std::collections::HashMap::new();
        images.insert(
            "hero.png".to_string(),
            LoadedImage {
                bytes: make_png(100, 50),
                extension: "png".to_string(),
            },
        );
        let bytes = build_docx(
            &["![hero](hero.png \"center 50%\")", "![hero](hero.png)"],
            &images,
        )
        .unwrap();
        let doc = read_zip_entry(&bytes, "word/document.xml");
        // First reference is centered.
        assert!(doc.contains(r#"<w:jc w:val="center"/>"#));
        // The default-left second reference omits w:pPr/w:jc entirely. Two
        // separate <w:drawing> blocks should appear regardless.
        let drawings = doc.matches("<w:drawing>").count();
        assert_eq!(drawings, 2);
        // 50% of the 6 inch content width is ~2_743_200 EMU. Let the test
        // be permissive: assert *some* cx value in the expected range
        // appears.
        let has_half_width = (2_500_000..3_000_000)
            .step_by(1)
            .any(|emu| doc.contains(&format!(r#"cx="{}""#, emu)));
        // The exact computed cx is deterministic; verify the literal too.
        assert!(
            doc.contains(r#"cx="2743200""#) || has_half_width,
            "expected ~50% content-width cx in docx, got:\n{}",
            doc
        );
    }

    #[test]
    fn build_odt_honors_image_alignment_and_width() {
        let mut images = std::collections::HashMap::new();
        images.insert(
            "hero.png".to_string(),
            LoadedImage {
                bytes: make_png(100, 50),
                extension: "png".to_string(),
            },
        );
        let bytes = build_odt(
            &[
                "![hero](hero.png \"right 75%\")",
                "![hero](hero.png \"center\")",
            ],
            &images,
        )
        .unwrap();
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"text:style-name="ImageRight""#));
        assert!(content.contains(r#"text:style-name="ImageCenter""#));
        // Style declarations should appear in automatic-styles.
        assert!(content.contains(r#"style:name="ImageCenter""#));
        assert!(content.contains(r#"style:name="ImageRight""#));
        // 75% of 6" ≈ 11.43 cm. Match the cm decimal in the svg:width.
        assert!(
            content.contains(r#"svg:width="11.430cm""#)
                || content.contains(r#"svg:width="11.43cm""#),
            "expected ~11.43cm width in odt content, got:\n{}",
            content
        );
    }

    #[test]
    fn build_pdf_embeds_referenced_image_without_panicking() {
        // We can't easily decode the PDF stream here to confirm the image
        // is positioned correctly, but we can at least verify the builder
        // accepts a markdown body with an image reference and produces a
        // non-empty PDF.
        let mut images = std::collections::HashMap::new();
        images.insert(
            "chart.png".to_string(),
            LoadedImage {
                bytes: make_png(80, 60),
                extension: "png".to_string(),
            },
        );
        let bytes = build_pdf(
            &[
                "# Report",
                "Some prose.",
                "![chart](chart.png)",
                "More prose.",
            ],
            &images,
        )
        .unwrap();
        assert!(!bytes.is_empty());
        // PDFs start with %PDF-
        assert!(bytes.starts_with(b"%PDF-"));
    }

    #[test]
    fn build_odt_escapes_xml_special_chars() {
        let bytes = build_odt(&["Contains < and > and & and \"quoted\""], &no_images()).unwrap();
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains("&lt;"));
        assert!(content.contains("&gt;"));
        assert!(content.contains("&amp;"));
        assert!(content.contains("&quot;"));
        // And raw specials should not appear in the escaped paragraph text
        assert!(!content.contains("< and >"));
    }

    #[test]
    fn build_ods_produces_valid_odf_zip() {
        let sheets = vec![XlsxSheet {
            name: "Report".to_string(),
            rows: vec![
                vec!["Name".to_string(), "Count".to_string()],
                vec!["alpha".to_string(), "42".to_string()],
                vec!["beta".to_string(), "3.14".to_string()],
            ],
        }];
        let bytes = build_ods(&sheets).unwrap();
        assert_odf_mimetype(&bytes, "application/vnd.oasis.opendocument.spreadsheet");

        let content = read_zip_entry(&bytes, "content.xml");
        // Sheet name + table structure
        assert!(content.contains(r#"table:name="Report""#));
        // Numeric cells use office:value-type="float" with office:value attribute
        assert!(content.contains(r#"office:value-type="float""#));
        assert!(content.contains(r#"office:value="42""#));
        assert!(content.contains(r#"office:value="3.14""#));
        // String cells use office:value-type="string"
        assert!(content.contains(r#"office:value-type="string""#));
        assert!(content.contains("<text:p>Name</text:p>"));
        assert!(content.contains("<text:p>alpha</text:p>"));
    }

    /// Build a PptxBullet at level 0 (the default). Shorthand used in
    /// tests that just want a flat bullet list without nesting.
    fn b(text: &str) -> PptxBullet {
        PptxBullet {
            text: text.to_string(),
            level: 0,
        }
    }

    /// Build a PptxSlide with only title + bullets populated; everything
    /// else defaults. Matches the original pre-extension ergonomics so
    /// existing tests stay focused on what they're checking.
    fn content_slide(title: &str, bullets: Vec<PptxBullet>) -> PptxSlide {
        PptxSlide {
            title: title.to_string(),
            bullets,
            subtitle: None,
            image: None,
            layout: PptxLayout::Content,
        }
    }

    /// Empty images map helper — used by tests that don't exercise
    /// image embedding so the call sites stay readable.
    fn no_images() -> std::collections::HashMap<String, LoadedImage> {
        std::collections::HashMap::new()
    }

    #[test]
    fn build_pptx_produces_required_package_parts() {
        let slides = vec![
            content_slide(
                "Introduction",
                vec![b("First point"), b("Second point"), b("Third point")],
            ),
            content_slide("Conclusion", vec![b("Wrap it up")]),
        ];
        let bytes = build_pptx(&slides, &no_images()).unwrap();

        // Every part PowerPoint needs to open the file must be present.
        let required = [
            "[Content_Types].xml",
            "_rels/.rels",
            "ppt/presentation.xml",
            "ppt/_rels/presentation.xml.rels",
            "ppt/slideMasters/slideMaster1.xml",
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            "ppt/slideLayouts/slideLayout1.xml",
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            "ppt/theme/theme1.xml",
            "ppt/slides/slide1.xml",
            "ppt/slides/slide2.xml",
            "ppt/slides/_rels/slide1.xml.rels",
            "ppt/slides/_rels/slide2.xml.rels",
        ];
        for name in required {
            read_zip_entry(&bytes, name);
        }

        // Slide 1 should contain the title and all three bullets.
        let slide1 = read_zip_entry(&bytes, "ppt/slides/slide1.xml");
        assert!(slide1.contains("Introduction"));
        assert!(slide1.contains("First point"));
        assert!(slide1.contains("Second point"));
        assert!(slide1.contains("Third point"));
        // And title is rendered at 32pt bold.
        assert!(slide1.contains(r#"sz="3200""#));
        assert!(slide1.contains(r#"b="1""#));
        // Bullets at 18pt.
        assert!(slide1.contains(r#"sz="1800""#));

        // Slide 2 gets its own content.
        let slide2 = read_zip_entry(&bytes, "ppt/slides/slide2.xml");
        assert!(slide2.contains("Conclusion"));
        assert!(slide2.contains("Wrap it up"));

        // Content Types enumerates both slide parts.
        let ct = read_zip_entry(&bytes, "[Content_Types].xml");
        assert!(ct.contains("slide1.xml"));
        assert!(ct.contains("slide2.xml"));

        // Presentation rels has master + both slide rels.
        let rels = read_zip_entry(&bytes, "ppt/_rels/presentation.xml.rels");
        assert!(rels.contains("slideMaster1.xml"));
        assert!(rels.contains("slides/slide1.xml"));
        assert!(rels.contains("slides/slide2.xml"));
    }

    /// Read a zip entry's raw bytes (used by the image-embedding tests
    /// to verify binary parts were written verbatim).
    fn read_zip_entry_bytes(bytes: &[u8], name: &str) -> Vec<u8> {
        let cursor = std::io::Cursor::new(bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
        let mut entry = zip
            .by_name(name)
            .unwrap_or_else(|_| panic!("{} missing", name));
        let mut out = Vec::new();
        use std::io::Read;
        entry.read_to_end(&mut out).unwrap();
        out
    }

    #[test]
    fn build_pptx_section_layout_emits_centered_title_without_body() {
        let slides = vec![PptxSlide {
            title: "Part One".to_string(),
            subtitle: Some("Foundations".to_string()),
            bullets: vec![],
            image: None,
            layout: PptxLayout::Section,
        }];
        let bytes = build_pptx(&slides, &no_images()).unwrap();
        let slide1 = read_zip_entry(&bytes, "ppt/slides/slide1.xml");

        // Section title uses the 44pt font and centered alignment.
        assert!(slide1.contains(r#"sz="4400""#));
        assert!(slide1.contains(r#"algn="ctr""#));
        // No 32pt content-slide title in a section slide.
        assert!(!slide1.contains(r#"sz="3200""#));
        // Title text and subtitle both present.
        assert!(slide1.contains("Part One"));
        assert!(slide1.contains("Foundations"));
        // No content shape named "Content" — section slides skip the body.
        assert!(!slide1.contains(r#"name="Content""#));
    }

    #[test]
    fn build_pptx_nested_bullets_emit_lvl_attribute() {
        let slides = vec![PptxSlide {
            title: "Nested".to_string(),
            subtitle: None,
            bullets: vec![
                PptxBullet {
                    text: "Top level".to_string(),
                    level: 0,
                },
                PptxBullet {
                    text: "Child A".to_string(),
                    level: 1,
                },
                PptxBullet {
                    text: "Grandchild".to_string(),
                    level: 2,
                },
            ],
            image: None,
            layout: PptxLayout::Content,
        }];
        let bytes = build_pptx(&slides, &no_images()).unwrap();
        let slide1 = read_zip_entry(&bytes, "ppt/slides/slide1.xml");

        // Each level maps to a distinct lvl / font-size / margin.
        assert!(slide1.contains(r#"lvl="0""#));
        assert!(slide1.contains(r#"lvl="1""#));
        assert!(slide1.contains(r#"lvl="2""#));
        assert!(slide1.contains(r#"sz="1800""#)); // level 0 → 18pt
        assert!(slide1.contains(r#"sz="1600""#)); // level 1 → 16pt
        assert!(slide1.contains(r#"sz="1400""#)); // level 2 → 14pt
                                                  // Per-level left margin increases.
        assert!(slide1.contains(r#"marL="457200""#));
        assert!(slide1.contains(r#"marL="914400""#));
        assert!(slide1.contains(r#"marL="1371600""#));
    }

    #[test]
    fn build_pptx_deserializes_plain_string_bullets() {
        // Round-trip via JSON to confirm the untagged enum accepts the
        // old shape: bullets as an array of plain strings. This is how
        // existing model-generated tool calls look.
        let json = r#"{
            "title": "Plain",
            "bullets": ["first", "second", "third"]
        }"#;
        let slide: PptxSlide = serde_json::from_str(json).unwrap();
        assert_eq!(slide.title, "Plain");
        assert_eq!(slide.bullets.len(), 3);
        for bullet in &slide.bullets {
            assert_eq!(bullet.level, 0);
        }
        assert_eq!(slide.bullets[0].text, "first");
    }

    #[test]
    fn build_pptx_deserializes_structured_bullets_with_level() {
        let json = r#"{
            "title": "Mixed",
            "bullets": [
                "flat string",
                { "text": "nested", "level": 1 },
                { "text": "deep", "level": 2 }
            ],
            "layout": "content"
        }"#;
        let slide: PptxSlide = serde_json::from_str(json).unwrap();
        assert_eq!(slide.bullets.len(), 3);
        assert_eq!(slide.bullets[0].level, 0);
        assert_eq!(slide.bullets[1].level, 1);
        assert_eq!(slide.bullets[1].text, "nested");
        assert_eq!(slide.bullets[2].level, 2);
        assert_eq!(slide.layout, PptxLayout::Content);
    }

    #[test]
    fn build_pptx_deserializes_section_layout() {
        let json = r#"{
            "title": "Part Two",
            "bullets": [],
            "layout": "section",
            "subtitle": "Deep Dive"
        }"#;
        let slide: PptxSlide = serde_json::from_str(json).unwrap();
        assert_eq!(slide.layout, PptxLayout::Section);
        assert_eq!(slide.subtitle.as_deref(), Some("Deep Dive"));
    }

    #[test]
    fn build_pptx_embeds_referenced_images() {
        let fake_png = b"\x89PNG\r\n\x1a\nfake-png-bytes-for-test".to_vec();
        let mut images = std::collections::HashMap::new();
        images.insert(
            "hero.png".to_string(),
            LoadedImage {
                bytes: fake_png.clone(),
                extension: "png".to_string(),
            },
        );

        let slides = vec![PptxSlide {
            title: "With Image".to_string(),
            subtitle: None,
            bullets: vec![b("context line")],
            image: Some("hero.png".to_string()),
            layout: PptxLayout::Content,
        }];
        let bytes = build_pptx(&slides, &images).unwrap();

        // Media file was written under the expected deterministic name.
        let media = read_zip_entry_bytes(&bytes, "ppt/media/image1.png");
        assert_eq!(media, fake_png);

        // Content_Types gets a Default for the png extension.
        let ct = read_zip_entry(&bytes, "[Content_Types].xml");
        assert!(ct.contains(r#"<Default Extension="png" ContentType="image/png"/>"#));

        // Slide XML has a p:pic referencing rId2 (rId1 is the layout).
        let slide1 = read_zip_entry(&bytes, "ppt/slides/slide1.xml");
        assert!(slide1.contains("<p:pic>"));
        assert!(slide1.contains(r#"r:embed="rId2""#));

        // Slide rels has both the layout and image relationships.
        let rels = read_zip_entry(&bytes, "ppt/slides/_rels/slide1.xml.rels");
        assert!(rels.contains(r#"Id="rId1""#));
        assert!(rels.contains(r#"Id="rId2""#));
        assert!(rels.contains("image1.png"));
    }

    #[test]
    fn build_pptx_deduplicates_shared_image_across_slides() {
        // Two slides referencing the same image path should share a
        // single ppt/media/image1.png file, not generate two copies.
        let fake_png = b"\x89PNGdedup".to_vec();
        let mut images = std::collections::HashMap::new();
        images.insert(
            "logo.png".to_string(),
            LoadedImage {
                bytes: fake_png.clone(),
                extension: "png".to_string(),
            },
        );
        let slides = vec![
            PptxSlide {
                title: "A".to_string(),
                subtitle: None,
                bullets: vec![b("one")],
                image: Some("logo.png".to_string()),
                layout: PptxLayout::Content,
            },
            PptxSlide {
                title: "B".to_string(),
                subtitle: None,
                bullets: vec![b("two")],
                image: Some("logo.png".to_string()),
                layout: PptxLayout::Content,
            },
        ];
        let bytes = build_pptx(&slides, &images).unwrap();

        // Only one media file, with the first-appearance index.
        let _ = read_zip_entry_bytes(&bytes, "ppt/media/image1.png");
        let cursor = std::io::Cursor::new(&bytes);
        let zip = zip::ZipArchive::new(cursor).unwrap();
        let media_entries: Vec<_> = zip
            .file_names()
            .filter(|n| n.starts_with("ppt/media/"))
            .collect();
        assert_eq!(media_entries.len(), 1);

        // Both slide rels point at the same image1.png.
        let rels1 = read_zip_entry(&bytes, "ppt/slides/_rels/slide1.xml.rels");
        let rels2 = read_zip_entry(&bytes, "ppt/slides/_rels/slide2.xml.rels");
        assert!(rels1.contains("image1.png"));
        assert!(rels2.contains("image1.png"));
    }

    #[test]
    fn build_odp_section_layout_uses_section_title_style() {
        let slides = vec![PptxSlide {
            title: "Part Two".to_string(),
            subtitle: Some("Applications".to_string()),
            bullets: vec![],
            image: None,
            layout: PptxLayout::Section,
        }];
        let bytes = build_odp(&slides, &no_images()).unwrap();
        let content = read_zip_entry(&bytes, "content.xml");

        // SectionTitle paragraph style is referenced (bigger + centered).
        assert!(content.contains(r#"text:style-name="SectionTitle""#));
        assert!(content.contains(r#"text:style-name="SectionSubtitle""#));
        assert!(content.contains("Part Two"));
        assert!(content.contains("Applications"));
        // No content-slide title style on section slides.
        assert!(!content.contains(r#"text:style-name="TitleText""#));
    }

    #[test]
    fn build_odp_nested_bullets_use_level_styles() {
        let slides = vec![PptxSlide {
            title: "Nested".to_string(),
            subtitle: None,
            bullets: vec![
                PptxBullet {
                    text: "Parent".to_string(),
                    level: 0,
                },
                PptxBullet {
                    text: "Child".to_string(),
                    level: 1,
                },
                PptxBullet {
                    text: "Grandchild".to_string(),
                    level: 2,
                },
            ],
            image: None,
            layout: PptxLayout::Content,
        }];
        let bytes = build_odp(&slides, &no_images()).unwrap();
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"text:style-name="BulletText0""#));
        assert!(content.contains(r#"text:style-name="BulletText1""#));
        assert!(content.contains(r#"text:style-name="BulletText2""#));
    }

    #[test]
    fn build_odp_embeds_referenced_images() {
        let fake_jpg = b"\xff\xd8\xff\xe0fake-jpeg-bytes".to_vec();
        let mut images = std::collections::HashMap::new();
        images.insert(
            "diagram.jpg".to_string(),
            LoadedImage {
                bytes: fake_jpg.clone(),
                extension: "jpeg".to_string(),
            },
        );
        let slides = vec![PptxSlide {
            title: "Architecture".to_string(),
            subtitle: None,
            bullets: vec![b("overview")],
            image: Some("diagram.jpg".to_string()),
            layout: PptxLayout::Content,
        }];
        let bytes = build_odp(&slides, &images).unwrap();
        assert_odf_mimetype(&bytes, "application/vnd.oasis.opendocument.presentation");

        // Image lives under Pictures/ and was written verbatim.
        let media = read_zip_entry_bytes(&bytes, "Pictures/image1.jpeg");
        assert_eq!(media, fake_jpg);

        // content.xml references the image via xlink:href.
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"xlink:href="Pictures/image1.jpeg""#));

        // Manifest enumerates the image with the right media type.
        let manifest = read_zip_entry(&bytes, "META-INF/manifest.xml");
        assert!(manifest.contains(r#"manifest:full-path="Pictures/image1.jpeg""#));
        assert!(manifest.contains(r#"manifest:media-type="image/jpeg""#));
    }

    #[test]
    fn reject_executable_extension_blocks_known_dangers() {
        // Every entry on the blocklist should be rejected, case-insensitively.
        for ext in EXECUTABLE_EXTENSION_BLOCKLIST {
            let path = format!("danger.{}", ext);
            assert!(
                reject_executable_extension(&path).is_err(),
                "expected {}.{} to be rejected",
                path,
                ext
            );
            // Upper/mixed case should be rejected too.
            let upper_path = format!("DANGER.{}", ext.to_uppercase());
            assert!(
                reject_executable_extension(&upper_path).is_err(),
                "expected {} to be rejected",
                upper_path
            );
        }
    }

    #[test]
    fn reject_executable_extension_allows_safe_formats() {
        // Common benign formats the model might want to download.
        let safe = [
            "images/hero.png",
            "docs/report.pdf",
            "fonts/Inter.ttf",
            "archives/bundle.zip",
            "data/rows.csv",
            "media/audio.mp3",
            "slides.pptx",
            "sheet.xlsx",
            "doc.docx",
            "template.odt",
        ];
        for path in safe {
            assert!(
                reject_executable_extension(path).is_ok(),
                "expected {} to be allowed",
                path
            );
        }
    }

    #[test]
    fn build_pptx_empty_slides_returns_error() {
        let slides: Vec<PptxSlide> = Vec::new();
        assert!(build_pptx(&slides, &no_images()).is_err());
    }

    #[test]
    fn build_pptx_escapes_xml_in_title_and_bullets() {
        let slides = vec![content_slide(
            "A & B <vs> C",
            vec![b("1 < 2"), b(r#"He said "hi""#)],
        )];
        let bytes = build_pptx(&slides, &no_images()).unwrap();
        let slide1 = read_zip_entry(&bytes, "ppt/slides/slide1.xml");
        assert!(slide1.contains("&amp;"));
        assert!(slide1.contains("&lt;"));
        assert!(slide1.contains("&gt;"));
        assert!(slide1.contains("&quot;"));
        // Raw angle brackets in the user text should not appear as part
        // of the run text (the structural XML itself still has <a:t> etc).
        assert!(!slide1.contains("A & B <vs>"));
    }

    #[test]
    fn build_odp_produces_valid_odf_zip_with_slides() {
        let slides = vec![
            content_slide("Overview", vec![b("Item one"), b("Item two")]),
            content_slide("Details", vec![b("Only item")]),
        ];
        let bytes = build_odp(&slides, &no_images()).unwrap();
        assert_odf_mimetype(&bytes, "application/vnd.oasis.opendocument.presentation");

        let content = read_zip_entry(&bytes, "content.xml");
        // One draw:page per input slide.
        assert_eq!(content.matches("<draw:page").count(), 2);
        // Title and bullet text both appear.
        assert!(content.contains("Overview"));
        assert!(content.contains("Item one"));
        assert!(content.contains("Item two"));
        assert!(content.contains("Details"));
        assert!(content.contains("Only item"));
        // Each slide references the master page.
        assert!(content.contains(r#"draw:master-page-name="Default""#));
    }

    #[test]
    fn build_odp_empty_slides_returns_error() {
        let slides: Vec<PptxSlide> = Vec::new();
        assert!(build_odp(&slides, &no_images()).is_err());
    }

    #[test]
    fn build_ods_handles_multiple_sheets_and_ragged_rows() {
        // Two sheets with different column counts and a row shorter than
        // the others — table-column count should come from the widest row
        // per sheet, and ragged rows should just emit fewer cells.
        let sheets = vec![
            XlsxSheet {
                name: "A".to_string(),
                rows: vec![
                    vec!["x".to_string(), "y".to_string(), "z".to_string()],
                    vec!["1".to_string(), "2".to_string()],
                ],
            },
            XlsxSheet {
                name: "B".to_string(),
                rows: vec![vec!["only".to_string()]],
            },
        ];
        let bytes = build_ods(&sheets).unwrap();
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"table:name="A""#));
        assert!(content.contains(r#"table:name="B""#));
        // Sheet A had max 3 columns
        assert!(content.contains(r#"table:number-columns-repeated="3""#));
        // Sheet B had 1 column
        assert!(content.contains(r#"table:number-columns-repeated="1""#));
    }

    #[test]
    fn strip_inline_markdown_removes_syntax_chars() {
        assert_eq!(strip_inline_markdown("**bold**"), "bold");
        assert_eq!(
            strip_inline_markdown("plain *italic* mix"),
            "plain italic mix"
        );
        assert_eq!(strip_inline_markdown("`code`"), "code");
        assert_eq!(strip_inline_markdown("[label](https://x)"), "label");
        assert_eq!(
            strip_inline_markdown("**Cost:** $5 *per* `month`"),
            "Cost: $5 per month"
        );
        // Plain ASCII passes through untouched.
        assert_eq!(
            strip_inline_markdown("no markdown here"),
            "no markdown here"
        );
    }

    #[test]
    fn format_table_as_monoblock_aligns_columns() {
        let header = vec![
            "Feature".to_string(),
            "MSP".to_string(),
            "MSSP".to_string(),
            "MDR".to_string(),
        ];
        let rows = vec![
            vec![
                "Cost".to_string(),
                "Low".to_string(),
                "Med".to_string(),
                "High".to_string(),
            ],
            vec![
                "Focus".to_string(),
                "IT".to_string(),
                "Sec".to_string(),
                "IR".to_string(),
            ],
        ];
        let out = format_table_as_monoblock(&header, &rows);

        // First line should be the (bold) header row.
        assert!(out[0].bold);
        assert!(out[0].text.contains("Feature"));
        assert!(out[0].text.contains("MSP"));
        assert!(out[0].text.contains("MSSP"));
        assert!(out[0].text.contains("MDR"));

        // Second line should be the dashed separator under the header.
        assert!(!out[1].bold);
        assert!(out[1].text.contains("---"));

        // Each MonoLine should have the same rendered width (padded).
        let widths: Vec<usize> = out.iter().map(|l| l.text.chars().count()).collect();
        assert!(widths.windows(2).all(|w| w[0] == w[1]));

        // Data rows should exist and be non-bold.
        assert!(out.iter().any(|l| !l.bold && l.text.contains("Cost")));
        assert!(out.iter().any(|l| !l.bold && l.text.contains("Focus")));
    }

    #[test]
    fn preprocess_lines_rewrites_tables_to_monoblock() {
        let lines = vec![
            "Intro paragraph.",
            "",
            "| A | B | C |",
            "| :--- | :--- | :--- |",
            "| 1 | 2 | 3 |",
            "",
            "After table.",
        ];
        let out = preprocess_lines(&lines);

        // The table should become exactly one MonoBlock.
        let mono_count = out
            .iter()
            .filter(|b| matches!(b, DocumentBlock::MonoBlock(_)))
            .count();
        assert_eq!(mono_count, 1);

        // And surrounding text should still be Line blocks.
        let line_texts: Vec<&str> = out
            .iter()
            .filter_map(|b| match b {
                DocumentBlock::Line(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert!(line_texts.contains(&"Intro paragraph."));
        assert!(line_texts.contains(&"After table."));

        // And the raw table syntax should NOT show up as a Line anywhere.
        assert!(!line_texts.iter().any(|l| l.contains("| :---")));
    }

    #[test]
    fn preprocess_lines_passes_through_without_tables() {
        let lines = vec!["# Title", "", "A paragraph.", "- A bullet"];
        let out = preprocess_lines(&lines);
        let line_texts: Vec<&str> = out
            .iter()
            .filter_map(|b| match b {
                DocumentBlock::Line(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            line_texts,
            vec!["# Title", "", "A paragraph.", "- A bullet"]
        );
        // No tables → no MonoBlocks
        assert!(!out.iter().any(|b| matches!(b, DocumentBlock::MonoBlock(_))));
    }

    #[test]
    fn wrap_to_width_breaks_on_whitespace() {
        let lines = wrap_to_width("hello world foo bar", 10);
        assert_eq!(lines, vec!["hello", "world foo", "bar"]);
    }

    #[test]
    fn wrap_to_width_hard_wraps_long_words() {
        let lines = wrap_to_width("abcdefghijklmnop short", 5);
        // First three are the long word split at 5-char intervals,
        // then "short" on its own line.
        assert_eq!(lines, vec!["abcde", "fghij", "klmno", "p", "short"]);
    }

    #[test]
    fn pad_right_truncates_when_too_long() {
        assert_eq!(pad_right("abcdef", 3), "abc");
        assert_eq!(pad_right("ab", 5), "ab   ");
        assert_eq!(pad_right("", 3), "   ");
    }

    #[test]
    fn is_table_separator_recognizes_gfm_separators() {
        assert!(is_table_separator("| --- | --- |"));
        assert!(is_table_separator("| :--- | ---: | :---: |"));
        assert!(is_table_separator("|---|---|"));
        assert!(!is_table_separator("| a | b |"));
        assert!(!is_table_separator("abc"));
    }

    #[test]
    fn ascii_fold_for_pdf_drops_unknown() {
        // Characters we don't explicitly handle get dropped rather than
        // leaking mojibake. Emoji, CJK, etc.
        assert_eq!(ascii_fold_for_pdf("hi 🎉 bye"), "hi  bye");
        assert_eq!(ascii_fold_for_pdf("hello 你好"), "hello ");
    }

}
