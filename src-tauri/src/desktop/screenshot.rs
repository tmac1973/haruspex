//! The capture command itself: pick a target, ask the platform for pixels,
//! downscale, and hand back a `data:` URL.

use serde::{Deserialize, Serialize};

/// How many pixels a screenshot may spend, before it is sent to the model.
///
/// A vision projector tiles its input at a few hundred pixels per tile, so the
/// cost of an image is its *area*, and sending a 4K display at native
/// resolution buys several times the image tokens for detail that never
/// reaches the model. This is the area of a 1536x864 frame: 1536 is the cap
/// `fs_read_image` uses, and at that size 12 px UI text survives a quality-92
/// JPEG — which is what actually decides whether the model can read a dialog
/// box or only describe its shape.
///
/// A budget rather than a long-edge cap because a desktop is often not one
/// screen. Capping the long edge of a real two-monitor span, 7520x2160,
/// leaves 1536x441 — the same pixel count spread so thin that nothing on it
/// can be read. Holding the area instead gives 2151x618 for no extra tokens.
const SCREENSHOT_PIXEL_BUDGET: f64 = 1536.0 * 864.0;

/// Hard ceiling on the long edge regardless of the budget above.
///
/// Without it an extreme aspect ratio — four monitors in a row — would trade
/// away all its height to stay inside the budget. At this width a two-monitor
/// span still keeps ~600 px of height, and beyond it the shape is past being
/// worth reading anyway.
const MAX_SCREENSHOT_DIMENSION: u32 = 2560;

/// The longest edge a capture of this size should be scaled to.
///
/// Returns the image's own long edge when it already fits, so a small display
/// is not resampled at all — Lanczos on an already-small frame only softens
/// the text the model is trying to read.
fn target_long_edge(width: u32, height: u32) -> u32 {
    let long = width.max(height);
    let area = f64::from(width) * f64::from(height);
    if area <= SCREENSHOT_PIXEL_BUDGET {
        return long;
    }
    let scale = (SCREENSHOT_PIXEL_BUDGET / area).sqrt();
    let scaled = (f64::from(long) * scale).round() as u32;
    scaled.clamp(1, MAX_SCREENSHOT_DIMENSION)
}

/// What to capture.
///
/// Two values, and no more. There is deliberately no interval, no "capture
/// until", and no region-by-coordinates: each of those turns a thing the user
/// asked for once into a thing that keeps happening.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum CaptureTarget {
    /// Everything on the display.
    #[default]
    Screen,
    /// The window that was focused when the user asked.
    Window,
}

/// Pixels from the platform, before any resizing.
pub struct Capture {
    pub image: image::DynamicImage,
    /// The size as captured, which is what the user sees on their display —
    /// reported to the model so it knows the image it is looking at was
    /// downscaled from something larger.
    pub source_width: u32,
    pub source_height: u32,
}

/// A screenshot, ready for the chat.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCapture {
    /// A JPEG `data:` URL, the same shape `fs_read_image` returns, so the
    /// image travels the existing attachment path rather than a new one.
    pub data_url: String,
    /// The display's own dimensions, not the downscaled ones.
    pub width: u32,
    pub height: u32,
    /// What was captured: a window, or the whole screen when a window was
    /// asked for and the desktop would not hand one over. A region reports
    /// the screen it was cut from.
    pub target: CaptureTarget,
}

/// A window the user can pick to capture, where the platform has no picker of
/// its own.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CaptureWindow {
    pub id: u32,
    pub title: String,
    pub app: String,
}

/// Smaller than this on either side is a menubar strip, a status item or a
/// zero-size helper, not a window anyone means to capture.
const MIN_PICKABLE_SIDE: u32 = 50;

/// Apps whose windows are the desktop itself: the macOS menubar, Dock and
/// widgets, and the Windows shell's input and Start surfaces. xcap already
/// leaves out the Windows desktop (Program Manager) and nameless tool windows.
const SYSTEM_APPS: &[&str] = &[
    "Window Server",
    "Dock",
    "Control Center",
    "Notification Center",
    "SystemUIServer",
    "WindowManager",
    "Spotlight",
    "loginwindow",
    "TextInputMenuAgent",
    "TextInputHost",
    "ShellExperienceHost",
    "StartMenuExperienceHost",
    "SearchHost",
];

