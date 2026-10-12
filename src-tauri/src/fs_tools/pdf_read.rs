//! PDF text extraction: PDFium-backed with a pdf-extract fallback.
//!
//! PDFium is initialized once at app startup (see `init_pdfium`); if its
//! shared library isn't present (e.g. building without the bundled libs)
//! we fall back to the pure-Rust pdf-extract crate. Reading layout-heavy
//! PDFs (tax forms, invoices) goes through `reconstruct_page_layout` to
//! restore visual reading order, which the raw character stream doesn't
//! guarantee.

use super::path::{resolve_in_workdir, stat_within_limit, workdir_path, MAX_DOC_READ_BYTES};
use pdfium_render::prelude::{PdfPageText, Pdfium};
use std::path::Path;
use std::sync::OnceLock;
use tokio::fs;

/// The process-wide PDFium handle, set once at app startup via init_pdfium():
/// `Some` when the shared library bound, `None` when it didn't, in which case
/// we fall back to the pure-Rust pdf-extract crate. pdfium-render binds the
/// library and runs `FPDF_InitLibrary` once per process (a second
/// `bind_to_library` fails), so one instance is shared rather than built per
/// call. Its default `thread_safe` feature makes `Pdfium` Send + Sync and
/// serialises every call into the library.
static PDFIUM: OnceLock<Option<Pdfium>> = OnceLock::new();

/// Initialize pdfium by loading libpdfium from the resource dir. Should be
/// called once at app startup. Safe to call multiple times.
pub fn init_pdfium(resource_dir: &Path) {
    PDFIUM.get_or_init(|| {
        let libs_dir = resource_dir.join("binaries").join("libs");
        let lib_name = Pdfium::pdfium_platform_library_name_at_path(&libs_dir);
        match Pdfium::bind_to_library(&lib_name) {
            Ok(bindings) => {
                log::info!("PDFium initialized from {}", lib_name.display());
                Some(Pdfium::new(bindings))
            }
            Err(e) => {
                log::warn!(
                    "PDFium not available ({}); PDF extraction will use fallback",
                    e
                );
                None
            }
        }
    });
}

/// The shared PDFium instance, or `None` before init or when the library
/// failed to load.
fn pdfium() -> Option<&'static Pdfium> {
    PDFIUM.get().and_then(Option::as_ref)
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
    let pdfium = pdfium().ok_or_else(|| "pdfium unavailable".to_string())?;
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
fn reconstruct_page_layout(page_text: &PdfPageText) -> String {
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
    let text = super::read_document_blocking(workdir, rel_path, "PDF", extract_pdf_text).await?;
    finish_pdf_text(text)
}

/// Extract text from a PDF at a fully-resolved path. Used by the Shell-tab
/// absolute-path variant (`fs_read_pdf_absolute`); the workdir-relative
/// `fs_read_pdf` runs the same extraction via `read_document_blocking`.
pub(super) async fn read_pdf_at_path(resolved: &std::path::Path) -> Result<String, String> {
    let text = super::extract_document_blocking(resolved, "PDF", extract_pdf_text).await?;
    finish_pdf_text(text)
}

/// Blocking PDF text extraction. Try pdfium first — it's the same library
/// Chrome uses, handles forms and custom fonts correctly. Fall back to
/// pdf-extract if pdfium isn't available (missing native lib).
fn extract_pdf_text(path: &Path) -> Result<String, String> {
    if pdfium().is_some() {
        match extract_pdf_with_pdfium(path) {
            Ok(t) => return Ok(t),
            Err(e) => log::warn!("pdfium extraction failed: {}; falling back", e),
        }
    }
    pdf_extract::extract_text(path).map_err(|e| format!("Failed to extract PDF text: {}", e))
}

/// Post-process extracted PDF text: trim, reject empty extractions with a
/// pointer at the visual reader, and cap the size so a huge PDF doesn't
/// blow up the context.
fn finish_pdf_text(text: String) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(
            "PDF has no extractable text (it may be a scanned document without OCR). \
             Try fs_read_pdf_pages to read it visually."
                .to_string(),
        );
    }

    if let Some(truncated) =
        crate::text_util::truncate_with_note(trimmed, crate::text_util::MAX_EXTRACTED_TEXT_CHARS)
    {
        return Ok(truncated);
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

    stat_within_limit(&resolved, MAX_DOC_READ_BYTES, "PDF").await?;

    let bytes = fs::read(&resolved)
        .await
        .map_err(|e| format!("Failed to read PDF: {}", e))?;

    if bytes.len() < 4 || &bytes[..4] != b"%PDF" {
        return Err("File does not appear to be a valid PDF".to_string());
    }

    Ok(B64.encode(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Runs without the PDFium shared library (CI has none, so a test that
    // reads a real PDF through PDFium can't run here): a missing library
    // leaves the handle empty, a second init is a no-op rather than a panic
    // or a re-bind, and extraction reports the fallback without touching
    // PDFium.
    #[test]
    fn missing_library_leaves_pdfium_unset_and_reports_fallback() {
        let dir = std::env::temp_dir().join(format!("haruspex-no-pdfium-{}", std::process::id()));
        init_pdfium(&dir);
        init_pdfium(&dir);
        assert!(pdfium().is_none());
        let err = extract_pdf_with_pdfium(&dir.join("a.pdf")).unwrap_err();
        assert_eq!(err, "pdfium unavailable");
    }

    // The pdfium_<build> feature in Cargo.toml has to match the library
    // scripts/fetch-pdfium.sh downloads, or binding fails on a missing symbol
    // and every PDF quietly takes the fallback. Only checkable where the
    // library has been fetched (dev machines, not CI), so it skips otherwise.
    // Binding without `Pdfium::new` leaves the process-wide state untouched.
    #[test]
    fn fetched_library_matches_the_bindings_feature() {
        let lib = Pdfium::pdfium_platform_library_name_at_path(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join("libs"),
        );
        if !lib.exists() {
            return;
        }
        if let Err(e) = Pdfium::bind_to_library(&lib) {
            panic!(
                "{} doesn't match the pdfium-render feature: {e}",
                lib.display()
            );
        }
    }
}
