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
const MAX_IMAGE_BYTES: u64 = 20 * 1_048_576; // 20 MB source file
const MAX_IMAGE_DIMENSION: u32 = 1536; // resize dimension for vision model
const MAX_DIR_ENTRIES: usize = 500;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
}

/// Resolve a relative path within a working directory, ensuring the result
/// does not escape the working directory via `..`, absolute paths, or
/// symlinks.
///
/// The relative path may refer to a file that does not yet exist (for write
/// operations). In that case, the parent directory must exist and be inside
/// the working dir — the resolved path is `canonical_parent/filename`.
///
/// Returns an error if:
///   - `workdir` itself cannot be canonicalized
///   - The resolved path escapes the working directory
///   - The path is otherwise malformed
pub fn resolve_in_workdir(workdir: &Path, rel_path: &str) -> Result<PathBuf, String> {
    if rel_path.is_empty() || rel_path == "." {
        return workdir
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize working directory: {}", e));
    }

    let workdir_canonical = workdir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize working directory: {}", e))?;

    // Treat the relative path as relative to the working dir even if it
    // starts with "/" — we reject absolute paths that would escape.
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        // Allow absolute paths only if they already point inside the workdir.
        let canonical = rel.canonicalize().or_else(|_| resolve_nonexistent(rel))?;
        if !canonical.starts_with(&workdir_canonical) {
            return Err("path escapes working directory".to_string());
        }
        return Ok(canonical);
    }

    let candidate = workdir_canonical.join(rel);
    let canonical = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize path: {}", e))?
    } else {
        // For write operations: canonicalize the parent, then append the
        // file name. This prevents symlink escape via a non-existent target.
        resolve_nonexistent(&candidate)?
    };

    if !canonical.starts_with(&workdir_canonical) {
        return Err("path escapes working directory".to_string());
    }

    Ok(canonical)
}

/// Resolve a path whose final component may not exist yet by canonicalizing
/// the parent directory (which must exist) and appending the file name.
fn resolve_nonexistent(candidate: &Path) -> Result<PathBuf, String> {
    let parent = candidate
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    let file_name = candidate
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?;
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("Parent directory does not exist: {}", e))?;
    Ok(parent_canonical.join(file_name))
}

// --- Tauri commands ---

fn workdir_path(workdir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(workdir);
    if !path.is_dir() {
        return Err(format!("Working directory does not exist: {}", workdir));
    }
    Ok(path)
}

