//! Where an IP address leads: this machine, the local network, or the
//! internet. The one classifier behind the web tools' SSRF guard
//! (`proxy::extract`) and the Python sandbox's network levels
//! (`sandbox_fetch`), so the two cannot drift apart.
//!
//! `owner::trust` keeps its own, narrower rule on purpose: it decides which
//! clients count as being on the user's LAN, and a CGNAT address (a tailnet
//! peer, a carrier's NAT) is not one.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    /// This machine: loopback, or an unspecified (`0.x.x.x`, `::`) address,
    /// which connects here.
    Local,
    /// A private, link-local, shared (CGNAT, where tailnets live), multicast
    /// or broadcast network.
    Lan,
    Public,
}

pub fn reach(ip: IpAddr) -> Reach {
    match ip {
        IpAddr::V4(v4) => reach_v4(v4),
        IpAddr::V6(v6) => match embedded_v4(v6) {
            Some(v4) => reach_v4(v4),
            None => reach_v6(v6),
        },
    }
}

/// Anything but the open internet.
pub fn is_non_public(ip: IpAddr) -> bool {
    reach(ip) != Reach::Public
}

fn reach_v4(v4: Ipv4Addr) -> Reach {
    let [a, b, ..] = v4.octets();
    if v4.is_loopback() || a == 0 {
        Reach::Local
    } else if v4.is_private()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_multicast()
        || (a == 100 && (64..128).contains(&b))
    {
        Reach::Lan
    } else {
        Reach::Public
    }
}

fn reach_v6(v6: Ipv6Addr) -> Reach {
    let seg0 = v6.segments()[0];
    if v6.is_loopback() || v6.is_unspecified() {
        Reach::Local
    } else if (seg0 & 0xfe00) == 0xfc00 // unique-local fc00::/7
        || (seg0 & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (seg0 & 0xffc0) == 0xfec0 // site-local fec0::/10 (deprecated, still routed by some stacks)
        || v6.is_multicast()
    {
        Reach::Lan
    } else {
        Reach::Public
    }
}

/// The IPv4 address an IPv6 one carries to the V4 network, judged by that
/// address rather than as IPv6: IPv4-mapped (`::ffff:a.b.c.d`),
/// IPv4-compatible (`::a.b.c.d`), NAT64 (`64:ff9b::/96`) and 6to4
/// (`2002:aabb:ccdd::/48`).
fn embedded_v4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return Some(v4);
    }
    let s = v6.segments();
    let tail = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    // `::` and `::1` are IPv6's own unspecified and loopback, not IPv4-compatible.
    if s[..6] == [0; 6] && !v6.is_unspecified() && !v6.is_loopback() {
        return Some(tail);
    }
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return Some(tail);
    }
    if s[0] == 0x2002 {
        return Some(Ipv4Addr::new(
            (s[1] >> 8) as u8,
            s[1] as u8,
            (s[2] >> 8) as u8,
            s[2] as u8,
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(ip: &str) -> Reach {
        reach(ip.parse().unwrap())
    }

    #[test]
    fn this_machine() {
        for ip in [
            "127.0.0.1",
            "127.8.9.1",
            "0.0.0.0",
            "0.1.2.3",
            "::1",
            "::",
            "::ffff:127.0.0.1",
            "::127.0.0.1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::",
        ] {
            assert_eq!(r(ip), Reach::Local, "{ip}");
        }
    }

    #[test]
    fn local_network() {
        for ip in [
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.254",
            "255.255.255.255",
            "224.0.0.251",
            "fd00::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "::ffff:192.168.1.1",
            "::ffff:100.100.1.1",
            "::10.0.0.1",
            "64:ff9b::a9fe:a9fe",
            "2002:c0a8:101::1",
        ] {
            assert_eq!(r(ip), Reach::Lan, "{ip}");
        }
    }

    #[test]
    fn internet() {
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "100.63.255.255",
            "100.128.0.1",
            "172.32.0.1",
            "2606:4700::1111",
            "64:ff9b::808:808",
            "2002:808:808::1",
        ] {
            assert_eq!(r(ip), Reach::Public, "{ip}");
        }
    }
}
