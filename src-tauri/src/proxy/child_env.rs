//! Proxy environment variables for child processes.
//!
//! An MCP server is a third-party program that makes its own outbound calls —
//! GitHub's server reaches `api.github.com`, Google's reaches Google. Those
//! connections are ours to influence but not ours to make, so the most we can
//! do is *tell* the child where the proxy is and hope it listens.
//!
//! # Set, never inherited
//!
//! Phase 02 clears a spawned server's environment on purpose: a server must
//! behave the same on the user's machine as on ours, and the ambient
//! environment is where that guarantee dies. These variables are therefore
//! **composed from the app's own settings** and set explicitly, not passed
//! through from whatever shell launched Haruspex. A user whose shell exports a
//! stale `HTTPS_PROXY` does not get it; a user who configured a proxy in
//! Settings does.
//!
//! # Best effort, and the UI should say so
//!
//! Whether a given server honours these is up to its author. A Go binary reads
//! them through `net/http`, Node's fetch does through `undici` in recent
//! versions but not older ones, and a Python package depends on whether it uses
//! `requests`. There is no way to make this a guarantee from outside the
//! process, so nothing here should be described as one.
//!
//! Both cases of each name are set. `curl` reads lowercase, Go reads either,
//! and various runtimes read only uppercase; setting both is the long-standing
//! way to reach all of them.

use super::bypass::ProxyUse;
use super::ProxyConfig;

/// Hosts every child is told to reach directly.
///
/// Matches the carve-out `apply_proxy` makes for our own requests, so a server
/// talking to something on this machine behaves the same way the app does.
const ALWAYS_DIRECT: &str = "localhost,127.0.0.1,::1";

/// The proxy variables to set on a child process, as `(name, value)` pairs.
///
/// Empty when there is nothing to say: no proxy configured, the mode is off, or
/// this server is set to bypass it. Empty means the child is simply not told
/// about a proxy — not that it is told there is none.
pub fn proxy_env(proxy: Option<&ProxyConfig>, mode: ProxyUse) -> Vec<(String, String)> {
    if mode == ProxyUse::Never {
        return Vec::new();
    }
    let Some(cfg) = proxy else { return Vec::new() };
    if cfg.mode != "manual" {
        return Vec::new();
    }
    let url = cfg.url.trim();
    if url.is_empty() {
        return Vec::new();
    }

    let mut env = Vec::new();
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        env.push((name.to_string(), url.to_string()));
        env.push((name.to_lowercase(), url.to_string()));
    }

    // "Always" means ignore the *user's bypass list* — not loopback. Nobody
    // picks it in order to proxy 127.0.0.1, and a companion-app server told to
    // do so would try to reach Blender or Godot through the proxy and fail at
    // the one connection it exists to make.
    let no_proxy = if mode == ProxyUse::Always {
        ALWAYS_DIRECT.to_string()
    } else {
        no_proxy_list(&cfg.bypass)
    };
    env.push(("NO_PROXY".to_string(), no_proxy.clone()));
    env.push(("no_proxy".to_string(), no_proxy));
    env
}

