//! The DNS resolver behind every fetch of a URL the model chose.
//!
//! `validate_url` refuses a literal private address, but a name is only an
//! address once it is looked up: `router.lan`, or a public name that resolves
//! to 127.0.0.1, sailed past it. This resolver is what reqwest asks for every
//! connection it makes directly, redirect hops included, so the address it
//! refuses is the one that would have been connected to: no gap between the
//! check and the connection for a rebinding name to slip through.
//!
//! Through a proxy, the proxy resolves the target and reaches whatever its
//! network allows; only the proxy's own name comes through here, and it is let
//! through, since the user chose it.

use std::net::SocketAddr;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use crate::net_util;

pub(crate) struct PublicOnly {
    /// The configured proxy's host name, which may well be on the LAN.
    proxy_host: Option<String>,
}

impl PublicOnly {
    pub(crate) fn new(proxy_host: Option<String>) -> Self {
        Self { proxy_host }
    }
}

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let is_proxy = self
            .proxy_host
            .as_deref()
            .is_some_and(|p| p.eq_ignore_ascii_case(&host));
        Box::pin(async move {
            let addrs: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if !is_proxy {
                refuse_non_public(&host, &addrs)?;
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/// Refused when any address is off the open internet: a name that answers
/// with one public and one private address must not get the private one.
fn refuse_non_public(host: &str, addrs: &[SocketAddr]) -> Result<(), String> {
    if addrs.iter().any(|a| net_util::is_non_public(a.ip())) {
        return Err(format!(
            "{host} resolves to this computer or the local network, which web fetches may not reach"
        ));
    }
    Ok(())
}

/// The host a proxy URL names, when it names one rather than an address.
pub(crate) fn proxy_host(proxy_url: &str) -> Option<String> {
    match reqwest::Url::parse(proxy_url).ok()?.host()? {
        url::Host::Domain(d) => Some(d.to_ascii_lowercase()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addrs(ips: &[&str]) -> Vec<SocketAddr> {
        ips.iter()
            .map(|ip| SocketAddr::new(ip.parse().unwrap(), 0))
            .collect()
    }

    #[test]
    fn refuses_a_name_with_any_private_address() {
        assert!(refuse_non_public("ok.example", &addrs(&["93.184.216.34"])).is_ok());
        for ips in [
            vec!["127.0.0.1"],
            vec!["192.168.1.10"],
            vec!["100.100.1.1"],
            vec!["93.184.216.34", "10.0.0.5"],
            vec!["::1"],
        ] {
            let err = refuse_non_public("x.example", &addrs(&ips)).unwrap_err();
            assert!(
                err.contains("x.example resolves to this computer"),
                "{ips:?}"
            );
        }
    }

    #[tokio::test]
    async fn localhost_is_refused_unless_it_is_the_proxy() {
        let r = PublicOnly::new(None);
        let err = r.resolve("localhost".parse().unwrap()).await.err().unwrap();
        assert!(err.to_string().contains("resolves to this computer"));

        let r = PublicOnly::new(Some("localhost".into()));
        assert!(r.resolve("localhost".parse().unwrap()).await.is_ok());
    }

    #[test]
    fn names_the_proxy_host_only_when_it_is_a_name() {
        assert_eq!(
            proxy_host("http://user@Proxy.Corp:3128").as_deref(),
            Some("proxy.corp")
        );
        assert_eq!(proxy_host("http://10.0.0.2:3128"), None);
        assert_eq!(proxy_host("not a url"), None);
    }
}
