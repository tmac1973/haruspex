//! Binary file Tauri commands, sandboxed through `resolve_in_workdir` like
//! every other fs tool.
//!
//! The text commands cannot serve a PNG: base64 through `fs_write_text` would
//! put a text file on disk where a real image has to be, and the generated
//! assets are read back by the game, by the contact sheet, and by a later run
//! deciding whether an asset already exists.

use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path, workdir_path_for_write,
    write_bytes_to_workdir, MAX_WRITE_BYTES,
};

/// Read a file as bytes.
#[tauri::command]
pub async fn fs_read_bytes(workdir: String, rel_path: String) -> Result<Vec<u8>, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;
    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }
    tokio::fs::read(&resolved)
        .await
        .map_err(|e| format!("Failed to read {}: {}", rel_path, e))
}

/// Write bytes, creating parent directories.
#[tauri::command]
pub async fn fs_write_bytes(
    workdir: String,
    rel_path: String,
    bytes: Vec<u8>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path_for_write(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if bytes.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Content too large ({} bytes). Maximum write is {} bytes.",
            bytes.len(),
            MAX_WRITE_BYTES
        ));
    }
    refuse_if_exists(&resolved, overwrite, &rel_path)?;
    write_bytes_to_workdir(&resolved, &bytes).await
}
