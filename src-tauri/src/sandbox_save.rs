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

#[derive(Serialize)]
pub struct SandboxDeleteResult {
    pub path: String,
}

/// Backs `haruspex.delete(filename)` from the Python sandbox. Used by the
/// post-run drain to propagate Python-side `os.remove(...)` / file moves
/// back to the host: anything that was in the pre-run workdir snapshot
/// but is missing from MEMFS after the run gets deleted here too. Path
/// validation matches `sandbox_save` — relative to the workdir, no `..`,
/// no symlink escapes. A missing target file is treated as a no-op
/// (Python already removed it from MEMFS; if host never had it, fine).
#[tauri::command]
pub async fn sandbox_delete_in_workdir(
    workdir: Option<String>,
    rel_path: String,
) -> Result<SandboxDeleteResult, String> {
    let workdir = workdir
        .ok_or_else(|| "No working directory set for this chat — cannot delete.".to_string())?;

    let workdir_path = PathBuf::from(&workdir);
    let resolved = resolve_in_workdir(&workdir_path, &rel_path)?;

    match fs::metadata(&resolved).await {
        Ok(meta) if meta.is_dir() => {
            return Err(format!(
                "Refusing to delete directory via sandbox bridge: {}",
                resolved.to_string_lossy()
            ));
        }
        Ok(_) => {
            fs::remove_file(&resolved)
                .await
                .map_err(|e| format!("Failed to delete file: {}", e))?;
        }
        Err(_) => {
            // Target doesn't exist on host. Nothing to do — the Python
            // delete already took effect in MEMFS, and host was already
            // in the post-delete state. Treat as success.
        }
    }

    Ok(SandboxDeleteResult {
        path: resolved.to_string_lossy().to_string(),
    })
}
