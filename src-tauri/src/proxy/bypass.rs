//! Proxy bypass-list parsing and apply_proxy() — both consumed by
//! every outbound HTTP client in this module so they live together
//! at the leaf.

use super::ProxyConfig;
use std::net::IpAddr;

pub(super) enum BypassEntry {
    Cidr(ipnet::IpNet),
    Ip(IpAddr),
    /// Lowercased, leading "." stripped. Matches the host itself or any
    /// subdomain (Firefox-style).
    Host(String),
}

pub(super) fn parse_bypass_list(raw: &str) -> Vec<BypassEntry> {
    raw.split([',', ';', '\n', '\r', ' ', '\t'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if let Ok(net) = s.parse::<ipnet::IpNet>() {
                BypassEntry::Cidr(net)
            } else if let Ok(ip) = s.parse::<IpAddr>() {
                BypassEntry::Ip(ip)
            } else {
                BypassEntry::Host(s.trim_start_matches('.').to_lowercase())
            }
        })
        .collect()
}

pub(super) fn should_bypass(target: &reqwest::Url, entries: &[BypassEntry]) -> bool {
    let Some(host) = target.host_str() else {
        return false;
    };
    // url::Url returns IPv6 hosts wrapped in brackets (`[::1]`); strip
    // them before parsing so literal IPv6 destinations match.
    let host_bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host_bare.parse::<IpAddr>() {
        return entries.iter().any(|e| match e {
            BypassEntry::Cidr(net) => net.contains(&ip),
            BypassEntry::Ip(entry) => entry == &ip,
            BypassEntry::Host(_) => false,
        });
    }
    let host_lc = host.to_lowercase();
    entries.iter().any(|e| match e {
        BypassEntry::Host(h) => host_lc == *h || host_lc.ends_with(&format!(".{}", h)),
        _ => false,
    })
}

/// Apply the user's proxy config to a reqwest ClientBuilder. Returns the
/// builder unchanged when the proxy is disabled or the URL is blank; bails
/// with an error if the URL is set but unparseable.
pub(crate) fn apply_proxy(
    builder: reqwest::ClientBuilder,
    proxy: Option<&ProxyConfig>,
) -> Result<reqwest::ClientBuilder, String> {
    let Some(cfg) = proxy else { return Ok(builder) };
    if cfg.mode != "manual" {
        return Ok(builder);
    }
    let trimmed = cfg.url.trim();
    if trimmed.is_empty() {
        return Ok(builder);
    }
    let proxy_url = reqwest::Url::parse(trimmed)
        .map_err(|e| format!("Invalid proxy URL '{}': {}", trimmed, e))?;
    let bypass = parse_bypass_list(&cfg.bypass);
    let rp = reqwest::Proxy::custom(move |target| {
        if should_bypass(target, &bypass) {
            None
        } else {
            Some(proxy_url.clone())
        }
    });
    Ok(builder.proxy(rp))
}