/// Whether a window belongs in the pick list. Lives here rather than in
/// `external` so the rule is tested on every platform.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
pub(super) fn worth_listing(title: &str, app: &str, width: u32, height: u32) -> bool {
    let (title, app) = (title.trim(), app.trim());
    // An untitled window with no app name is a tooltip, a shadow or an
    // overlay: nothing a person would pick.
    if title.is_empty() && app.is_empty() {
        return false;
    }
    if width < MIN_PICKABLE_SIDE || height < MIN_PICKABLE_SIDE {
        return false;
    }
    // On Windows the name is the file description, which for some system
    // processes is just the exe's file name.
    let app = app.strip_suffix(".exe").unwrap_or(app);
    !SYSTEM_APPS.iter().any(|s| s.eq_ignore_ascii_case(app))
}

/// The windows to offer in a pick list. Empty on Linux, where the user clicks
/// the window instead ([`capture_window_click`]).
#[tauri::command]
pub async fn list_capture_windows() -> Result<Vec<CaptureWindow>, String> {
    list_windows().await
}

/// Capture one window the user picked from [`list_capture_windows`].
///
/// Like [`capture_screen`], only ever called from a button the user pressed:
/// the composer's camera button, with the window they chose.
#[tauri::command]
pub async fn capture_window(id: u32) -> Result<ScreenCapture, String> {
    let capture = grab_window(id).await?;
    encode(capture, CaptureTarget::Window).await
}

/// How a click-a-window capture ended.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WindowClick {
    Captured {
        capture: ScreenCapture,
    },
    /// The user pressed Escape instead of clicking.
    Cancelled,
    /// No click picking on this desktop; the composer offers Region instead.
    Unavailable,
}

/// Let the user click the window to capture: KDE Plasma's crosshair, from
/// the composer's Window… choice on Linux.
#[tauri::command]
pub async fn capture_window_click() -> Result<WindowClick, String> {
    click_window().await
}

#[cfg(target_os = "linux")]
async fn click_window() -> Result<WindowClick, String> {
    use super::kwin::{click_window, KwinError};
    match click_window().await {
        Ok(capture) => Ok(WindowClick::Captured {
            capture: encode(capture, CaptureTarget::Window).await?,
        }),
        Err(KwinError::Cancelled) => Ok(WindowClick::Cancelled),
        Err(KwinError::Unavailable(why)) => {
            log::debug!("click-a-window capture unavailable: {why}");
            Ok(WindowClick::Unavailable)
        }
        Err(KwinError::Failed(why)) => Err(format!("The screenshot failed: {why}")),
    }
}

#[cfg(not(target_os = "linux"))]
async fn click_window() -> Result<WindowClick, String> {
    Ok(WindowClick::Unavailable)
}

/// A rectangle of a held capture, in the capture's own pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// The full-resolution frame between [`capture_region_start`] and
/// [`capture_region_finish`].
///
/// Held here rather than sent to the page because the preview the user drags
/// over is downscaled: cropping that would hand the model a blurred enlargement
/// of a small region, where cropping the original keeps every pixel of it.
/// Only ever one, and finishing takes it, so a picture of the screen does not
/// outlive the selection it was taken for.
static HELD_REGION: std::sync::Mutex<Option<image::DynamicImage>> = std::sync::Mutex::new(None);

/// Capture the screen for the user to select a region of.
///
/// Called only from the composer's "Region" choice. Returns a preview to
/// draw over; the frame itself waits for [`capture_region_finish`].
#[tauri::command]
pub async fn capture_region_start() -> Result<ScreenCapture, String> {
    use crate::sync_util::LockExt;
    let (capture, took) = grab(CaptureTarget::Screen).await?;
    *HELD_REGION.lock_or_recover() = Some(capture.image.clone());
    encode(capture, took).await
}

/// Crop the held frame to `rect` and encode it, or with `None` discard it.
///
/// Returns `None` when there was nothing to crop or the user cancelled.
#[tauri::command]
pub async fn capture_region_finish(
    rect: Option<CaptureRect>,
) -> Result<Option<ScreenCapture>, String> {
    use crate::sync_util::LockExt;
    let held = HELD_REGION.lock_or_recover().take();
    let (Some(image), Some(rect)) = (held, rect) else {
        return Ok(None);
    };
    let image = crop(&image, rect).ok_or("The selected region is empty.")?;
    let capture = Capture {
        source_width: image.width(),
        source_height: image.height(),
        image,
    };
    encode(capture, CaptureTarget::Screen).await.map(Some)
}

/// `rect` cut out of `image`, clamped to its edges; `None` when nothing is left.
fn crop(image: &image::DynamicImage, rect: CaptureRect) -> Option<image::DynamicImage> {
    let x = rect.x.min(image.width());
    let y = rect.y.min(image.height());
    let width = rect.width.min(image.width() - x);
    let height = rect.height.min(image.height() - y);
    if width == 0 || height == 0 {
        return None;
    }
    Some(image.crop_imm(x, y, width, height))
}

