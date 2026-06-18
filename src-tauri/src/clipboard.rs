//! Native clipboard reads for the shell tab's paste path.
//!
//! The webview's `navigator.clipboard.readText()` is unreliable under
//! WebKitGTK — it depends on document focus, transient user-activation and
//! permission state, and frequently returns an empty string instead. That made
//! pasting into the shell tab work only intermittently. Reading from the native
//! side (arboard) sidesteps the webview entirely.
//!
//! These commands are `async` and do the arboard work inside `spawn_blocking`.
//! arboard's read is a blocking X11/Wayland selection round-trip that can stall
//! for seconds; a synchronous `#[tauri::command]` runs on the main thread and
//! would freeze the whole WebKitGTK UI (and, by stalling the JS event loop,
//! break the middle-click double-paste suppression in ShellPane.svelte, leaking
//! WebKitGTK's native CLIPBOARD paste instead of our PRIMARY paste). Running off
//! the main thread keeps the UI responsive and the suppression deterministic.

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

/// Run a blocking arboard read on a worker thread so it never blocks the Tauri
/// main thread (which drives the GUI event loop).
async fn read_off_main_thread<F>(read: F) -> Result<String, String>
where
    F: FnOnce(&mut Clipboard) -> Result<String, arboard::Error> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
        or_empty(read(&mut clipboard))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read the system clipboard (the CLIPBOARD selection).
#[tauri::command]
pub async fn clipboard_read_text() -> Result<String, String> {
    read_off_main_thread(|clipboard| clipboard.get_text()).await
}

/// Read the X11/Wayland PRIMARY selection — the most recently highlighted text,
/// in any window — for middle-click paste. The webview clipboard API can't
/// reach the primary selection, only the native side can.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn clipboard_read_primary() -> Result<String, String> {
    read_off_main_thread(|clipboard| {
        use arboard::{GetExtLinux, LinuxClipboardKind};
        clipboard
            .get()
            .clipboard(LinuxClipboardKind::Primary)
            .text()
    })
    .await
}

/// Other platforms have no primary selection; fall back to the clipboard so
/// middle-click paste still does something sensible.
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn clipboard_read_primary() -> Result<String, String> {
    clipboard_read_text().await
}
