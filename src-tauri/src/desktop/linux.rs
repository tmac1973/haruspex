//! Linux capture: the desktop portal, then X11.
//!
//! The portal is tried first on every session type, Wayland and X11 alike.
//! That ordering is deliberate. Under Wayland there is no other way — a client
//! cannot read the screen, and that is the point of the design. Under X11 any
//! client can read the root window at any time, so going through the portal
//! anyway means the same visible, compositor-drawn confirmation appears on both,
//! and the user does not have to know which session they are in to know what
//! just happened.
//!
//! The X11 path exists for a session with no portal running at all — a bare
//! window manager, no desktop environment. It reads the root window directly,
//! which is the only thing available there.

use std::path::{Path, PathBuf};

use super::screenshot::{Capture, CaptureTarget};

pub async fn capture(target: CaptureTarget) -> Result<Capture, String> {
    match capture_via_portal(target).await {
        Ok(capture) => Ok(capture),
        Err(PortalError::Refused) => Err(
            "The screenshot was cancelled. Nothing was captured — try again and \
             confirm the request your desktop shows."
                .into(),
        ),
        Err(PortalError::Unavailable(why)) => capture_via_x11(target).map_err(|x11| {
            format!(
                "Could not take a screenshot. The desktop portal is not available \
                 ({why}), and reading the screen directly failed too ({x11}). On \
                 Wayland, install xdg-desktop-portal and the backend for your \
                 desktop."
            )
        }),
        Err(PortalError::Failed(why)) => Err(format!("The screenshot failed: {why}")),
    }
}

/// Why a portal capture did not produce an image.
///
/// The distinction matters: a user who cancelled the picker should be told
/// nothing was captured, not have the request quietly retried behind their back
/// through a path that does not ask.
enum PortalError {
    /// No portal is running, or it does not implement Screenshot.
    Unavailable(String),
    /// The user dismissed the portal's own dialog.
    Refused,
    /// The portal was there and tried, but could not.
    Failed(String),
}

async fn capture_via_portal(target: CaptureTarget) -> Result<Capture, PortalError> {
    use ashpd::desktop::screenshot::{AvailableTargets, Screenshot};

    let mut request = Screenshot::request()
        // The portal's own picker is what makes the capture unmistakably
        // user-initiated, and on a multi-monitor desktop it is also the only
        // chance to say *which* screen. Both reasons to leave it on.
        .interactive(true)
        .modal(true);
    if target == CaptureTarget::Window {
        // A hint only: portals below version 3 ignore it, and in interactive
        // mode the user's choice in the picker wins regardless.
        request = request.target(AvailableTargets::Window);
    }

    let response = request
        .send()
        .await
        .map_err(classify)?
        .response()
        .map_err(classify)?;

    let path = file_uri_to_path(response.uri().as_str())
        .ok_or_else(|| PortalError::Failed(format!("unreadable URI {}", response.uri())))?;

    let capture = read_capture(&path).map_err(PortalError::Failed);
    // The portal spec makes the caller the owner of this file. Leaving a
    // picture of somebody's whole desktop in a shared temp directory is a
    // worse outcome than any error deleting it, so this is best-effort and
    // happens whether the read above succeeded or not.
    discard(&path);
    capture
}

/// Map an ashpd error onto what the user should be told.
fn classify(err: ashpd::Error) -> PortalError {
    match err {
        ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => PortalError::Refused,
        // A missing service, a missing interface, or a refused name: nothing is
        // listening, so the X11 fallback is worth trying.
        ashpd::Error::Zbus(e) => PortalError::Unavailable(e.to_string()),
        ashpd::Error::PortalNotFound(name) => {
            PortalError::Unavailable(format!("no portal implements {name}"))
        }
        other => PortalError::Failed(other.to_string()),
    }
}

fn read_capture(path: &Path) -> Result<Capture, String> {
    let image = image::open(path).map_err(|e| format!("could not read the screenshot: {e}"))?;
    Ok(Capture {
        source_width: image.width(),
        source_height: image.height(),
        image,
    })
}

