//! Native clipboard reads for the shell tab's paste path.
//!
//! The webview's `navigator.clipboard.readText()` is unreliable under
//! WebKitGTK — it depends on document focus, transient user-activation and
//! permission state, and frequently returns an empty string instead. That made
//! pasting into the shell tab work only intermittently. Reading from the native
//! side (arboard) sidesteps the webview entirely.

use arboard::Clipboard;

/// Map arboard's result into "" for an empty / non-text clipboard so the
/// frontend treats it as "nothing to paste" rather than a hard error.
fn or_empty(result: Result<String, arboard::Error>) -> Result<String, String> {
    match result {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Read the system clipboard (the CLIPBOARD selection).
#[tauri::command]
pub fn clipboard_read_text() -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    or_empty(clipboard.get_text())
}

/// Read the X11/Wayland PRIMARY selection — the most recently highlighted text,
/// in any window — for middle-click paste. The webview clipboard API can't
/// reach the primary selection, only the native side can.
#[cfg(target_os = "linux")]
#[tauri::command]
pub fn clipboard_read_primary() -> Result<String, String> {
    use arboard::{GetExtLinux, LinuxClipboardKind};
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    or_empty(
        clipboard
            .get()
            .clipboard(LinuxClipboardKind::Primary)
            .text(),
    )
}

/// Other platforms have no primary selection; fall back to the clipboard so
/// middle-click paste still does something sensible.
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn clipboard_read_primary() -> Result<String, String> {
    clipboard_read_text()
}
