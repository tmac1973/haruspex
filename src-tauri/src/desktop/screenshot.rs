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
}

/// Capture the screen or the focused window.
///
/// Called from exactly two places, both of them something the user just did:
/// the composer's capture button, and the `capture_screen` tool in reply to a
/// question they asked. Nothing calls it on a schedule.
#[tauri::command]
pub async fn capture_screen(target: Option<CaptureTarget>) -> Result<ScreenCapture, String> {
    let target = target.unwrap_or_default();
    let capture = grab(target).await?;
    let (width, height) = (capture.source_width, capture.source_height);
    let long_edge = target_long_edge(width, height);

    // Downscaling a 4K frame is tens of milliseconds of CPU; off the async
    // runtime so it cannot stall the UI thread's other work.
    let data_url = tokio::task::spawn_blocking(move || {
        crate::fs_tools::images::encode_jpeg_data_url(capture.image, long_edge)
    })
    .await
    .map_err(|e| format!("screenshot encoding failed: {e}"))??;

    Ok(ScreenCapture {
        data_url,
        width,
        height,
    })
}

#[cfg(target_os = "linux")]
async fn grab(target: CaptureTarget) -> Result<Capture, String> {
    super::linux::capture(target).await
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn grab(target: CaptureTarget) -> Result<Capture, String> {
    super::external::capture(target).await
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
async fn grab(_target: CaptureTarget) -> Result<Capture, String> {
    Err("Screen capture is not supported on this platform.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