/// Delete a portal screenshot once it has been read, if it is ours to delete.
///
/// Portals write to a temporary location and hand ownership to the caller. But
/// a portal that instead returned a path the *user* chose — their Pictures
/// directory, say — must not have that file removed, so anything outside a
/// temporary directory is left exactly where it is.
fn discard(path: &Path) {
    if is_disposable(path, &temp_roots()) {
        let _ = std::fs::remove_file(path);
    }
}

/// Directories a portal's own scratch file may live in.
fn temp_roots() -> Vec<PathBuf> {
    let mut roots = vec![std::env::temp_dir()];
    if let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR") {
        roots.push(PathBuf::from(runtime));
    }
    if let Ok(cache) = std::env::var("XDG_CACHE_HOME") {
        roots.push(PathBuf::from(cache));
    } else if let Ok(home) = std::env::var("HOME") {
        roots.push(PathBuf::from(home).join(".cache"));
    }
    roots
}

fn is_disposable(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

/// Turn a `file://` URI into a path, undoing percent-encoding.
///
/// Written out rather than pulled from a URL crate because the input is one
/// fixed shape from one caller, and a path with a space or a non-ASCII
/// character in it is the whole of the problem.
fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let encoded = uri.strip_prefix("file://")?;
    // file:///path — the authority is empty for local files. A non-empty one
    // (file://host/path) names another machine, which we cannot read.
    let encoded = match encoded.find('/') {
        Some(0) => encoded,
        _ => return None,
    };

    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            // A stray '%' that is not an escape stays a literal '%'.
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }

    Some(PathBuf::from(String::from_utf8(out).ok()?))
}

/// Read the root window directly. Only reached when no portal answered.
fn capture_via_x11(target: CaptureTarget) -> Result<Capture, String> {
    use xcb::x;

    let (conn, screen_num) =
        xcb::Connection::connect(None).map_err(|e| format!("no X11 display: {e}"))?;
    let setup = conn.get_setup();
    let screen = setup
        .roots()
        .nth(screen_num as usize)
        .ok_or("the X server reported no screen")?;
    let root = screen.root();

    let (x, y, width, height) = match target {
        CaptureTarget::Screen => (0, 0, screen.width_in_pixels(), screen.height_in_pixels()),
        CaptureTarget::Window => active_window_area(&conn, root).unwrap_or((
            0,
            0,
            screen.width_in_pixels(),
            screen.height_in_pixels(),
        )),
    };

    // Read from the root rather than the window itself: a window that is
    // partly off-screen or unmapped has no usable backing store, and every
    // screenshot tool on X11 reads the root for the same reason.
    let cookie = conn.send_request(&x::GetImage {
        format: x::ImageFormat::ZPixmap,
        drawable: x::Drawable::Window(root),
        x,
        y,
        width,
        height,
        plane_mask: u32::MAX,
    });
    let reply = conn.wait_for_reply(cookie).map_err(|e| {
        // BadMatch on the root window is what XWayland returns: its root is
        // not viewable, because under Wayland no client may read the screen.
        // That is precisely the case the portal exists for, so say so.
        format!(
            "the X server would not hand over the screen ({e}). Under Wayland \
             this is expected — install xdg-desktop-portal and the backend for \
             your desktop."
        )
    })?;

    let bits_per_pixel = setup
        .pixmap_formats()
        .iter()
        .find(|f| f.depth() == reply.depth())
        .map(|f| f.bits_per_pixel())
        .ok_or_else(|| {
            format!(
                "the X server described no format for depth {}",
                reply.depth()
            )
        })?;
    let swap = setup.image_byte_order() == x::ImageOrder::MsbFirst;
    let rgb = to_rgb(
        reply.data(),
        width as u32,
        height as u32,
        bits_per_pixel,
        swap,
    )?;
    let buffer = image::RgbImage::from_raw(width as u32, height as u32, rgb)
        .ok_or("the X server returned fewer pixels than it promised")?;

    Ok(Capture {
        source_width: width as u32,
        source_height: height as u32,
        image: image::DynamicImage::ImageRgb8(buffer),
    })
}