#[tauri::command]
pub async fn fs_list_dir(workdir: String, rel_path: String) -> Result<DirListing, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_dir() {
        return Err(format!("Not a directory: {}", rel_path));
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    let mut read_dir = fs::read_dir(&resolved)
        .await
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read entry: {}", e))?
    {
        if entries.len() >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files and common noise
        if name.starts_with('.') {
            continue;
        }
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        entries.push(DirEntry {
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    let display_path = resolved
        .strip_prefix(workdir.canonicalize().unwrap_or(workdir.clone()))
        .unwrap_or(&resolved)
        .to_string_lossy()
        .to_string();

    Ok(DirListing {
        path: if display_path.is_empty() {
            ".".to_string()
        } else {
            display_path
        },
        entries,
        truncated,
    })
}

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

    let allow_overwrite = overwrite.unwrap_or(true);
    if !allow_overwrite && resolved.exists() {
        return Err(format!(
            "File already exists: {}. Set overwrite=true to replace it.",
            rel_path
        ));
    }

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
fn build_docx(paragraphs: &[&str]) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // [Content_Types].xml
        zip.start_file("[Content_Types].xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#,
        )
        .map_err(|e| e.to_string())?;

        // _rels/.rels
        zip.start_file("_rels/.rels", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#,
        )
        .map_err(|e| e.to_string())?;

        // word/document.xml
        let mut body_xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>"#,
        );
        for para in paragraphs {
            // Treat a heading if the line starts with # (simple markdown-ish)
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

fn parse_heading(line: &str) -> (&str, Option<usize>) {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("# ") {
        (rest, Some(1))
    } else if let Some(rest) = trimmed.strip_prefix("## ") {
        (rest, Some(2))
    } else if let Some(rest) = trimmed.strip_prefix("### ") {
        (rest, Some(3))
    } else {
        (line, None)
    }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Build a simple PDF from markdown-ish text. Each non-empty line
/// becomes a paragraph. Lines starting with `# `, `## `, or `### ` are
/// rendered as headings. Long lines are word-wrapped to fit the page
/// width, and content flows across multiple pages when needed.
fn build_pdf(lines: &[&str]) -> Result<Vec<u8>, String> {
    use printpdf::*;

    let mut doc = PdfDocument::new("Document");

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

    fn wrap_text(text: &str, font_pt: f32, max_width_pt: f32) -> Vec<String> {
        let cw = char_width_pt(font_pt);
        let max_chars = (max_width_pt / cw).floor() as usize;
        if max_chars == 0 {
            return vec![text.to_string()];
        }
        let mut out = Vec::new();
        let mut current = String::new();
        for word in text.split_whitespace() {
            if word.len() > max_chars {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
                let mut w = word;
                while w.len() > max_chars {
                    let (head, tail) = w.split_at(max_chars);
                    out.push(head.to_string());
                    w = tail;
                }
                current.push_str(w);
                continue;
            }
            let candidate_len = if current.is_empty() {
                word.len()
            } else {
                current.len() + 1 + word.len()
            };
            if candidate_len > max_chars {
                out.push(std::mem::take(&mut current));
                current.push_str(word);
            } else {
                if !current.is_empty() {
                    current.push(' ');
                }
                current.push_str(word);
            }
        }
        if !current.is_empty() {
            out.push(current);
        }
        if out.is_empty() {
            out.push(String::new());
        }
        out
    }

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

    let top_y_mm = page_height_mm - margin_mm;
    let bottom_y_mm = margin_mm;

    let mut all_pages: Vec<PdfPage> = Vec::new();
    let mut current_ops: Vec<Op> = Vec::new();
    let mut cursor_y_mm = top_y_mm;

    // Start the first page
    current_ops.push(Op::SaveGraphicsState);
    current_ops.push(Op::StartTextSection);
    current_ops.push(Op::SetTextCursor {
        pos: Point::new(Mm(margin_mm), Mm(cursor_y_mm)),
    });

    let mut last_font: Option<(f32, bool)> = None;

    for line in lines {
        if line.trim().is_empty() {
            cursor_y_mm -= 4.0;
            continue;
        }

        let (text, font_pt, spacing_after_pt, is_bold) =
            classify(line, h1_pt, h2_pt, h3_pt, body_pt);
        let wrapped = wrap_text(&text, font_pt, content_width_pt);
        let line_height_mm = (font_pt * 1.2) / mm_to_pt;

        for wrapped_line in wrapped {
            // Page break check
            if cursor_y_mm - line_height_mm < bottom_y_mm {
                current_ops.push(Op::EndTextSection);
                current_ops.push(Op::RestoreGraphicsState);
                all_pages.push(PdfPage::new(
                    Mm(page_width_mm),
                    Mm(page_height_mm),
                    std::mem::take(&mut current_ops),
                ));
                cursor_y_mm = top_y_mm;
                current_ops.push(Op::SaveGraphicsState);
                current_ops.push(Op::StartTextSection);
                current_ops.push(Op::SetTextCursor {
                    pos: Point::new(Mm(margin_mm), Mm(cursor_y_mm)),
                });
                last_font = None;
            }

            // Update font if changed or at start of page
            if last_font != Some((font_pt, is_bold)) {
                let font = if is_bold {
                    PdfFontHandle::Builtin(BuiltinFont::HelveticaBold)
                } else {
                    PdfFontHandle::Builtin(BuiltinFont::Helvetica)
                };
                current_ops.push(Op::SetFont {
                    font,
                    size: Pt(font_pt),
                });
                current_ops.push(Op::SetLineHeight {
                    lh: Pt(font_pt * 1.2),
                });
                current_ops.push(Op::SetTextCursor {
                    pos: Point::new(Mm(margin_mm), Mm(cursor_y_mm)),
                });
                last_font = Some((font_pt, is_bold));
            }

            current_ops.push(Op::ShowText {
                items: vec![TextItem::Text(wrapped_line)],
            });
            cursor_y_mm -= line_height_mm;

            if cursor_y_mm > bottom_y_mm {
                current_ops.push(Op::SetTextCursor {
                    pos: Point::new(Mm(margin_mm), Mm(cursor_y_mm)),
                });
            }
        }

        cursor_y_mm -= spacing_after_pt / mm_to_pt;
    }

    current_ops.push(Op::EndTextSection);
    current_ops.push(Op::RestoreGraphicsState);
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
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("Content too large ({} bytes)", content.len()));
    }

    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let lines: Vec<&str> = content.lines().collect();
        build_pdf(&lines)
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
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("Content too large ({} bytes)", content.len()));
    }

    // Split content into paragraphs on newlines, drop empty lines
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let paragraphs: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        build_docx(&paragraphs)
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
) -> Result<(), String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if sheets.is_empty() {
        return Err("At least one sheet is required".to_string());
    }

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
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        use std::io::Cursor;

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
    fn resolves_simple_relative_path() {
        let dir = make_temp_dir("simple");
        fs::write(dir.join("hello.txt"), "hi").unwrap();

        let result = resolve_in_workdir(&dir, "hello.txt").unwrap();
        assert!(result.ends_with("hello.txt"));
        assert!(result.starts_with(dir.canonicalize().unwrap()));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_nested_path() {
        let dir = make_temp_dir("nested");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/file.txt"), "x").unwrap();

        let result = resolve_in_workdir(&dir, "sub/file.txt").unwrap();
        assert!(result.ends_with("file.txt"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_nonexistent_file_for_write() {
        let dir = make_temp_dir("write");
        let result = resolve_in_workdir(&dir, "new_file.txt").unwrap();
        assert!(result.ends_with("new_file.txt"));
        assert!(result.starts_with(dir.canonicalize().unwrap()));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_parent_dir_escape() {
        let dir = make_temp_dir("escape");
        let result = resolve_in_workdir(&dir, "../escaped.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("escapes"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_deep_parent_dir_escape() {
        let dir = make_temp_dir("deep_escape");
        let result = resolve_in_workdir(&dir, "sub/../../escaped.txt");
        assert!(result.is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_absolute_path_outside() {
        let dir = make_temp_dir("abs");
        let result = resolve_in_workdir(&dir, "/etc/passwd");
        assert!(result.is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_nonexistent_parent() {
        let dir = make_temp_dir("nonparent");
        let result = resolve_in_workdir(&dir, "does/not/exist/file.txt");
        assert!(result.is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_path_returns_workdir() {
        let dir = make_temp_dir("empty");
        let result = resolve_in_workdir(&dir, "").unwrap();
        assert_eq!(result, dir.canonicalize().unwrap());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dot_path_returns_workdir() {
        let dir = make_temp_dir("dot");
        let result = resolve_in_workdir(&dir, ".").unwrap();
        assert_eq!(result, dir.canonicalize().unwrap());

        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let dir = make_temp_dir("symlink");
        let outside = std::env::temp_dir().join("haruspex_fs_test_outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();

        // Create a symlink inside the workdir that points outside
        symlink(&outside, dir.join("link")).unwrap();

        // Attempting to read through the symlink should fail
        let result = resolve_in_workdir(&dir, "link/secret.txt");
        assert!(result.is_err(), "symlink escape was not caught");

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
