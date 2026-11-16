//! A found camera's name on the network. Cameras usually get their address
//! from the router, which can hand out a different one later; a name the
//! router's DNS (or mDNS) gives it follows the camera, so Settings → Cameras
//! offers it in place of the address.
//!
//! The name comes from a reverse lookup, and is kept only when looking it up
//! again leads back to the same address.

use std::net::IpAddr;
use std::time::Duration;

/// How long one lookup may take.
const LOOKUP_LIMIT: Duration = Duration::from_secs(2);

/// The name `ip` is known by on the network, when it has one that resolves
/// back to it.
pub(crate) async fn name_for(ip: IpAddr) -> Option<String> {
    let reverse = tokio::task::spawn_blocking(move || reverse_lookup(ip));
    let name = tokio::time::timeout(LOOKUP_LIMIT, reverse)
        .await
        .ok()?
        .ok()??;
    let name = usable_name(&name)?;
    resolves_to(&name, ip).await.then_some(name)
}

/// `name` without a trailing dot, unless it's empty or only an address.
fn usable_name(name: &str) -> Option<String> {
    let name = name.trim().trim_end_matches('.');
    if name.is_empty() || name.parse::<IpAddr>().is_ok() {
        return None;
    }
    Some(name.to_ascii_lowercase())
}

/// Whether looking `name` up gives `ip` among its addresses.
async fn resolves_to(name: &str, ip: IpAddr) -> bool {
    let lookup = tokio::net::lookup_host((name, 0));
    match tokio::time::timeout(LOOKUP_LIMIT, lookup).await {
        Ok(Ok(mut addrs)) => addrs.any(|a| a.ip() == ip),
        _ => false,
    }
}

#[cfg(unix)]
fn reverse_lookup(ip: IpAddr) -> Option<String> {
    use std::ffi::CStr;
    // Only IPv4: discovery only probes IPv4 interfaces.
    let IpAddr::V4(v4) = ip else {
        return None;
    };
    // SAFETY: an all-zero sockaddr_in is valid; the fields set below are the
    // ones getnameinfo reads.
    let mut addr: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    addr.sin_family = libc::AF_INET as libc::sa_family_t;
    addr.sin_addr = libc::in_addr {
        s_addr: u32::from_ne_bytes(v4.octets()),
    };
    let mut host = [0 as libc::c_char; 1025];
    // SAFETY: the pointers and lengths describe `addr` and `host`, which
    // outlive the call; NI_NAMEREQD makes it fail rather than print the address.
    let rc = unsafe {
        libc::getnameinfo(
            (&addr as *const libc::sockaddr_in).cast(),
            std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
            host.as_mut_ptr(),
            host.len() as libc::socklen_t,
            std::ptr::null_mut(),
            0,
            libc::NI_NAMEREQD,
        )
    };
    if rc != 0 {
        return None;
    }
    // SAFETY: on success getnameinfo wrote a NUL-terminated string into `host`.
    let name = unsafe { CStr::from_ptr(host.as_ptr()) };
    name.to_str().ok().map(str::to_string)
}

/// Windows has no `getnameinfo` in `libc`; found cameras keep their address.
#[cfg(not(unix))]
fn reverse_lookup(_ip: IpAddr) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_loses_its_trailing_dot_and_an_address_is_no_name() {
        assert_eq!(
            usable_name("Wifi-Cam-1.home.internal."),
            Some("wifi-cam-1.home.internal".into())
        );
        assert_eq!(usable_name("192.168.1.184"), None);
        assert_eq!(usable_name(" "), None);
    }

    #[tokio::test]
    async fn a_name_counts_only_when_it_leads_back() {
        assert!(resolves_to("localhost", "127.0.0.1".parse().unwrap()).await);
        assert!(!resolves_to("localhost", "10.9.9.9".parse().unwrap()).await);
    }
}
