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

use log::{error, info, warn};

/// Open a web address in the user's browser, for flows that start inside the
/// app (a sign-in) rather than from a link the model wrote.
pub(crate) fn open_in_browser(url: &str) -> Result<(), String> {
    spawn_url_handler(url)
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let logged = crate::text_util::url_for_log(&url);
    info!("open_url: {}", logged);

    if !url.starts_with("http://") && !url.starts_with("https://") {
        warn!("refusing non-http(s) URL: {}", logged);
        return Err(format!("refusing non-http(s) URL: {}", logged));
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

/// Open a video Haruspex rendered with the system's player. Only an `.mp4`
/// the video task registry recorded reaches this, never a path the model or a
/// page chose.
pub(crate) fn open_render(file: &std::path::Path) -> Result<(), String> {
    let is_mp4 = file
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    if !is_mp4 || !file.is_file() {
        return Err(format!("not a rendered video: {}", file.display()));
    }
    info!("open_render: {}", file.display());
    spawn_folder_handler(file)
}

#[cfg(target_os = "linux")]
fn spawn_folder_handler(dir: &std::path::Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(dir);
    crate::env_util::sanitize_appimage_env(&mut cmd);
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
    crate::env_util::sanitize_appimage_env(&mut cmd);
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

/// `rundll32 url.dll,FileProtocolHandler` rather than `cmd /C start`: cmd
/// reads `&` as a command separator, and nearly every URL with a query string
/// has one — an OAuth sign-in URL always does.
#[cfg(target_os = "windows")]
fn spawn_url_handler(url: &str) -> Result<(), String> {
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("rundll32 spawn failed: {}", e))
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
    async fn a_refusal_names_the_scheme_not_the_whole_url() {
        let err = open_url("ftp://user:secret@example.com/f?token=abc".to_string())
            .await
            .unwrap_err();
        assert_eq!(err, "refusing non-http(s) URL: ftp://example.com");
    }

    #[tokio::test]
    async fn only_existing_folders_are_opened() {
        let dir = crate::test_util::temp_dir("open_folder");
        let file = dir.join("run.sh");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        let err = open_folder(file.display().to_string()).await.unwrap_err();
        let missing = open_folder(dir.join("nope").display().to_string()).await;
        assert!(err.contains("not a folder"), "{err}");
        assert!(missing.is_err());
    }
}
