//! PowerPoint (.pptx) writing. The deck is built in the frontend with
//! PptxGenJS (`src/lib/slides/`); this only puts the finished package in the
//! working directory. It arrives as the raw body: a deck with photos is too
//! much for a JSON number array, and past `MAX_WRITE_BYTES`, the cap for
//! content a model writes.

use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path_for_write, write_bytes_to_workdir,
};

/// The largest deck written. Each picture is held to
/// `MAX_EMBEDDED_IMAGE_BYTES` when the deck is built; this bounds a deck of
/// many.
const MAX_DECK_BYTES: usize = 200 * 1_048_576;

/// A header's value, percent-decoded: a path can hold any character, and a
/// header only ASCII.
fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("No {name} was given."))?;
    urlencoding::decode(raw)
        .map(|s| s.into_owned())
        .map_err(|e| format!("{name} is not valid UTF-8: {e}"))
}

/// Only a .pptx path and a zip package: the cap here is above the one for
/// content a model writes, so this must not become a way around it.
fn check_deck(rel_path: &str, bytes: &[u8]) -> Result<(), String> {
    if !rel_path.to_ascii_lowercase().ends_with(".pptx") {
        return Err(format!("{rel_path} is not a .pptx path."));
    }
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err("The deck is not a PowerPoint package.".into());
    }
    if bytes.len() > MAX_DECK_BYTES {
        return Err(format!(
            "The deck is too large ({} bytes). Maximum is {} bytes.",
            bytes.len(),
            MAX_DECK_BYTES
        ));
    }
    Ok(())
}

/// Write a built deck: the package is the raw body, and the folder, path and
/// overwrite choice are `x-workdir`, `x-rel-path` and `x-overwrite`.
#[tauri::command]
pub async fn fs_write_pptx(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The deck must be sent as raw bytes.".into());
    };
    let workdir = workdir_path_for_write(&header(&request, "x-workdir")?)?;
    let rel_path = header(&request, "x-rel-path")?;
    let overwrite = header(&request, "x-overwrite").ok().map(|v| v == "true");
    check_deck(&rel_path, bytes)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;
    refuse_if_exists(&resolved, overwrite, &rel_path)?;
    write_bytes_to_workdir(&resolved, bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deck_must_be_a_pptx_path_and_a_zip() {
        assert!(check_deck("talk.pptx", b"PK\x03\x04rest").is_ok());
        assert!(check_deck("Talk.PPTX", b"PK\x03\x04rest").is_ok());
        assert!(check_deck("talk.txt", b"PK\x03\x04rest")
            .unwrap_err()
            .contains("not a .pptx"));
        assert!(check_deck("talk.pptx", b"hello")
            .unwrap_err()
            .contains("not a PowerPoint"));
    }

    #[test]
    fn a_deck_past_the_cap_is_refused() {
        let mut big = b"PK\x03\x04".to_vec();
        big.resize(MAX_DECK_BYTES + 1, 0);
        assert!(check_deck("talk.pptx", &big)
            .unwrap_err()
            .contains("too large"));
    }
}
