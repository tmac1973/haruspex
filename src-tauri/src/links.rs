//! External URL and folder opener.
//!
//! Replaces tauri-plugin-shell's `open()` for inline reference / citation
//! links so we can:
//!   1. Log every open attempt to the in-memory app log (useful for
//!      diagnosing "the link did nothing" reports — the renderer's
//!      console isn't piped to terminal stderr, and devtools are
//!      disabled in release builds).
//!   2. Sanitize AppImage-mangled env on Linux before launching the
//!      system URL handler. AppImage's AppRun script points
//!      `LD_LIBRARY_PATH` and the Python vars at the mounted `$APPDIR`
//!      so the main binary can find its sidecar libs; those are then
//!      inherited by every child process, including `xdg-open`'s
//!      spawned browser, which can fail silently when AppImage-bundled
//!      libs (libssl, libnss3, etc.) ABI-collide with the browser's
//!      own. Stripping `$APPDIR` entries for the child fixes the link
//!      handoff without touching the parent process.

use log::{error, info};

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let logged = crate::text_util::url_for_log(&url);
    info!("open_url: {}", logged);

    if !url.starts_with("http://") && !url.starts_with("https://") {
        error!("refusing non-http(s) URL: {}", logged);
        return Err(format!("refusing non-http(s) URL: {}", url));
    }

    spawn_url_handler(&url).map_err(|e| {
        error!("open_url failed for {}: {}", logged, e);
        e
    })
}

/// Opens a directory in the system file manager. Only an existing directory is
/// accepted — never a file, which the handler would execute or open with
/// whatever app claims it.
#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    let dir = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    if !dir.is_dir() {
        return Err(format!("not a folder: {}", dir.display()));
    }
    info!("open_folder: {}", dir.display());
    spawn_folder_handler(&dir).map_err(|e| {
        error!("open_folder failed for {}: {}", dir.display(), e);
        e
    })
}

#[cfg(target_os = "linux")]
fn spawn_folder_handler(dir: &std::path::Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(dir);
    sanitize_appimage_env(&mut cmd);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("xdg-open spawn failed: {}", e))
}

#[cfg(target_os = "macos")]
fn spawn_folder_handler(dir: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open spawn failed: {}", e))
}

/// Explorer directly rather than `cmd /C start`: cmd would read `&` or `^` in
/// a folder name as its own syntax.
#[cfg(target_os = "windows")]
fn spawn_folder_handler(dir: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("explorer spawn failed: {}", e))
}

#[cfg(target_os = "linux")]
fn spawn_url_handler(url: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(url);
    sanitize_appimage_env(&mut cmd);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("xdg-open spawn failed: {}", e))
}

#[cfg(target_os = "macos")]
fn spawn_url_handler(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open spawn failed: {}", e))
}

#[cfg(target_os = "windows")]
fn spawn_url_handler(url: &str) -> Result<(), String> {
    // The leading "" is the title arg `start` expects when the next
    // argument might look like a quoted path; without it, a URL with
    // spaces would be misparsed as the window title.
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("start spawn failed: {}", e))
}

/// Strip AppImage-mangled variables (LD_LIBRARY_PATH, PYTHONHOME /
/// PYTHONPATH) out of the child process's env. No-op when not running
/// inside an AppImage (APPDIR unset), so dev mode and .deb / .rpm
/// installs are unaffected. The decisions live in `env_util` (shared
/// with the PTY spawn in `shell/session.rs`); this just applies them to
/// a std Command.
#[cfg(target_os = "linux")]
fn sanitize_appimage_env(cmd: &mut std::process::Command) {
    use crate::env_util::EnvFix;
    for fix in crate::env_util::appimage_env_fixes() {
        match fix {
            EnvFix::Remove(var) => {
                cmd.env_remove(var);
            }
            EnvFix::Set(var, value) => {
                cmd.env(var, value);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_web_links_are_handed_to_the_system() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hi",
            "ftp://example.com/",
            " https://example.com/",
            "",
        ] {
            let err = open_url(url.to_string()).await.unwrap_err();
            assert!(err.contains("refusing non-http(s) URL"), "{url}: {err}");
        }
    }

    #[tokio::test]
    async fn only_existing_folders_are_opened() {
        let dir = std::env::temp_dir().join(format!("haruspex-open-folder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("run.sh");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        let err = open_folder(file.display().to_string()).await.unwrap_err();
        let missing = open_folder(dir.join("nope").display().to_string()).await;
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(err.contains("not a folder"), "{err}");
        assert!(missing.is_err());
    }
}
