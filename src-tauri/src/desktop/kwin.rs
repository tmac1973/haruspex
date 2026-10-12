//! KDE Plasma: click the window to capture.
//!
//! The Screenshot portal on Plasma has no window picker of its own. Its
//! interactive mode opens Spectacle's dialog, where catching a window means
//! setting a delay, switching to it, and pressing Save. KWin's own
//! `org.kde.KWin.ScreenShot2.CaptureInteractive` is what Spectacle uses
//! underneath: the cursor becomes a crosshair, the user clicks a window, and
//! its pixels come back over a pipe. Escape cancels.
//!
//! KWin keeps this interface to the apps whose `.desktop` file lists it under
//! `X-KDE-DBUS-Restricted-Interfaces`, matched by the caller's executable. The
//! deb and rpm ship that line; an AppImage, a dev build without
//! `scripts/kwin-dev-desktop-entry.sh`, or a desktop that is not Plasma get
//! [`KwinError::Unavailable`], and the composer falls back to Region.

use ashpd::zbus;
use ashpd::zvariant::{Fd, OwnedValue, Value};
use std::collections::HashMap;
use std::io::Read;

use super::screenshot::Capture;

/// `CaptureInteractive`'s kind for "a window" (1 is a whole screen).
const KIND_WINDOW: u32 = 0;

/// Why a click capture did not produce an image.
pub enum KwinError {
    /// Not Plasma, or KWin does not trust this executable.
    Unavailable(String),
    /// The user pressed Escape.
    Cancelled,
    /// KWin was there and tried, but could not.
    Failed(String),
}

/// Let the user click a window and return its pixels.
pub async fn click_window() -> Result<Capture, KwinError> {
    let conn = zbus::Connection::session()
        .await
        .map_err(|e| KwinError::Unavailable(e.to_string()))?;
    let proxy = zbus::Proxy::new(
        &conn,
        "org.kde.KWin",
        "/org/kde/KWin/ScreenShot2",
        "org.kde.KWin.ScreenShot2",
    )
    .await
    .map_err(|e| KwinError::Unavailable(e.to_string()))?;

    let (mut reader, writer) =
        std::io::pipe().map_err(|e| KwinError::Failed(format!("no pipe: {e}")))?;
    // Read while KWin writes: a window is more than a pipe buffer holds, so
    // waiting for the reply first would leave KWin blocked on a full pipe.
    // EOF comes once both KWin's copy of the write end and ours are closed.
    let pixels = tokio::task::spawn_blocking(move || {
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).map(|_| buf)
    });

    let options: HashMap<&str, Value> = HashMap::from([
        ("include-decoration", Value::from(true)),
        ("include-shadow", Value::from(false)),
        ("include-cursor", Value::from(false)),
        ("native-resolution", Value::from(true)),
    ]);
    let reply: zbus::Result<HashMap<String, OwnedValue>> = proxy
        .call(
            "CaptureInteractive",
            &(KIND_WINDOW, options, Fd::from(&writer)),
        )
        .await;
    drop(writer);

    let bytes = pixels
        .await
        .map_err(|e| KwinError::Failed(e.to_string()))?
        .map_err(|e| KwinError::Failed(format!("could not read the window: {e}")))?;
    let meta = reply.map_err(classify)?;
    let image = raw_to_image(&bytes, &RawMeta::from_reply(&meta)?).map_err(KwinError::Failed)?;
    Ok(Capture {
        source_width: image.width(),
        source_height: image.height(),
        image,
    })
}

fn classify(err: zbus::Error) -> KwinError {
    let name = match &err {
        zbus::Error::MethodError(name, _, _) => name.as_str(),
        zbus::Error::InterfaceNotFound => "org.freedesktop.DBus.Error.UnknownInterface",
        _ => "",
    };
    match error_kind(name) {
        Some(ErrorKind::Cancelled) => KwinError::Cancelled,
        Some(ErrorKind::Unavailable) => KwinError::Unavailable(err.to_string()),
        None => KwinError::Failed(err.to_string()),
    }
}

#[derive(Debug, PartialEq)]
enum ErrorKind {
    Cancelled,
    Unavailable,
}

/// What a D-Bus error name from the call means for the composer.
fn error_kind(name: &str) -> Option<ErrorKind> {
    match name {
        "org.kde.KWin.ScreenShot2.Error.Cancelled" => Some(ErrorKind::Cancelled),
        "org.kde.KWin.ScreenShot2.Error.NoAuthorized"
        | "org.freedesktop.DBus.Error.ServiceUnknown"
        | "org.freedesktop.DBus.Error.UnknownObject"
        | "org.freedesktop.DBus.Error.UnknownInterface"
        | "org.freedesktop.DBus.Error.UnknownMethod" => Some(ErrorKind::Unavailable),
        _ => None,
    }
}

/// The reply's description of the bytes in the pipe.
struct RawMeta {
    width: u32,
    height: u32,
    stride: u32,
    /// A `QImage::Format`.
    format: u32,
}

