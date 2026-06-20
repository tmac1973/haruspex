//! Plain-text file Tauri commands: read, write, find-and-replace edit.
//! All three sandbox via `resolve_in_workdir` like every other fs tool.

use super::fuzzy::{apply_edit, EditResult};
use super::path::{
    refuse_if_exists, render_text_read, resolve_in_workdir, workdir_path, workdir_path_for_write,
    write_bytes_to_workdir, MAX_READ_LOAD_BYTES, MAX_TEXT_READ_BYTES, MAX_WRITE_BYTES,
};
use tokio::fs;

/// Read a text file, optionally windowed by 1-indexed `offset` (start line)
/// and `limit` (max lines). Large files are head-truncated with a marker
/// rather than erroring, so the model always gets something to work with.
#[tauri::command]
pub async fn fs_read_text(
    workdir: String,
    rel_path: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }

    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_READ_LOAD_BYTES {
        return Err(format!(
            "File too large to load ({} bytes, max {} MB). Read it in slices with the offset/limit parameters or via the shell (head/sed).",
            metadata.len(),
            MAX_READ_LOAD_BYTES / 1_048_576
        ));
    }

    let bytes = fs::read(&resolved)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    render_text_read(
        bytes,
        offset,
        limit,
        "File appears to be binary. Use a format-specific tool (fs_read_pdf, fs_read_image, etc.)",
    )
}

#[tauri::command]
pub async fn fs_write_text(
    workdir: String,
    rel_path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path_for_write(&workdir)?;
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
    write_bytes_to_workdir(&resolved, content.as_bytes()).await
}

/// Find-and-replace edit. `old_str` must resolve to a unique match — exactly
/// (preferred) or, failing that, via a whitespace/quote/dash-insensitive fuzzy
/// fallback (see `fuzzy::apply_edit`). Returns what changed for a compact
/// confirmation.
#[tauri::command]
pub async fn fs_edit_text(
    workdir: String,
    rel_path: String,
    old_str: String,
    new_str: String,
) -> Result<EditResult, String> {
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

    let outcome = apply_edit(&content, &old_str, &new_str, &rel_path)?;
    fs::write(&resolved, outcome.new_content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(outcome.result)
}
