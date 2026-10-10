//! Who may use the owner API without a token.
//!
//! Tokens always work. On top of them, Settings → Remote control → Who can
//! connect can let in, with no token at all:
//!
//! - **These computers:** a list of hostnames or IP addresses. Hostnames are
//!   looked up on the LAN (and again every [`RESOLVE_EVERY`]), so a computer
//!   whose address DHCP changes keeps working.
//! - **Anyone on my network:** any private address (RFC 1918, IPv6 unique-
//!   local and link-local) and this computer itself.
//!
//! Trusting an address trusts every program on that computer, including its
//! web browser, and so every web page it opens. Two checks keep a page from
//! using that trust (`server.rs` applies them):
//!
//! - the request must carry `X-Haruspex: 1`, which a page on another site
//!   can't add without a CORS preflight this server never answers;
//! - its `Host` must be one of this computer's own names
//!   ([`host_is_ours`]). Without that, a page could point a domain of its own
//!   at this computer ("DNS rebinding") and call the API as a same-origin
//!   page, Origin check and all.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::sync_util::LockExt;

/// How long a hostname's addresses are trusted before they are looked up again.
const RESOLVE_EVERY: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AccessMode {
    /// Only devices with a token.
    #[default]
    Tokens,
    /// Tokens, and the listed computers without one.
    Trusted,
    /// Tokens, and anyone on a private network without one.
    Lan,
}

/// Settings' answer to "who can connect without a token".
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OwnerAccess {
    pub mode: AccessMode,
    /// Hostnames or IP addresses, for [`AccessMode::Trusted`].
    pub trusted_hosts: Vec<String>,
    /// An extra name this computer is reached by (Settings' link address,
    /// e.g. `box.lan`), allowed as a `Host` alongside its own names.
    #[serde(default)]
    pub extra_host: Option<String>,
}

/// A listed computer and the addresses it was last found at, for Settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrustedHost {
    pub name: String,
    /// Empty when the name couldn't be found.
    pub addresses: Vec<String>,
}

pub struct Trust {
    access: Mutex<OwnerAccess>,
    /// Hostname -> (when looked up, what it resolved to).
    resolved: Mutex<HashMap<String, (Instant, Vec<IpAddr>)>>,
}

impl Default for Trust {
    fn default() -> Self {
        Trust {
            access: Mutex::new(OwnerAccess::default()),
            resolved: Mutex::new(HashMap::new()),
        }
    }
}

/// Private, unique-local, link-local, or this computer.
pub fn is_local_network(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local() || v4.is_loopback(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_local_network(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// This computer's name, as the LAN knows it.
pub fn system_hostname() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its whole length, and gethostname
        // writes at most that many bytes.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if rc == 0 {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
        None
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").ok().filter(|h| !h.is_empty())
    }
}

/// The host part of a `Host` header: no port, no IPv6 brackets.
fn host_name(host: &str) -> &str {
    let host = host.trim();
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name,
        _ => host,
    }
}

/// Whether a request's `Host` names this computer: an IP address (rebinding
/// needs a domain name), `localhost`, this computer's hostname (bare or
/// `.local`), or the extra name from Settings.
pub fn host_is_ours(host: &str, own_name: Option<&str>, extra: Option<&str>) -> bool {
    let name = host_name(host).trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    if name.parse::<IpAddr>().is_ok() || name == "localhost" {
        return true;
    }
    if let Some(own) = own_name.map(str::to_ascii_lowercase) {
        let short = own.split('.').next().unwrap_or(&own).to_string();
        if name == own || name == short || name == format!("{short}.local") {
            return true;
        }
    }
    extra
        .map(|e| {
            let e = e.trim();
            let e = e.split_once("://").map(|(_, rest)| rest).unwrap_or(e);
            host_name(e.split('/').next().unwrap_or(e))
                .trim_end_matches('.')
                .eq_ignore_ascii_case(&name)
        })
        .unwrap_or(false)
}

impl Trust {
    pub fn set(&self, access: OwnerAccess) {
        let mut current = self.access.lock_or_recover();
        if current.trusted_hosts != access.trusted_hosts {
            self.resolved.lock_or_recover().clear();
        }
        *current = access;
    }

    pub fn access(&self) -> OwnerAccess {
        self.access.lock_or_recover().clone()
    }