impl RawMeta {
    fn from_reply(reply: &HashMap<String, OwnedValue>) -> Result<Self, KwinError> {
        let kind = reply
            .get("type")
            .and_then(|v| String::try_from(v.clone()).ok());
        if kind.as_deref() != Some("raw") {
            return Err(KwinError::Failed(format!(
                "KWin sent a {} image, which this cannot read",
                kind.as_deref().unwrap_or("untyped")
            )));
        }
        let field = |key: &str| {
            reply
                .get(key)
                .and_then(|v| u32::try_from(v).ok())
                .ok_or_else(|| KwinError::Failed(format!("KWin's reply has no {key}")))
        };
        Ok(Self {
            width: field("width")?,
            height: field("height")?,
            stride: field("stride")?,
            format: field("format")?,
        })
    }
}

/// KWin's raw pixels as an image, row padding and alpha dropped.
fn raw_to_image(bytes: &[u8], meta: &RawMeta) -> Result<image::DynamicImage, String> {
    // QImage formats with four bytes a pixel. 4-6 are 0xAARRGGBB words, so
    // B, G, R in memory on a little-endian machine; 17-19 are R, G, B, A bytes.
    let (r, g, b) = match meta.format {
        4..=6 if cfg!(target_endian = "little") => (2, 1, 0),
        4..=6 => (1, 2, 3),
        17..=19 => (0, 1, 2),
        other => {
            return Err(format!(
                "KWin sent pixel format {other}, which this cannot read"
            ))
        }
    };
    let (width, height, stride) = (
        meta.width as usize,
        meta.height as usize,
        meta.stride as usize,
    );
    if width == 0
        || height == 0
        || stride < width * 4
        || bytes.len() < stride * (height - 1) + width * 4
    {
        return Err(format!(
            "KWin sent {} bytes for a {}x{} window",
            bytes.len(),
            meta.width,
            meta.height
        ));
    }
    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in bytes.chunks(stride).take(height) {
        for px in row[..width * 4].as_chunks::<4>().0 {
            rgb.extend_from_slice(&[px[r], px[g], px[b]]);
        }
    }
    image::RgbImage::from_raw(meta.width, meta.height, rgb)
        .map(image::DynamicImage::ImageRgb8)
        .ok_or_else(|| "the window's pixels did not fit its size".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(width: u32, height: u32, stride: u32, format: u32) -> RawMeta {
        RawMeta {
            width,
            height,
            stride,
            format,
        }
    }

    #[test]
    fn argb32_is_read_as_bgra_bytes_and_row_padding_is_skipped() {
        // Two rows of one pixel, each padded to 8 bytes.
        let bytes = [
            0x30, 0x20, 0x10, 0xff, 0xee, 0xee, 0xee, 0xee, //
            0x03, 0x02, 0x01, 0xff, 0xee, 0xee, 0xee, 0xee,
        ];
        let image = raw_to_image(&bytes, &meta(1, 2, 8, 6)).unwrap().to_rgb8();
        assert_eq!(image.get_pixel(0, 0).0, [0x10, 0x20, 0x30]);
        assert_eq!(image.get_pixel(0, 1).0, [0x01, 0x02, 0x03]);
    }

    #[test]
    fn rgba8888_keeps_its_byte_order() {
        let image = raw_to_image(&[1, 2, 3, 255], &meta(1, 1, 4, 18))
            .unwrap()
            .to_rgb8();
        assert_eq!(image.get_pixel(0, 0).0, [1, 2, 3]);
    }

    #[test]
    fn the_last_row_needs_no_padding_after_it() {
        let bytes = [0u8; 8 + 4];
        assert!(raw_to_image(&bytes, &meta(1, 2, 8, 5)).is_ok());
    }

    #[test]
    fn a_short_pipe_is_an_error_rather_than_a_torn_image() {
        let err = raw_to_image(&[0; 7], &meta(1, 2, 4, 6)).unwrap_err();
        assert!(err.contains("1x2"), "got {err}");
    }

    #[test]
    fn an_unreadable_pixel_format_is_named() {
        let err = raw_to_image(&[0; 4], &meta(1, 1, 4, 3)).unwrap_err();
        assert!(err.contains("format 3"), "got {err}");
    }

    #[test]
    fn an_untrusted_app_or_another_desktop_falls_back_and_escape_cancels() {
        assert_eq!(
            error_kind("org.kde.KWin.ScreenShot2.Error.NoAuthorized"),
            Some(ErrorKind::Unavailable)
        );
        assert_eq!(
            error_kind("org.freedesktop.DBus.Error.ServiceUnknown"),
            Some(ErrorKind::Unavailable)
        );
        assert_eq!(
            error_kind("org.kde.KWin.ScreenShot2.Error.Cancelled"),
            Some(ErrorKind::Cancelled)
        );
        assert_eq!(
            error_kind("org.kde.KWin.ScreenShot2.Error.InvalidWindow"),
            None
        );
    }

    /// A real click capture. Needs Plasma, a trusted executable, and a person
    /// to click a window:
    /// `cargo test --manifest-path src-tauri/Cargo.toml kwin_click -- --ignored --nocapture`
    #[test]
    #[ignore = "waits for a person to click a window on KDE Plasma"]
    fn a_real_kwin_click_produces_a_plausible_image() {
        let capture = tokio::runtime::Runtime::new()
            .expect("a runtime")
            .block_on(click_window())
            .map_err(|e| match e {
                KwinError::Unavailable(w) => format!("unavailable: {w}"),
                KwinError::Cancelled => "cancelled".into(),
                KwinError::Failed(w) => format!("failed: {w}"),
            })
            .expect("KWin captures");
        eprintln!(
            "captured {}x{}",
            capture.source_width, capture.source_height
        );
    }
}
