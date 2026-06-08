//! PDF text extraction: PDFium-backed with a pdf-extract fallback.
//!
//! PDFium is initialized once at app startup (see `init_pdfium`); if its
//! shared library isn't present (e.g. building without the bundled libs)
//! we fall back to the pure-Rust pdf-extract crate. Reading layout-heavy
//! PDFs (tax forms, invoices) goes through `reconstruct_page_layout` to
//! restore visual reading order, which the raw character stream doesn't
//! guarantee.

use super::path::{resolve_in_workdir, workdir_path, MAX_DOC_READ_BYTES};
use std::path::Path;
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

pub(super) fn pdfium_available() -> bool {
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
    let mut chars: Vec<PositionedChar> = Vec::new();
    for pdf_char in page_text.chars().iter() {
        let ch = match pdf_char.unicode_char() {
            Some(c) => c,
            None => continue,
        };
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

    chars.sort_by(|a, b| {
        b.y.partial_cmp(&a.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                a.left
                    .partial_cmp(&b.left)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    let mut heights: Vec<f32> = chars.iter().map(|c| c.height).collect();
    heights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_height = heights[heights.len() / 2];
    let row_threshold = (median_height * 0.5).max(2.0);

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
                let avg_char_width = last_height * 0.3;
                if gap > avg_char_width * 2.0 {
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

#[tauri::command]
pub async fn fs_read_pdf(workdir: String, rel_path: String) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }
    read_pdf_at_path(&resolved).await
}

/// Extract text from a PDF at a fully-resolved path. Used by both the
/// workdir-relative `fs_read_pdf` and the Shell-tab absolute-path
/// variant.
pub(super) async fn read_pdf_at_path(resolved: &std::path::Path) -> Result<String, String> {
    let metadata = fs::metadata(resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_DOC_READ_BYTES {
        return Err(format!(
            "PDF too large ({} bytes). Maximum is {} bytes.",
            metadata.len(),
            MAX_DOC_READ_BYTES
        ));
    }

    // Try pdfium first — it's the same library Chrome uses, handles forms
    // and custom fonts correctly. Fall back to pdf-extract if pdfium isn't
    // available (missing native lib).
    let resolved_clone = resolved.to_path_buf();
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

    if metadata.len() > MAX_DOC_READ_BYTES {
        return Err(format!(
            "PDF too large ({} bytes). Maximum is {} bytes.",
            metadata.len(),
            MAX_DOC_READ_BYTES
        ));
    }

    let bytes = fs::read(&resolved)
        .await
        .map_err(|e| format!("Failed to read PDF: {}", e))?;

    if bytes.len() < 4 || &bytes[..4] != b"%PDF" {
        return Err("File does not appear to be a valid PDF".to_string());
    }

    Ok(B64.encode(&bytes))
}
