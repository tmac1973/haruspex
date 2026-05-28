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

use super::path::{DirEntry, DirListing};
use std::path::PathBuf;
use tokio::fs;

const MAX_TEXT_READ_BYTES: u64 = 1_048_576; // 1 MB
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

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", path));
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

    if !resolved.is_dir() {
        return Err(format!("Not a directory: {}", path));
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
    async fn rejects_missing_file() {
        let err = fs_read_text_absolute("/this/path/does/not/exist/at/all".to_string())
            .await
            .unwrap_err();
        assert!(err.contains("Not a file"), "got: {err}");
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
        assert!(
            listing.entries.iter().any(|e| e.name == "os-release"),
            "expected os-release in /etc listing"
        );
    }
}
