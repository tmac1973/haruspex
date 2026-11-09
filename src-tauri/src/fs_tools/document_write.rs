//! Document writing. PDF, Word and LibreOffice documents are built in the
//! frontend (`src/lib/documents/`); this only puts the finished file in the
//! working directory. It arrives as the raw body, as a deck does (`pptx.rs`):
//! a document with photos is too much for a JSON number array.

use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path_for_write, write_bytes_to_workdir,
};
use super::pptx::header;

/// The largest document written. Each picture is held to the slides' image
/// cap when the document is built; this bounds a document of many.
const MAX_DOCUMENT_BYTES: usize = 200 * 1_048_576;

/// A format this writes: its extension, the bytes its files start with, and
/// what to call one in an error.
struct Format {
    ext: &'static str,
    magic: &'static [u8],
    name: &'static str,
}

const PDF: Format = Format {
    ext: ".pdf",
    magic: b"%PDF-",
    name: "a PDF",
};
/// Word and OpenDocument files are zip archives.
const DOCX: Format = Format {
    ext: ".docx",
    magic: b"PK\x03\x04",
    name: "a Word document",
};
const ODT: Format = Format {
    ext: ".odt",
    magic: b"PK\x03\x04",
    name: "an OpenDocument text file",
};

/// Only a path of the format's extension and a file of the format: the cap
/// here is above the one for content a model writes, so this must not
/// become a way around it.
fn check(format: &Format, rel_path: &str, bytes: &[u8]) -> Result<(), String> {
    if !rel_path.to_ascii_lowercase().ends_with(format.ext) {
        return Err(format!("{rel_path} is not a {} path.", format.ext));
    }
    if !bytes.starts_with(format.magic) {
        return Err(format!("The document is not {}.", format.name));
    }
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "The document is too large ({} bytes). Maximum is {} bytes.",
            bytes.len(),
            MAX_DOCUMENT_BYTES
        ));
    }
    Ok(())
}

/// Write a built document: the file is the raw body, and the folder, path
/// and overwrite choice are `x-workdir`, `x-rel-path` and `x-overwrite`.
async fn write_built(request: tauri::ipc::Request<'_>, format: &Format) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The document must be sent as raw bytes.".into());
    };
    let workdir = workdir_path_for_write(&header(&request, "x-workdir")?)?;
    let rel_path = header(&request, "x-rel-path")?;
    let overwrite = header(&request, "x-overwrite").ok().map(|v| v == "true");
    check(format, &rel_path, bytes)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;
    refuse_if_exists(&resolved, overwrite, &rel_path)?;
    write_bytes_to_workdir(&resolved, bytes).await
}

#[tauri::command]
pub async fn fs_write_pdf(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    write_built(request, &PDF).await
}

#[tauri::command]
pub async fn fs_write_docx(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    write_built(request, &DOCX).await
}

#[tauri::command]
pub async fn fs_write_odt(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    write_built(request, &ODT).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pdf_must_be_a_pdf_path_and_a_pdf() {
        assert!(check(&PDF, "report.pdf", b"%PDF-1.7\nrest").is_ok());
        assert!(check(&PDF, "Report.PDF", b"%PDF-1.3").is_ok());
        assert!(check(&PDF, "report.txt", b"%PDF-1.7")
            .unwrap_err()
            .contains("not a .pdf"));
        assert!(check(&PDF, "report.pdf", b"hello")
            .unwrap_err()
            .contains("not a PDF"));
    }

    #[test]
    fn word_and_opendocument_files_are_zips_at_their_own_paths() {
        assert!(check(&DOCX, "notes.docx", b"PK\x03\x04rest").is_ok());
        assert!(check(&ODT, "Notes.ODT", b"PK\x03\x04rest").is_ok());
        assert!(check(&DOCX, "notes.odt", b"PK\x03\x04")
            .unwrap_err()
            .contains("not a .docx"));
        assert!(check(&ODT, "notes.odt", b"%PDF-1.7")
            .unwrap_err()
            .contains("not an OpenDocument"));
    }

    #[test]
    fn a_document_past_the_cap_is_refused() {
        let mut big = b"%PDF-".to_vec();
        big.resize(MAX_DOCUMENT_BYTES + 1, 0);
        assert!(check(&PDF, "report.pdf", &big)
            .unwrap_err()
            .contains("too large"));
    }
}
