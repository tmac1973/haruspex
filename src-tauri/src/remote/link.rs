//! What the host has to hand a guest: an address they can reach, and a way to
//! get it onto a phone without typing it.

use serde::Serialize;
use std::net::{IpAddr, SocketAddr, UdpSocket};

/// The address to put in the shareable link.
///
/// Not `0.0.0.0` — that is what the server binds, not somewhere anyone can
/// browse to — and not `localhost`, which resolves to the wrong machine on the
/// device that matters. A link nobody else can open is the most likely way for
/// this feature to look broken while working perfectly.
///
/// Found by asking the OS which local address it would use to reach the wider
/// network. No packet is sent: a connected UDP socket only picks a route. That
/// beats walking every interface and guessing, which gets VPN adapters, Docker
/// bridges and Hyper-V switches wrong in a way that is invisible until a guest
/// says "it doesn't load".
pub fn lan_address() -> Option<IpAddr> {
    for probe in ["8.8.8.8:80", "1.1.1.1:80"] {
        let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
            continue;
        };
        let Ok(target) = probe.parse::<SocketAddr>() else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        if let Ok(addr) = socket.local_addr() {
            let ip = addr.ip();
            if !ip.is_loopback() && !ip.is_unspecified() {
                return Some(ip);
            }
        }
    }
    None
}

/// A QR code as a square of dark/light modules.
///
/// Deliberately not an image or an SVG string: the caller renders it, so
/// nothing here has to be trusted as markup and the same data can become an
/// `<svg>` or a canvas without a second encoder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrMatrix {
    /// Width and height in modules.
    pub size: usize,
    /// Row-major, `size * size` entries; true is dark.
    pub modules: Vec<bool>,
}

pub fn qr_matrix(text: &str) -> Result<QrMatrix, String> {
    use qrcode::{EcLevel, QrCode};

    // Medium correction: a phone camera at arm's length in a living room is not
    // a damaged label, and the extra redundancy of higher levels only makes the
    // modules smaller.
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M)
        .map_err(|e| format!("could not encode the link: {e}"))?;
    let colours = code.to_colors();
    let size = code.width();
    Ok(QrMatrix {
        size,
        modules: colours
            .into_iter()
            .map(|c| c == qrcode::Color::Dark)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_encodes_to_a_square_of_modules() {
        let qr = qr_matrix("http://192.168.1.50:8787/?t=abcdefghijklmnopqrstuvwxyz012345").unwrap();
        assert!(qr.size >= 21, "smaller than the smallest QR version");
        assert_eq!(qr.modules.len(), qr.size * qr.size);
        // Every QR has a finder pattern in the top-left corner: three dark
        // modules along the first row. A blank matrix would pass a length check
        // and fail every phone.
        assert!(qr.modules[0] && qr.modules[1] && qr.modules[2]);
        assert!(qr.modules.iter().any(|m| !m), "no light modules at all");
    }

    #[test]
    fn a_longer_link_needs_a_bigger_code() {
        let short = qr_matrix("http://10.0.0.2:8787/?t=aaaa").unwrap();
        let long = qr_matrix(&format!("http://10.0.0.2:8787/?t={}", "a".repeat(300))).unwrap();
        assert!(long.size > short.size);
    }

    #[test]
    fn the_lan_address_is_never_loopback() {
        // On a machine with no route at all this is None, which is a real
        // answer — the settings page says so rather than showing 127.0.0.1 and
        // sending the guest somewhere that cannot work.
        if let Some(ip) = lan_address() {
            assert!(!ip.is_loopback());
            assert!(!ip.is_unspecified());
        }
    }
}
