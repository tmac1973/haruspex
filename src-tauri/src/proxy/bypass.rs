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

/// Loopback is never proxied, whatever the user's bypass list says.
///
/// Nobody routes `127.0.0.1` through a corporate proxy, and doing it produces a
/// connection failure that reads as "the local server is broken" rather than as
/// "the proxy rejected it". Standard `no_proxy` conventions have carved out
/// loopback for decades; this makes the app match them.
///
/// Deliberately loopback only. Private ranges like `10.0.0.0/8` are a judgement
/// call — some networks genuinely do proxy internal traffic — so those stay in
/// the user's own bypass list rather than being assumed here.
fn is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.to_lowercase().ends_with(".localhost") {
        return true;
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

pub(super) fn should_bypass(target: &reqwest::Url, entries: &[BypassEntry]) -> bool {
    let Some(host) = target.host_str() else {
        return false;
    };
    if is_loopback(host) {
        return true;
    }
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
/// Whether a particular client should use the app's proxy.
///
/// Most callers want [`ProxyUse::Auto`]. The other two exist for MCP servers,
/// where the address alone cannot always decide: a public host the user wants
/// reached direct, or an internal host that does need the proxy even though the
/// bypass rules would skip it.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS,
)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ProxyUse {
    /// Follow the app's proxy setting, including the loopback carve-out and the
    /// user's bypass list.
    #[default]
    Auto,
    /// Never use the proxy for this client.
    Never,
    /// Always use it, ignoring both the loopback carve-out and the bypass list.
    Always,
}

pub(crate) fn apply_proxy(
    builder: reqwest::ClientBuilder,
    proxy: Option<&ProxyConfig>,
) -> Result<reqwest::ClientBuilder, String> {
    apply_proxy_with(builder, proxy, ProxyUse::Auto)
}

/// [`apply_proxy`], with an explicit override.
pub(crate) fn apply_proxy_with(
    builder: reqwest::ClientBuilder,
    proxy: Option<&ProxyConfig>,
    mode: ProxyUse,
) -> Result<reqwest::ClientBuilder, String> {
    if mode == ProxyUse::Never {
        return Ok(builder);
    }
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
    let force = mode == ProxyUse::Always;
    let rp = reqwest::Proxy::custom(move |target| {
        if !force && should_bypass(target, &bypass) {
            None
        } else {
            Some(proxy_url.clone())
        }
    });
    Ok(builder.proxy(rp))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bypass(list: &str) -> Vec<BypassEntry> {
        parse_bypass_list(list)
    }

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }

    #[test]
    fn bypass_host_matches_exact_and_subdomain() {
        let entries = bypass("example.com");
        assert!(should_bypass(&url("https://example.com/"), &entries));
        assert!(should_bypass(&url("https://api.example.com/x"), &entries));
        assert!(!should_bypass(&url("https://otherexample.com/"), &entries));
        assert!(!should_bypass(&url("https://example.org/"), &entries));
    }

    #[test]
    fn bypass_ignores_leading_dot_on_host_entry() {
        let entries = bypass(".example.com");
        assert!(should_bypass(&url("https://example.com/"), &entries));
        assert!(should_bypass(&url("https://www.example.com/"), &entries));
    }

    #[test]
    fn bypass_matches_ipv4_literal_and_cidr() {
        let entries = bypass("192.168.1.5, 10.0.0.0/8");
        assert!(should_bypass(&url("http://192.168.1.5/"), &entries));
        assert!(should_bypass(&url("http://10.99.99.99/"), &entries));
        assert!(!should_bypass(&url("http://192.168.1.6/"), &entries));
        assert!(!should_bypass(&url("http://11.0.0.1/"), &entries));
    }

    #[test]
    fn bypass_matches_ipv6_cidr() {
        let entries = bypass("2001:db8::/32");
        assert!(should_bypass(&url("http://[2001:db8:1::abcd]/"), &entries));
        assert!(!should_bypass(&url("http://[2001:db9::abcd]/"), &entries));
    }

    #[test]
    fn bypass_accepts_newline_and_comma_separators() {
        let entries = bypass("example.com,\n  192.168.0.0/16 ; foo.org\n");
        assert!(should_bypass(&url("https://example.com/"), &entries));
        assert!(should_bypass(&url("https://foo.org/"), &entries));
        assert!(should_bypass(&url("http://192.168.5.5/"), &entries));
    }

    #[test]
    fn bypass_empty_list_never_matches() {
        let entries = bypass("");
        assert!(!should_bypass(&url("https://example.com/"), &entries));
    }

    #[test]
    fn loopback_is_bypassed_without_being_asked_for() {
        // A local MCP server on 127.0.0.1 routed through a corporate proxy
        // fails, and reads as "the local server is broken" rather than as
        // "the proxy rejected it".
        let none = bypass("");
        assert!(should_bypass(&url("http://127.0.0.1:9090/mcp"), &none));
        assert!(should_bypass(&url("http://127.5.5.5/"), &none));
        assert!(should_bypass(&url("http://[::1]:8000/"), &none));
        assert!(should_bypass(&url("http://localhost:3000/"), &none));
        assert!(should_bypass(&url("http://LocalHost/"), &none));
        assert!(should_bypass(&url("http://api.localhost/"), &none));
    }

    #[test]
    fn a_host_that_merely_resembles_localhost_is_not_loopback() {
        let none = bypass("");
        assert!(!should_bypass(
            &url("https://localhost.example.com/"),
            &none
        ));
        assert!(!should_bypass(&url("https://notlocalhost/"), &none));
    }

    #[test]
    fn private_ranges_are_not_assumed_to_bypass() {
        // Some networks genuinely proxy internal traffic, so 10/8 and friends
        // stay a decision for the user's own bypass list.
        let none = bypass("");
        assert!(!should_bypass(&url("http://10.1.2.3/"), &none));
        assert!(!should_bypass(&url("http://192.168.1.5/"), &none));
        // ...and still work when the user does list them.
        let listed = bypass("10.0.0.0/8");
        assert!(should_bypass(&url("http://10.1.2.3/"), &listed));
    }

    #[test]
    fn never_skips_the_proxy_even_when_one_is_configured() {
        let cfg = ProxyConfig {
            mode: "manual".to_string(),
            url: "http://proxy.example:8080".to_string(),
            bypass: String::new(),
        };
        // An unparseable URL would error under Auto; Never returns before the
        // config is read at all, which is what proves it short-circuits.
        let broken = ProxyConfig {
            url: "not a url".to_string(),
            ..cfg.clone()
        };
        assert!(
            apply_proxy_with(reqwest::Client::builder(), Some(&broken), ProxyUse::Never).is_ok()
        );
        assert!(apply_proxy_with(reqwest::Client::builder(), Some(&cfg), ProxyUse::Never).is_ok());
    }

    #[test]
    fn always_still_needs_a_usable_proxy_url() {
        // "Always" overrides the bypass rules, not the absence of a proxy.
        let cfg = ProxyConfig {
            mode: "manual".to_string(),
            url: "not a url".to_string(),
            bypass: String::new(),
        };
        assert!(
            apply_proxy_with(reqwest::Client::builder(), Some(&cfg), ProxyUse::Always).is_err()
        );
    }

    #[test]
    fn auto_is_what_the_plain_helper_does() {
        let cfg = ProxyConfig {
            mode: "manual".to_string(),
            url: "http://proxy.example:8080".to_string(),
            bypass: String::new(),
        };
        assert!(apply_proxy(reqwest::Client::builder(), Some(&cfg)).is_ok());
        assert!(apply_proxy_with(reqwest::Client::builder(), Some(&cfg), ProxyUse::Auto).is_ok());
    }

    #[test]
    fn apply_proxy_noop_when_mode_is_none() {
        let cfg = ProxyConfig {
            mode: "none".to_string(),
            url: "http://proxy.example:8080".to_string(),
            bypass: String::new(),
        };
        // Just verifies apply_proxy accepts the config and returns Ok;
        // we can't inspect whether a proxy was attached to the builder,
        // but this confirms the "none" branch doesn't error on a set URL.
        assert!(apply_proxy(reqwest::Client::builder(), Some(&cfg)).is_ok());
    }

    #[test]
    fn apply_proxy_errors_on_invalid_url() {
        let cfg = ProxyConfig {
            mode: "manual".to_string(),
            url: "not a url".to_string(),
            bypass: String::new(),
        };
        assert!(apply_proxy(reqwest::Client::builder(), Some(&cfg)).is_err());
    }

    #[test]
    fn apply_proxy_ignores_blank_manual_url() {
        let cfg = ProxyConfig {
            mode: "manual".to_string(),
            url: "   ".to_string(),
            bypass: String::new(),
        };
        assert!(apply_proxy(reqwest::Client::builder(), Some(&cfg)).is_ok());
    }
}
