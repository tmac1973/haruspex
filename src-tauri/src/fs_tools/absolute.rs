//! Absolute-path fs_read commands used by the Shell tab agent.
//!
//! These are deliberately separate from the workdir-relative commands in
//! `text.rs`, `pdf_read.rs`, and `path.rs` so the explicit "no sandboxing"
//! decision is visible at the audit surface. The chat-tab fs tools must
//! never end up here by accident; the shell-tab tools must never end up
//! at `resolve_in_workdir` by accident. Parallel functions, parallel test
//! coverage.
//!
//! The agent runs as the app user, so it can read whatever the user could
//! read from a real shell — there is no allowlist. The user's expectation
//! when they open the Shell tab and ask "what's in /etc/nginx?" is that
//! the agent can answer.

use super::path::{refuse_if_exists, DirEntry, DirListing, MAX_TEXT_READ_BYTES, MAX_WRITE_BYTES};
use std::path::PathBuf;
use tokio::fs;

const MAX_DIR_ENTRIES: usize = 500;

fn require_absolute(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(format!(
            "Path must be absolute when called from the Shell agent: {}",
            path
        ));
    }
    Ok(p)
}

#[tauri::command]
pub async fn fs_read_text_absolute(path: String) -> Result<String, String> {
    let resolved = require_absolute(&path)?;

    if !resolved.exists() {
        let parent = resolved
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "/".to_string());
        return Err(format!(
            "Path does not exist: {}. The file is not there. Do not retry the same path. \
             If you wanted to know what's in the parent directory, call fs_list_dir on '{}'. \
             If you intended to create this file, call fs_write_text (when writes are enabled).",
            path, parent
        ));
    }
    if !resolved.is_file() {
        return Err(format!(
            "Path is not a regular file (may be a directory, socket, or symlink): {}. \
             Use fs_list_dir on this path if it's a directory.",
            path
        ));
    }

    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Failed to stat file: {}", e))?;

    if metadata.len() > MAX_TEXT_READ_BYTES {
        return Err(format!(
            "File too large ({} bytes). Maximum text read is {} bytes. Read it in chunks (head/tail/sed via the shell) or use a format-specific tool.",
            metadata.len(),
            MAX_TEXT_READ_BYTES
        ));
    }

    let bytes = fs::read(&resolved)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let sample_len = bytes.len().min(8192);
    if bytes[..sample_len].contains(&0) {
        return Err(
            "File appears to be binary. Use a format-specific tool (fs_read_pdf_absolute, etc.)"
                .to_string(),
        );
    }

    String::from_utf8(bytes).map_err(|e| format!("File is not valid UTF-8: {}", e))
}

#[tauri::command]
pub async fn fs_list_dir_absolute(path: String) -> Result<DirListing, String> {
    let resolved = require_absolute(&path)?;

    if !resolved.exists() {
        return Err(format!(
            "Path does not exist: {}. The directory is not there — do not retry the same path. \
             Ask the user where the file or directory is, or try a parent path you know exists.",
            path
        ));
    }
    if !resolved.is_dir() {
        return Err(format!(
            "Path exists but is not a directory: {}. Use fs_read_text if it's a file.",
            path
        ));
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    let mut read_dir = fs::read_dir(&resolved)
        .await
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read entry: {}", e))?
    {
        if entries.len() >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Unlike the workdir version, we surface hidden files — admin
        // troubleshooting often needs to see .bashrc, .ssh, etc.
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        entries.push(DirEntry {
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(DirListing {
        path: resolved.to_string_lossy().to_string(),
        entries,
        truncated,
    })
}

#[tauri::command]
pub async fn fs_read_pdf_absolute(path: String) -> Result<String, String> {
    let resolved = require_absolute(&path)?;
    if !resolved.is_file() {
        return Err(format!("Not a file: {}", path));
    }
    super::pdf_read::read_pdf_at_path(&resolved).await
}

#[tauri::command]
pub async fn fs_write_text_absolute(
    path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let resolved = require_absolute(&path)?;

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Content too large ({} bytes). Maximum write is {} bytes.",
            content.len(),
            MAX_WRITE_BYTES
        ));
    }

    refuse_if_exists(&resolved, overwrite, &path)?;

    // Refuse to create parent directories on a free-form absolute path —
    // the chat-mode equivalent does, but here the agent could ask the
    // user to `mkdir -p` via the shell first. Less footgun.
    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            return Err(format!(
                "Parent directory does not exist: {}. Create it via the shell first.",
                parent.display()
            ));
        }
    }

    fs::write(&resolved, content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn fs_edit_text_absolute(
    path: String,
    old_str: String,
    new_str: String,
) -> Result<(), String> {
    let resolved = require_absolute(&path)?;

    if !resolved.exists() {
        return Err(format!(
            "Path does not exist: {}. fs_edit_text only modifies existing files. \
             To create a new file with this content, call fs_write_text instead.",
            path
        ));
    }
    if !resolved.is_file() {
        return Err(format!("Path is not a regular file: {}", path));
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

    let occurrences = content.matches(&old_str).count();
    if occurrences == 0 {
        return Err(format!("old_str not found in {}", path));
    }
    if occurrences > 1 {
        return Err(format!(
            "old_str appears {} times in {}. It must be unique — include more surrounding context.",
            occurrences, path
        ));
    }

    let new_content = content.replacen(&old_str, &new_str, 1);
    fs::write(&resolved, new_content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_relative_path() {
        let err = fs_read_text_absolute("etc/passwd".to_string())
            .await
            .unwrap_err();
        assert!(err.contains("must be absolute"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_missing_file_with_actionable_message() {
        let err = fs_read_text_absolute("/this/path/does/not/exist/at/all".to_string())
            .await
            .unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
        assert!(
            err.contains("Do not retry"),
            "expected 'Do not retry' hint: {err}"
        );
        assert!(
            err.contains("fs_list_dir") || err.contains("fs_write_text"),
            "expected pivot suggestion: {err}"
        );
    }

    #[tokio::test]
    async fn rejects_directory_path_with_distinct_message() {
        let err = fs_read_text_absolute("/tmp".to_string()).await.unwrap_err();
        assert!(
            err.contains("not a regular file") || err.contains("directory"),
            "got: {err}"
        );
        assert!(
            err.contains("fs_list_dir"),
            "expected fs_list_dir pivot: {err}"
        );
    }

    #[tokio::test]
    async fn reads_etc_os_release_when_present() {
        // /etc/os-release exists on every modern Linux distro and is
        // exactly the kind of file the Shell agent will read. Skip
        // gracefully on platforms that don't have it.
        if !std::path::Path::new("/etc/os-release").exists() {
            return;
        }
        let body = fs_read_text_absolute("/etc/os-release".to_string())
            .await
            .expect("read /etc/os-release");
        assert!(body.contains("NAME="), "expected NAME= in /etc/os-release");
    }

    #[tokio::test]
    async fn lists_etc_directory() {
        if !std::path::Path::new("/etc").is_dir() {
            return;
        }
        let listing = fs_list_dir_absolute("/etc".to_string())
            .await
            .expect("list /etc");
        assert_eq!(listing.path, "/etc");
        // `hosts` lives in /etc on every Unix (Linux + macOS), unlike
        // os-release which is Linux-only — so the listing check stays
        // meaningful cross-platform.
        assert!(
            listing.entries.iter().any(|e| e.name == "hosts"),
            "expected hosts in /etc listing"
        );
    }
}