async fn encode(capture: Capture, target: CaptureTarget) -> Result<ScreenCapture, String> {
    let (width, height) = (capture.source_width, capture.source_height);
    let long_edge = target_long_edge(width, height);
    let data_url = tokio::task::spawn_blocking(move || {
        crate::fs_tools::images::encode_jpeg_data_url(capture.image, long_edge)
    })
    .await
    .map_err(|e| format!("screenshot encoding failed: {e}"))??;
    Ok(ScreenCapture {
        data_url,
        width,
        height,
        target,
    })
}

#[cfg(target_os = "linux")]
async fn list_windows() -> Result<Vec<CaptureWindow>, String> {
    Ok(Vec::new())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn list_windows() -> Result<Vec<CaptureWindow>, String> {
    super::external::list_windows().await
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
async fn list_windows() -> Result<Vec<CaptureWindow>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "linux")]
async fn grab_window(_id: u32) -> Result<Capture, String> {
    // Linux lists no windows, so there is never an id to capture by.
    Err("Pick the window with Window… instead.".into())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn grab_window(id: u32) -> Result<Capture, String> {
    super::external::capture_window(id).await
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
async fn grab_window(_id: u32) -> Result<Capture, String> {
    Err("Screen capture is not supported on this platform.".into())
}

/// Capture the screen or the focused window.
///
/// Called from exactly two places, both of them something the user just did:
/// the composer's capture button, and the `capture_screen` tool in reply to a
/// question they asked, after Haruspex's own prompt unless they turned it off
/// (Settings → Screen). Nothing calls it on a schedule.
#[tauri::command]
pub async fn capture_screen(target: Option<CaptureTarget>) -> Result<ScreenCapture, String> {
    let (capture, took) = grab(target.unwrap_or_default()).await?;
    // Downscaling a 4K frame is tens of milliseconds of CPU; `encode` does it
    // off the async runtime so it cannot stall the UI thread's other work.
    encode(capture, took).await
}

/// The pixels, and what they are of: see [`super::linux::capture`].
#[cfg(target_os = "linux")]
async fn grab(target: CaptureTarget) -> Result<(Capture, CaptureTarget), String> {
    super::linux::capture(target).await
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn grab(target: CaptureTarget) -> Result<(Capture, CaptureTarget), String> {
    super::external::capture(target)
        .await
        .map(|capture| (capture, target))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
async fn grab(_target: CaptureTarget) -> Result<(Capture, CaptureTarget), String> {
    Err("Screen capture is not supported on this platform.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordinary_window_is_listed() {
        assert!(worth_listing("My Game (DEBUG)", "Godot", 1280, 720));
        assert!(worth_listing("", "Safari", 800, 600));
    }

    #[test]
    fn tiny_and_zero_size_windows_are_not_listed() {
        assert!(!worth_listing("Item-0", "1Password", 30, 24));
        assert!(!worth_listing("Menubar", "Some App", 1920, 24));
        assert!(!worth_listing("Helper", "Some App", 0, 0));
    }

    #[test]
    fn nameless_windows_are_not_listed() {
        assert!(!worth_listing("  ", "", 800, 600));
    }

    #[test]
    fn the_desktop_s_own_windows_are_not_listed() {
        for app in [
            "Window Server",
            "Dock",
            "Notification Center",
            "control center",
        ] {
            assert!(!worth_listing("", app, 1920, 1080), "{app}");
        }
        assert!(!worth_listing("", "TextInputHost.exe", 400, 300));
    }

    #[test]
    fn file_explorer_windows_are_listed() {
        assert!(worth_listing("Downloads", "Windows Explorer", 900, 600));
    }

    #[test]
    fn a_4k_capture_is_scaled_down_and_keeps_its_shape() {
        let decoded = capture_at(3840, 2160);
        assert_eq!(decoded.width(), 1536);
        // 3840x2160 is 16:9, so 1536 wide is 864 tall. Off-by-one from the
        // float scale is fine; a squashed aspect ratio is not.
        assert!(
            (decoded.height() as i64 - 864).abs() <= 1,
            "got {}",
            decoded.height()
        );
    }

    #[test]
    fn two_monitors_side_by_side_keep_a_readable_height() {
        // A real dual-monitor desktop. Capping the long edge at 1536 would
        // leave this 441 px tall, which is the same pixel count spread so
        // thin that nothing on it can be read.
        let decoded = capture_at(7520, 2160);
        assert!(decoded.height() >= 600, "got {}", decoded.height());
        assert!(decoded.width() <= MAX_SCREENSHOT_DIMENSION);
    }

    #[test]
    fn a_wide_capture_costs_no_more_than_a_normal_one() {
        // The whole point of a budget: the ultrawide above must not buy its
        // extra height with extra image tokens.
        let normal = capture_at(3840, 2160);
        let wide = capture_at(7520, 2160);
        let area = |i: &image::DynamicImage| i.width() as u64 * i.height() as u64;
        assert!(
            area(&wide) <= area(&normal) * 6 / 5,
            "wide {} vs normal {}",
            area(&wide),
            area(&normal)
        );
    }

    #[test]
    fn four_monitors_in_a_row_stop_at_the_hard_ceiling() {
        // Otherwise the budget would trade away every last row of height to
        // keep an absurd aspect ratio intact.
        let decoded = capture_at(15360, 2160);
        assert_eq!(decoded.width(), MAX_SCREENSHOT_DIMENSION);
    }

    #[test]
    fn a_capture_smaller_than_the_budget_is_left_alone() {
        // A 1280x800 laptop screen loses nothing, so it should not be
        // resampled at all — Lanczos on an already-small frame only softens
        // the text the model is trying to read.
        let decoded = capture_at(1280, 800);
        assert_eq!((decoded.width(), decoded.height()), (1280, 800));
    }

    #[test]
    fn a_very_thin_strip_does_not_scale_its_short_side_to_nothing() {
        // A 4000x1 capture would otherwise round to a height of 0, which
        // panics inside `resize`.
        assert_eq!(capture_at(4000, 1).height(), 1);
    }

    #[test]
    fn the_result_is_a_jpeg_data_url_the_chat_can_render_as_is() {
        let img = image::DynamicImage::new_rgb8(64, 64);
        let url = crate::fs_tools::images::encode_jpeg_data_url(img, 64).unwrap();
        assert!(
            url.starts_with("data:image/jpeg;base64,"),
            "got {}",
            &url[..40]
        );
    }

    #[test]
    fn the_default_target_is_the_whole_screen() {
        // A model that omits the argument gets the answer to "what's on my
        // screen", not a guess about which window mattered.
        assert_eq!(CaptureTarget::default(), CaptureTarget::Screen);
    }

    #[test]
    fn the_target_serializes_as_the_frontend_spells_it() {
        assert_eq!(
            serde_json::to_string(&CaptureTarget::Window).unwrap(),
            "\"window\""
        );
    }

    #[test]
    fn a_region_is_cut_at_full_resolution() {
        let img = image::DynamicImage::new_rgb8(3840, 2160);
        let rect = CaptureRect {
            x: 100,
            y: 200,
            width: 640,
            height: 360,
        };
        let cut = crop(&img, rect).expect("a region");
        assert_eq!((cut.width(), cut.height()), (640, 360));
    }

    #[test]
    fn a_region_past_the_edge_is_clamped_to_it() {
        let img = image::DynamicImage::new_rgb8(100, 100);
        let rect = CaptureRect {
            x: 80,
            y: 90,
            width: 50,
            height: 50,
        };
        let cut = crop(&img, rect).expect("a region");
        assert_eq!((cut.width(), cut.height()), (20, 10));
    }

    #[test]
    fn an_empty_or_outside_region_is_refused() {
        let img = image::DynamicImage::new_rgb8(100, 100);
        let empty = CaptureRect {
            x: 10,
            y: 10,
            width: 0,
            height: 5,
        };
        let outside = CaptureRect {
            x: 200,
            y: 0,
            width: 10,
            height: 10,
        };
        assert!(crop(&img, empty).is_none());
        assert!(crop(&img, outside).is_none());
    }

    /// Run a display of this size through the whole downscale-and-encode path.
    fn capture_at(width: u32, height: u32) -> image::DynamicImage {
        let img = image::DynamicImage::new_rgb8(width, height);
        let long_edge = target_long_edge(width, height);
        decode(&crate::fs_tools::images::encode_jpeg_data_url(img, long_edge).expect("encodes"))
    }

    fn decode(data_url: &str) -> image::DynamicImage {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        let raw = data_url
            .strip_prefix("data:image/jpeg;base64,")
            .expect("a jpeg data url");
        image::load_from_memory(&B64.decode(raw).expect("valid base64")).expect("valid jpeg")
    }
}