/// The `NO_PROXY` value: the loopback carve-out plus whatever the user listed.
///
/// The user's entries are passed through as written rather than normalised.
/// `NO_PROXY` is a loose convention with no single grammar — Go accepts CIDR,
/// curl does not, some tools want a leading dot for subdomains — so rewriting
/// entries would mean guessing which dialect the child speaks and getting it
/// wrong for the others.
fn no_proxy_list(bypass: &str) -> String {
    let mut entries: Vec<String> = ALWAYS_DIRECT.split(',').map(str::to_string).collect();
    for entry in bypass.split([',', ';', '\n', '\r', ' ', '\t']) {
        let trimmed = entry.trim();
        if !trimmed.is_empty() && !entries.iter().any(|e| e == trimmed) {
            entries.push(trimmed.to_string());
        }
    }
    entries.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manual(url: &str, bypass: &str) -> ProxyConfig {
        ProxyConfig {
            mode: "manual".to_string(),
            url: url.to_string(),
            bypass: bypass.to_string(),
        }
    }

    fn value<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    #[test]
    fn nothing_is_set_when_no_proxy_is_configured() {
        // Empty means "not told about a proxy", which is different from being
        // told there is none — a child with its own defaults keeps them.
        assert!(proxy_env(None, ProxyUse::Auto).is_empty());
        assert!(proxy_env(Some(&manual("", "")), ProxyUse::Auto).is_empty());
        assert!(proxy_env(Some(&manual("   ", "")), ProxyUse::Auto).is_empty());

        let off = ProxyConfig {
            mode: "none".to_string(),
            url: "http://proxy:8080".to_string(),
            bypass: String::new(),
        };
        assert!(proxy_env(Some(&off), ProxyUse::Auto).is_empty());
    }

    #[test]
    fn a_server_set_to_never_is_told_nothing() {
        let cfg = manual("http://proxy:8080", "");
        assert!(proxy_env(Some(&cfg), ProxyUse::Never).is_empty());
    }

    #[test]
    fn both_cases_of_every_name_are_set() {
        // curl reads lowercase, Go reads either, and some runtimes read only
        // uppercase. Setting both is how you reach all of them.
        let env = proxy_env(Some(&manual("http://proxy:8080", "")), ProxyUse::Auto);
        for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
            assert_eq!(value(&env, name), Some("http://proxy:8080"));
            assert_eq!(value(&env, &name.to_lowercase()), Some("http://proxy:8080"));
        }
        assert!(value(&env, "NO_PROXY").is_some());
        assert!(value(&env, "no_proxy").is_some());
    }

    #[test]
    fn loopback_is_always_named_as_direct() {
        // Matches the carve-out apply_proxy makes for our own requests, so a
        // server talking to something on this machine behaves as the app does.
        let env = proxy_env(Some(&manual("http://proxy:8080", "")), ProxyUse::Auto);
        let no_proxy = value(&env, "NO_PROXY").unwrap();
        assert!(no_proxy.contains("localhost"));
        assert!(no_proxy.contains("127.0.0.1"));
        assert!(no_proxy.contains("::1"));
    }

    #[test]
    fn the_users_bypass_entries_are_carried_through_as_written() {
        // NO_PROXY has no single grammar — Go takes CIDR, curl does not — so
        // rewriting entries would mean guessing which dialect the child speaks.
        let cfg = manual("http://proxy:8080", "example.com\n10.0.0.0/8, .internal");
        let env = proxy_env(Some(&cfg), ProxyUse::Auto);
        let no_proxy = value(&env, "NO_PROXY").unwrap();
        assert!(no_proxy.contains("example.com"));
        assert!(no_proxy.contains("10.0.0.0/8"));
        assert!(no_proxy.contains(".internal"));
    }

    #[test]
    fn a_bypass_entry_that_duplicates_the_carve_out_is_not_repeated() {
        let cfg = manual("http://proxy:8080", "localhost, example.com");
        let env = proxy_env(Some(&cfg), ProxyUse::Auto);
        let no_proxy = value(&env, "NO_PROXY").unwrap();
        assert_eq!(no_proxy.matches("localhost").count(), 1);
    }

    #[test]
    fn always_drops_the_users_bypass_list_but_keeps_loopback() {
        // The whole point of "always" is to override the bypass list. Dropping
        // loopback with it would tell a companion-app server to reach Blender
        // through the proxy — failing at the one connection it exists to make.
        let cfg = manual("http://proxy:8080", "example.com");
        let env = proxy_env(Some(&cfg), ProxyUse::Always);
        assert_eq!(value(&env, "HTTPS_PROXY"), Some("http://proxy:8080"));
        let no_proxy = value(&env, "NO_PROXY").expect("loopback still needs naming");
        assert!(no_proxy.contains("127.0.0.1"));
        assert!(!no_proxy.contains("example.com"));
    }
}
