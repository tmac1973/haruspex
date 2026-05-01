//! External URL opener.
//!
//! Replaces tauri-plugin-shell's `open()` for inline reference / citation
//! links so we can:
//!   1. Log every open attempt to the in-memory app log (useful for
//!      diagnosing "the link did nothing" reports — the renderer's
//!      console isn't piped to terminal stderr, and devtools are
//!      disabled in release builds).
//!   2. Sanitize `LD_LIBRARY_PATH` on Linux before launching the system
//!      URL handler. AppImage's AppRun script prepends the bundled
//!      `$APPDIR/usr/lib` to `LD_LIBRARY_PATH` so the main binary can
//!      find its sidecar libs; that path is then inherited by every
//!      child process, including `xdg-open`'s spawned browser, which
//!      can fail silently when AppImage-bundled libs (libssl, libnss3,
//!      etc.) ABI-collide with the browser's own. Stripping `$APPDIR`
//!      entries from `LD_LIBRARY_PATH` for the child fixes the link
//!      handoff without touching the parent process.

use log::{error, info};

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    info!("open_url: {}", url);

    if !url.starts_with("http://") && !url.starts_with("https://") {
        let msg = format!("refusing non-http(s) URL: {}", url);
        error!("{}", msg);
        return Err(msg);
    }

    spawn_url_handler(&url).map_err(|e| {
        error!("open_url failed for {}: {}", url, e);
        e
    })
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

/// Strip AppImage-bundled paths out of LD_LIBRARY_PATH for the child
/// process. No-op when not running inside an AppImage (APPDIR unset),
/// so dev mode and .deb / .rpm installs are unaffected.
#[cfg(target_os = "linux")]
fn sanitize_appimage_env(cmd: &mut std::process::Command) {
    let appdir = match std::env::var("APPDIR") {
        Ok(v) if !v.is_empty() => v,
        _ => return,
    };
    let current = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
    let cleaned: Vec<&str> = current
        .split(':')
        .filter(|p| !p.is_empty() && !p.starts_with(&appdir))
        .collect();
    if cleaned.is_empty() {
        cmd.env_remove("LD_LIBRARY_PATH");
    } else {
        cmd.env("LD_LIBRARY_PATH", cleaned.join(":"));
    }
}