/// Where the focused window is, from `_NET_ACTIVE_WINDOW`.
fn active_window_area(
    conn: &xcb::Connection,
    root: xcb::x::Window,
) -> Option<(i16, i16, u16, u16)> {
    use xcb::x;

    let atom = conn
        .wait_for_reply(conn.send_request(&x::InternAtom {
            only_if_exists: true,
            name: b"_NET_ACTIVE_WINDOW",
        }))
        .ok()?
        .atom();

    let active = conn
        .wait_for_reply(conn.send_request(&x::GetProperty {
            delete: false,
            window: root,
            property: atom,
            r#type: x::ATOM_WINDOW,
            long_offset: 0,
            long_length: 1,
        }))
        .ok()?;
    let window: x::Window = *active.value::<x::Window>().first()?;

    let geometry = conn
        .wait_for_reply(conn.send_request(&x::GetGeometry {
            drawable: x::Drawable::Window(window),
        }))
        .ok()?;

    // The geometry is relative to the window's parent, so it has to be
    // translated to root coordinates before it can index into a root capture.
    let translated = conn
        .wait_for_reply(conn.send_request(&x::TranslateCoordinates {
            src_window: window,
            dst_window: root,
            src_x: 0,
            src_y: 0,
        }))
        .ok()?;

    Some((
        translated.dst_x(),
        translated.dst_y(),
        geometry.width(),
        geometry.height(),
    ))
}

