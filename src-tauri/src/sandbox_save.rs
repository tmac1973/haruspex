//! Tauri command backing `haruspex.save(filename, content)` from the Python
//! sandbox. Lets the model write large binary blobs (matplotlib PNGs,
//! exported DataFrames, generated images) into the active chat's working
//! directory without round-tripping the bytes through its own context
//! window via `fs_write_text`.
//!
//! Path sandboxing is delegated to Phase 9's `resolve_in_workdir`, so the
//! same escape-rejection rules (no `..`, no symlink-out, no absolute paths
//! outside the workdir) apply uniformly.

use crate::fs_tools::resolve_in_workdir;
use serde::Serialize;
use std::path::PathBuf;
use tokio::fs;

/// Per-save size cap. Bigger than `fs_write_text`'s 10 MB because the
/// intended payloads here are rendered images and full DataFrame HTMLs,
/// not text edits. 100 MB is enough for any plot or table the model is
/// likely to produce while still bounding worst-case disk use.
const MAX_SANDBOX_SAVE_BYTES: usize = 100 * 1_048_576;

#[derive(Serialize)]
pub struct SandboxSaveResult {
    pub path: String,
    pub bytes: usize,
}

#[tauri::command]
pub async fn sandbox_save(
    workdir: Option<String>,
    rel_path: String,
    content: Vec<u8>,
) -> Result<SandboxSaveResult, String> {
    let workdir = workdir.ok_or_else(|| {
        "No working directory set for this chat — ask the user to select one before saving files."
            .to_string()
    })?;

    if content.len() > MAX_SANDBOX_SAVE_BYTES {
        return Err(format!(
            "Save too large ({} bytes). Maximum is {} bytes.",
            content.len(),
            MAX_SANDBOX_SAVE_BYTES
        ));
    }

    let workdir_path = PathBuf::from(&workdir);
    let resolved = resolve_in_workdir(&workdir_path, &rel_path)?;

    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    let bytes_written = content.len();
    fs::write(&resolved, content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(SandboxSaveResult {
        path: resolved.to_string_lossy().to_string(),
        bytes: bytes_written,
    })
}
