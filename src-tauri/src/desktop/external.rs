//! macOS and Windows capture, through [`xcap`].
//!
//! xcap's macOS backend is CoreGraphics and its Windows backend is the Win32
//! API — the same two things this would otherwise call by hand. Taking them as
//! a dependency trades unsafe code that cannot be compiled, let alone run, from
//! a Linux development machine for code that everyone else using the crate
//! exercises.
//!
//! The one thing added on top is the macOS permission check. Without the Screen
//! Recording grant, macOS does not fail a capture — it succeeds and hands back
//! the desktop picture with every window missing. A model asked what is on
//! screen would then confidently describe an empty desktop, so the grant is
//! checked before capturing and its absence reported as what it is.

use super::screenshot::{Capture, CaptureTarget};

pub async fn capture(target: CaptureTarget) -> Result<Capture, String> {
    require_screen_recording_permission()?;

    // xcap is synchronous and reads a whole framebuffer, so it goes on the
    // blocking pool rather than stalling the async runtime.
    tokio::task::spawn_blocking(move || match target {
        CaptureTarget::Screen => capture_screen_image(),
        CaptureTarget::Window => capture_focused_window(),
    })
    .await
    .map_err(|e| format!("the capture task failed: {e}"))?
}

fn capture_screen_image() -> Result<Capture, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("could not list the displays: {e}"))?;

    // The primary display, or the first one the OS reports. Capturing every
    // monitor and stitching them together would send a model two screens of
    // pixels to answer a question about one of them.
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or("no display was found to capture")?;

    let image = monitor
        .capture_image()
        .map_err(|e| format!("the display could not be captured: {e}"))?;
    Ok(from_rgba(image))
}

fn capture_focused_window() -> Result<Capture, String> {
    let windows = xcap::Window::all().map_err(|e| format!("could not list the windows: {e}"))?;

    // A minimized window has nothing to capture, so it is skipped even if the
    // OS still calls it focused.
    let focused = windows
        .iter()
        .find(|w| w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false));

    match focused {
        Some(window) => {
            let image = window
                .capture_image()
                .map_err(|e| format!("the window could not be captured: {e}"))?;
            Ok(from_rgba(image))
        }
        // Falling back to the whole screen rather than failing: the user asked
        // to be seen, and a screen containing the window they meant is a
        // better answer than an error about window enumeration.
        None => capture_screen_image(),
    }
}

fn from_rgba(image: image::RgbaImage) -> Capture {
    Capture {
        source_width: image.width(),
        source_height: image.height(),
        image: image::DynamicImage::ImageRgba8(image),
    }
}

/// macOS hands back a picture of the desktop with no windows in it when the
/// Screen Recording grant is missing, rather than failing. Catch that here so
/// the user is told where to grant it.
#[cfg(target_os = "macos")]
fn require_screen_recording_permission() -> Result<(), String> {
    if objc2_core_graphics::CGPreflightScreenCaptureAccess() {
        return Ok(());
    }
    Err(
        "Haruspex does not have permission to record the screen, so macOS would \
         hand back a picture of the desktop with every window missing. Grant it in \
         System Settings → Privacy & Security → Screen Recording, then quit and \
         reopen Haruspex."
            .into(),
    )
}

#[cfg(not(target_os = "macos"))]
fn require_screen_recording_permission() -> Result<(), String> {
    Ok(())
}
