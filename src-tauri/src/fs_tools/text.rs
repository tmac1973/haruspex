//! Plain-text file Tauri commands: read, write, find-and-replace edit.
//! All three sandbox via `resolve_in_workdir` like every other fs tool.

use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path, workdir_path_for_write,
    write_bytes_to_workdir, MAX_TEXT_READ_BYTES, MAX_WRITE_BYTES,
};
use tokio::fs;

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