    /// The addresses `name` stands for: itself if it is one, else a lookup,
    /// cached for [`RESOLVE_EVERY`].
    async fn addresses(&self, name: &str) -> Vec<IpAddr> {
        let name = name.trim();
        if let Ok(ip) = name.parse::<IpAddr>() {
            return vec![ip];
        }
        if let Some((at, ips)) = self.resolved.lock_or_recover().get(name) {
            if at.elapsed() < RESOLVE_EVERY {
                return ips.clone();
            }
        }
        let ips: Vec<IpAddr> = match tokio::net::lookup_host((name, 0)).await {
            Ok(found) => {
                let mut ips: Vec<IpAddr> = found.map(|a| a.ip()).collect();
                ips.sort();
                ips.dedup();
                ips
            }
            Err(_) => Vec::new(),
        };
        self.resolved
            .lock_or_recover()
            .insert(name.to_string(), (Instant::now(), ips.clone()));
        ips
    }

    /// Whether `peer` may connect without a token.
    pub async fn trusts(&self, peer: IpAddr) -> bool {
        let access = self.access();
        let peer = match peer {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(peer),
            v4 => v4,
        };
        match access.mode {
            AccessMode::Tokens => false,
            AccessMode::Lan => is_local_network(peer),
            AccessMode::Trusted => {
                for host in &access.trusted_hosts {
                    if self.addresses(host).await.contains(&peer) {
                        return true;
                    }
                }
                false
            }
        }
    }

    /// Each listed computer and where it was found, for Settings.
    pub async fn resolve_all(&self) -> Vec<TrustedHost> {
        let hosts = self.access().trusted_hosts;
        let mut out = Vec::new();
        for name in hosts {
            let addresses = self
                .addresses(&name)
                .await
                .into_iter()
                .map(|ip| ip.to_string())
                .collect();
            out.push(TrustedHost { name, addresses });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn the_local_network_is_private_and_link_local_addresses() {
        for local in [
            "192.168.1.20",
            "10.0.0.5",
            "172.16.4.4",
            "169.254.1.1",
            "127.0.0.1",
            "fd12::1",
            "fe80::1",
            "::1",
            "::ffff:192.168.1.20",
        ] {
            assert!(is_local_network(ip(local)), "{local}");
        }
        for public in ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:db8::1"] {
            assert!(!is_local_network(ip(public)), "{public}");
        }
    }

    #[test]
    fn only_this_computers_names_are_ours() {
        let own = Some("asmodean");
        for ours in [
            "192.168.1.174:8788",
            "[fe80::1]:8788",
            "localhost:8788",
            "asmodean:8788",
            "ASMODEAN.local:8788",
            "box.lan:8788",
        ] {
            assert!(
                host_is_ours(ours, own, Some("http://box.lan:8788")),
                "{ours}"
            );
        }
        for theirs in ["evil.example:8788", "asmodean.evil.example:8788", ""] {
            assert!(
                !host_is_ours(theirs, own, Some("http://box.lan")),
                "{theirs}"
            );
        }
    }

    #[tokio::test]
    async fn tokens_mode_trusts_nobody() {
        let t = Trust::default();
        assert!(!t.trusts(ip("127.0.0.1")).await);
    }

    #[tokio::test]
    async fn lan_mode_trusts_private_addresses_only() {
        let t = Trust::default();
        t.set(OwnerAccess {
            mode: AccessMode::Lan,
            ..Default::default()
        });
        assert!(t.trusts(ip("192.168.1.20")).await);
        assert!(!t.trusts(ip("8.8.8.8")).await);
    }

    #[tokio::test]
    async fn trusted_mode_trusts_the_listed_computers() {
        let t = Trust::default();
        t.set(OwnerAccess {
            mode: AccessMode::Trusted,
            trusted_hosts: vec!["192.168.1.20".into(), "localhost".into()],
            extra_host: None,
        });
        assert!(t.trusts(ip("192.168.1.20")).await);
        assert!(t.trusts(ip("127.0.0.1")).await, "localhost resolves");
        assert!(!t.trusts(ip("192.168.1.21")).await);
        let found = t.resolve_all().await;
        assert_eq!(found[0].addresses, vec!["192.168.1.20".to_string()]);
        assert!(found[1].addresses.iter().any(|a| a == "127.0.0.1"));
    }

    #[tokio::test]
    async fn a_name_that_cannot_be_found_trusts_nothing() {
        let t = Trust::default();
        t.set(OwnerAccess {
            mode: AccessMode::Trusted,
            trusted_hosts: vec!["no-such-host.invalid".into()],
            extra_host: None,
        });
        assert!(!t.trusts(ip("127.0.0.1")).await);
        assert!(t.resolve_all().await[0].addresses.is_empty());
    }
}
