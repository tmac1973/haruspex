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

use super::fuzzy::{apply_edit, EditResult};
use super::path::{
    refuse_if_exists, render_text_read, DirListing, MAX_READ_LOAD_BYTES, MAX_TEXT_READ_BYTES,
    MAX_WRITE_BYTES,
};
use std::path::PathBuf;
use tokio::fs;

fn require_absolute(path: &str) -> Result<PathBuf, String> {
    // WSL sessions hand us Linux paths. One under the Windows automount
    // (/mnt/<drive>/…) is just the Windows filesystem mounted in the distro, so
    // translate it to the real Windows path — the file tools run on the Windows
    // host. A native-distro path (/home/…) has no Windows equivalent.
    let translated = normalize_wsl_mount(path);
    let p = PathBuf::from(&translated);
    if !p.is_absolute() {
        #[cfg(windows)]
        if translated.starts_with('/') {
            return Err(format!(
                "Path is inside the WSL distro, which the file tools can't reach: {path}. They \
                 operate on the Windows filesystem — use a path under /mnt/<drive>/… (e.g. \
                 /mnt/c/Users/…), or have the user work on in-distro files directly."
            ));
        }
        return Err(format!(
            "Path must be absolute when called from the Shell agent: {translated}"
        ));
    }
    Ok(p)
}

/// Translate a WSL Windows-automount path ("/mnt/c/Users/tim") to the real
/// Windows path ("C:\\Users\\tim"). Windows-only: a native Linux `/mnt` mount
/// must never be rewritten, so this is a no-op off Windows.
#[cfg(windows)]
fn normalize_wsl_mount(path: &str) -> String {
    let b = path.as_bytes();
    let is_mount = b.len() >= 6
        && path.starts_with("/mnt/")
        && b[5].is_ascii_alphabetic()
        && (b.len() == 6 || b[6] == b'/');
    if is_mount {
        let drive = path[5..6].to_ascii_uppercase();
        let rest = path[6..].replace('/', "\\");
        let rest = if rest.is_empty() {
            "\\".to_string()
        } else {
            rest
        };
        format!("{drive}:{rest}")
    } else {
        path.to_string()
    }
}

#[cfg(not(windows))]
fn normalize_wsl_mount(path: &str) -> String {
    path.to_string()
}

#[tauri::command]
pub async fn fs_read_text_absolute(
    path: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<String, String> {
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
        "File appears to be binary. Use a format-specific tool (fs_read_pdf_absolute, etc.)",
    )
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

    // Surface hidden files (unlike the workdir listing) — admin troubleshooting
    // often needs to see .bashrc, .ssh, etc.
    let (entries, truncated) = super::path::collect_dir_entries(&resolved, true).await?;

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
) -> Result<EditResult, String> {
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

    let outcome = apply_edit(&content, &old_str, &new_str, &path)?;
    fs::write(&resolved, outcome.new_content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(outcome.result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn normalizes_wsl_mount_paths() {
        assert_eq!(normalize_wsl_mount("/mnt/c/Users/tim"), "C:\\Users\\tim");
        assert_eq!(normalize_wsl_mount("/mnt/d/a/b"), "D:\\a\\b");
        // Native-distro and Windows paths pass through unchanged.
        assert_eq!(normalize_wsl_mount("/home/tim/proj"), "/home/tim/proj");
        assert_eq!(normalize_wsl_mount("C:\\already\\win"), "C:\\already\\win");
    }

    #[tokio::test]
    async fn rejects_relative_path() {
        let err = fs_read_text_absolute("etc/passwd".to_string(), None, None)
            .await
            .unwrap_err();
        assert!(err.contains("must be absolute"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_missing_file_with_actionable_message() {
        // Build an absolute path that definitely doesn't exist. A bare Unix
        // path like "/this/..." isn't absolute on Windows (no drive prefix),
        // so root it under the platform temp dir to reach the not-found branch.
        let missing = std::env::temp_dir().join("haruspex-nope/does/not/exist/at/all");
        let err = fs_read_text_absolute(missing.to_string_lossy().into_owned(), None, None)
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
        // An absolute path that exists and is a directory on every platform
        // (Windows /tmp isn't absolute, so use the real temp dir).
        let dir = std::env::temp_dir();
        let err = fs_read_text_absolute(dir.to_string_lossy().into_owned(), None, None)
            .await
            .unwrap_err();
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
        let body = fs_read_text_absolute("/etc/os-release".to_string(), None, None)
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
