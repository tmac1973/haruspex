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

use super::fuzzy::EditResult;
use super::path::{
    edit_text_at, read_text_at, refuse_if_exists, write_atomic, DirListing, MAX_WRITE_BYTES,
};
use std::path::PathBuf;

/// `wsl_distro` is the WSL distro the Shell-tab session runs in (Windows only;
/// None for PowerShell and on Linux/macOS). Also used by `code_grep` /
/// `code_glob` to resolve a WSL session's Linux working directory.
pub(crate) fn require_absolute(path: &str, wsl_distro: Option<&str>) -> Result<PathBuf, String> {
    // WSL sessions hand us Linux paths. One under the Windows automount
    // (/mnt/<drive>/…) is just the Windows filesystem mounted in the distro, so
    // translate it to the real Windows path — the file tools run on the Windows
    // host. A native-distro path (/home/…) is reached through the distro's
    // `\\wsl.localhost\<distro>\…` share.
    let translated = normalize_wsl_mount(path);
    let p = PathBuf::from(&translated);
    if !p.is_absolute() {
        #[cfg(windows)]
        if translated.starts_with('/') {
            if let Some(unc) = wsl_distro.and_then(|d| wsl_distro_unc(&translated, d)) {
                return Ok(PathBuf::from(unc));
            }
            return Err(format!(
                "Path is inside a WSL distro, but this session isn't a WSL shell: {path}. The \
                 file tools operate on the Windows filesystem — use a Windows path or one under \
                 /mnt/<drive>/… (e.g. /mnt/c/Users/…)."
            ));
        }
        return Err(format!(
            "Path must be absolute when called from the Shell agent: {translated}"
        ));
    }
    #[cfg(not(windows))]
    let _ = wsl_distro;
    Ok(p)
}

/// Map a native-distro Linux path ("/home/tim") to the Windows share that
/// exposes the distro's filesystem ("\\\\wsl.localhost\\Ubuntu\\home\\tim").
/// None for a distro name that could escape the share root.
#[cfg(windows)]
fn wsl_distro_unc(path: &str, distro: &str) -> Option<String> {
    if distro.is_empty() || distro.contains(['\\', '/']) || distro.starts_with('.') {
        return None;
    }
    Some(format!(
        "\\\\wsl.localhost\\{distro}{}",
        path.replace('/', "\\")
    ))
}

/// The path to report back to the model: the Linux path it asked for when the
/// tool reached into a WSL distro, so it keeps using the paths the shell shows
/// rather than switching to the UNC form; the resolved path otherwise.
fn display_path(requested: &str, resolved: &std::path::Path) -> String {
    let resolved = resolved.to_string_lossy();
    if resolved.starts_with("\\\\wsl.localhost\\") && requested.starts_with('/') {
        requested.to_string()
    } else {
        resolved.into_owned()
    }
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
    wsl_distro: Option<String>,
) -> Result<String, String> {
    let resolved = require_absolute(&path, wsl_distro.as_deref())?;

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

    read_text_at(
        &resolved,
        offset,
        limit,
        "File appears to be binary. Use a format-specific tool (fs_read_pdf_absolute, etc.)",
    )
    .await
}

#[tauri::command]
pub async fn fs_list_dir_absolute(
    path: String,
    wsl_distro: Option<String>,
) -> Result<DirListing, String> {
    let resolved = require_absolute(&path, wsl_distro.as_deref())?;

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
        path: display_path(&path, &resolved),
        entries,
        truncated,
    })
}

#[tauri::command]
pub async fn fs_read_pdf_absolute(
    path: String,
    wsl_distro: Option<String>,
) -> Result<String, String> {
    let resolved = require_absolute(&path, wsl_distro.as_deref())?;
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
    wsl_distro: Option<String>,
) -> Result<(), String> {
    let resolved = require_absolute(&path, wsl_distro.as_deref())?;

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

    // Atomic: a failed write must leave the previous file intact rather than
    // truncating it. See `write_atomic`.
    write_atomic(&resolved, content.as_bytes()).await?;
    Ok(())
}

#[tauri::command]
pub async fn fs_edit_text_absolute(
    path: String,
    old_str: String,
    new_str: String,
    wsl_distro: Option<String>,
) -> Result<EditResult, String> {
    let resolved = require_absolute(&path, wsl_distro.as_deref())?;

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

    edit_text_at(&resolved, &old_str, &new_str, &path).await
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

    #[cfg(windows)]
    #[test]
    fn maps_native_distro_paths_to_the_wsl_share() {
        assert_eq!(
            require_absolute("/home/tim/test", Some("Ubuntu-24.04")).unwrap(),
            PathBuf::from("\\\\wsl.localhost\\Ubuntu-24.04\\home\\tim\\test")
        );
        // The Windows automount still resolves to the drive, not the share.
        assert_eq!(
            require_absolute("/mnt/c/Users", Some("Ubuntu-24.04")).unwrap(),
            PathBuf::from("C:\\Users")
        );
        // Without a distro (a PowerShell session) there is nowhere to send it.
        let err = require_absolute("/home/tim", None).unwrap_err();
        assert!(err.contains("isn't a WSL shell"), "got: {err}");
        // A distro name must not climb out of the share root.
        assert!(require_absolute("/etc", Some("..\\x")).is_err());
        assert!(require_absolute("/etc", Some("")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn reports_the_linux_path_for_distro_listings() {
        let resolved = require_absolute("/home/tim", Some("Ubuntu")).unwrap();
        assert_eq!(display_path("/home/tim", &resolved), "/home/tim");
        let resolved = require_absolute("/mnt/c/Users", Some("Ubuntu")).unwrap();
        assert_eq!(display_path("/mnt/c/Users", &resolved), "C:\\Users");
    }

    #[tokio::test]
    async fn rejects_relative_path() {
        let err = fs_read_text_absolute("etc/passwd".to_string(), None, None, None)
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
        let err = fs_read_text_absolute(missing.to_string_lossy().into_owned(), None, None, None)
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
        let err = fs_read_text_absolute(dir.to_string_lossy().into_owned(), None, None, None)
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
        let body = fs_read_text_absolute("/etc/os-release".to_string(), None, None, None)
            .await
            .expect("read /etc/os-release");
        assert!(body.contains("NAME="), "expected NAME= in /etc/os-release");
    }

    #[tokio::test]
    async fn lists_etc_directory() {
        if !std::path::Path::new("/etc").is_dir() {
            return;
        }
        let listing = fs_list_dir_absolute("/etc".to_string(), None)
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
