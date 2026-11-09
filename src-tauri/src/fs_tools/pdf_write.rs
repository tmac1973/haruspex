//! PDF writing. The document is built in the frontend with pdfmake
//! (`src/lib/documents/`); this only puts the finished file in the working
//! directory. It arrives as the raw body, as a deck does (`pptx.rs`): a PDF
//! with photos is too much for a JSON number array.

use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path_for_write, write_bytes_to_workdir,
};
use super::pptx::header;

/// The largest PDF written. Each picture is held to the slides' image cap
/// when the document is built; this bounds a document of many.
const MAX_PDF_BYTES: usize = 200 * 1_048_576;

/// Only a .pdf path and a PDF: the cap here is above the one for content a
/// model writes, so this must not become a way around it.
fn check_pdf(rel_path: &str, bytes: &[u8]) -> Result<(), String> {
    if !rel_path.to_ascii_lowercase().ends_with(".pdf") {
        return Err(format!("{rel_path} is not a .pdf path."));
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err("The document is not a PDF.".into());
    }
    if bytes.len() > MAX_PDF_BYTES {
        return Err(format!(
            "The PDF is too large ({} bytes). Maximum is {} bytes.",
            bytes.len(),
            MAX_PDF_BYTES
        ));
    }
    Ok(())
}

/// Write a built PDF: the file is the raw body, and the folder, path and
/// overwrite choice are `x-workdir`, `x-rel-path` and `x-overwrite`.
#[tauri::command]
pub async fn fs_write_pdf(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The PDF must be sent as raw bytes.".into());
    };
    let workdir = workdir_path_for_write(&header(&request, "x-workdir")?)?;
    let rel_path = header(&request, "x-rel-path")?;
    let overwrite = header(&request, "x-overwrite").ok().map(|v| v == "true");
    check_pdf(&rel_path, bytes)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;
    refuse_if_exists(&resolved, overwrite, &rel_path)?;
    write_bytes_to_workdir(&resolved, bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pdf_must_be_a_pdf_path_and_a_pdf() {
        assert!(check_pdf("report.pdf", b"%PDF-1.7\nrest").is_ok());
        assert!(check_pdf("Report.PDF", b"%PDF-1.3").is_ok());
        assert!(check_pdf("report.txt", b"%PDF-1.7")
            .unwrap_err()
            .contains("not a .pdf"));
        assert!(check_pdf("report.pdf", b"hello")
            .unwrap_err()
            .contains("not a PDF"));
    }

    #[test]
    fn a_pdf_past_the_cap_is_refused() {
        let mut big = b"%PDF-".to_vec();
        big.resize(MAX_PDF_BYTES + 1, 0);
        assert!(check_pdf("report.pdf", &big)
            .unwrap_err()
            .contains("too large"));
    }
}