/// Repack ZPixmap rows as RGB.
///
/// A depth-24 image is almost always sent 32 bits to the pixel, and a
/// little-endian server writes that word as B, G, R, unused. Both the byte
/// order and the bits per pixel are read from the server's own description
/// rather than assumed: getting either wrong produces a picture that looks
/// plausible and is entirely the wrong colour, which a model will describe
/// rather than question.
fn to_rgb(
    data: &[u8],
    width: u32,
    height: u32,
    bits_per_pixel: u8,
    msb_first: bool,
) -> Result<Vec<u8>, String> {
    let stride = match bits_per_pixel {
        32 => 4,
        24 => 3,
        other => {
            return Err(format!(
                "the X server sent {other} bits per pixel, which this cannot read"
            ))
        }
    };
    let pixels = (width as usize) * (height as usize);
    if data.len() < pixels * stride {
        return Err(format!(
            "the X server returned {} bytes for a {}x{} region",
            data.len(),
            width,
            height
        ));
    }
    let mut out = Vec::with_capacity(pixels * 3);
    for chunk in data.chunks_exact(stride).take(pixels) {
        if msb_first {
            // Big-endian 32bpp puts the unused byte first; 24bpp has none.
            let start = stride - 3;
            out.extend_from_slice(&chunk[start..start + 3]);
        } else {
            out.extend_from_slice(&[chunk[2], chunk[1], chunk[0]]);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_file_uri_becomes_a_path() {
        assert_eq!(
            file_uri_to_path("file:///tmp/screenshot.png"),
            Some(PathBuf::from("/tmp/screenshot.png"))
        );
    }

    #[test]
    fn percent_escapes_are_undone() {
        // A portal writing into a path with a space in it is the common case
        // on a desktop where the user's directories are not ASCII.
        assert_eq!(
            file_uri_to_path("file:///home/tim/My%20Pictures/shot%20(1).png"),
            Some(PathBuf::from("/home/tim/My Pictures/shot (1).png"))
        );
        assert_eq!(
            file_uri_to_path("file:///tmp/caf%C3%A9.png"),
            Some(PathBuf::from("/tmp/café.png"))
        );
    }

    #[test]
    fn a_uri_naming_another_machine_is_refused() {
        // file://host/path is not something we can open.
        assert_eq!(file_uri_to_path("file://elsewhere/tmp/shot.png"), None);
        assert_eq!(file_uri_to_path("https://example.com/shot.png"), None);
    }

    #[test]
    fn a_stray_percent_is_taken_literally_rather_than_dropping_the_path() {
        assert_eq!(
            file_uri_to_path("file:///tmp/100%.png"),
            Some(PathBuf::from("/tmp/100%.png"))
        );
    }

    #[test]
    fn a_portal_scratch_file_is_deleted_but_a_users_own_file_is_not() {
        let roots = vec![PathBuf::from("/tmp"), PathBuf::from("/run/user/1000")];
        assert!(is_disposable(Path::new("/tmp/shot.png"), &roots));
        assert!(is_disposable(
            Path::new("/run/user/1000/doc/abc/shot.png"),
            &roots
        ));
        // The one that matters: never remove something out of Pictures.
        assert!(!is_disposable(
            Path::new("/home/tim/Pictures/shot.png"),
            &roots
        ));
    }

    #[test]
    fn x11_pixels_are_repacked_in_the_order_the_server_sent_them() {
        // One pixel, pure red, as a little-endian server writes it: B G R X.
        let little = [0x00, 0x00, 0xff, 0x00];
        assert_eq!(to_rgb(&little, 1, 1, 32, false).unwrap(), vec![0xff, 0, 0]);
        // The same word big-endian: X R G B.
        let big = [0x00, 0xff, 0x00, 0x00];
        assert_eq!(to_rgb(&big, 1, 1, 32, true).unwrap(), vec![0xff, 0, 0]);
    }

    #[test]
    fn a_packed_24_bit_image_is_read_too() {
        // Rarer than 32bpp, but a server is entitled to send it, and reading
        // it four bytes at a time would shear every row.
        assert_eq!(
            to_rgb(&[0x00, 0x00, 0xff], 1, 1, 24, false).unwrap(),
            vec![0xff, 0, 0]
        );
        assert_eq!(
            to_rgb(&[0xff, 0x00, 0x00], 1, 1, 24, true).unwrap(),
            vec![0xff, 0, 0]
        );
    }

    #[test]
    fn an_unreadable_pixel_format_is_named_rather_than_guessed_at() {
        let err = to_rgb(&[0; 16], 1, 1, 16, false).unwrap_err();
        assert!(err.contains("16 bits per pixel"), "got {err}");
    }

    /// A real X11 capture, for when the pixel handling above changes.
    ///
    /// Ignored because it needs a running X server (or XWayland) with
    /// something on it. Run with:
    /// `cargo test --manifest-path src-tauri/Cargo.toml x11_capture -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a live X display"]
    fn a_real_x11_capture_produces_a_plausible_image() {
        let capture = capture_via_x11(CaptureTarget::Screen).expect("captures the root window");
        assert!(capture.source_width >= 640, "{}", capture.source_width);
        assert!(capture.source_height >= 480, "{}", capture.source_height);
        eprintln!(
            "captured {}x{}",
            capture.source_width, capture.source_height
        );
    }

    /// A real portal capture. Needs a human to accept the picker, which is the
    /// whole point of the path, so it can only ever be run by hand:
    /// `cargo test --manifest-path src-tauri/Cargo.toml portal_capture -- --ignored --nocapture`
    #[test]
    #[ignore = "opens the desktop portal's picker and waits for a person"]
    fn a_real_portal_capture_produces_a_plausible_image() {
        let capture = tokio::runtime::Runtime::new()
            .expect("a runtime")
            .block_on(capture_via_portal(CaptureTarget::Screen))
            .map_err(|e| match e {
                PortalError::Refused => "cancelled".to_string(),
                PortalError::Unavailable(w) => format!("no portal: {w}"),
                PortalError::Failed(w) => format!("failed: {w}"),
            })
            .expect("the portal captures");
        assert!(capture.source_width >= 640, "{}", capture.source_width);
        eprintln!(
            "captured {}x{}",
            capture.source_width, capture.source_height
        );
    }

    #[test]
    fn a_short_read_is_an_error_rather_than_a_torn_image() {
        // Better than an image::RgbImage::from_raw returning None with no
        // explanation of what the server actually did.
        let err = to_rgb(&[0, 0, 0, 0], 4, 4, 32, false).unwrap_err();
        assert!(err.contains("4x4"), "got {err}");
    }
}
