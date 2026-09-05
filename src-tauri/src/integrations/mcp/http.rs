//! MCP over streamable HTTP, for servers reached across the network.
//!
//! Last of the MCP transports deliberately. Local stdio is what the bundled
//! runtimes exist for and what a privacy-minded audience actually runs; remote
//! servers bring an auth story that would have slowed everything before it.
//!
//! # Nothing above this changes
//!
//! rmcp's streamable-HTTP client is another `Transport`, so [`McpSession`]
//! negotiates, lists and calls through it exactly as it does over a pipe. The
//! dual-era logic from Phase 03 decides which protocol revision is in play; this
//! module supplies a transport, not policy. In particular, the
//! `MCP-Protocol-Version` header and the legacy `Mcp-Session-Id` are rmcp's to
//! send, driven by whatever the negotiation settled on.
//!
//! # Egress goes where the user said it should
//!
//! The client is built through [`apply_proxy`], the same helper `web_search` and
//! `fetch_url` use. A user who has configured a proxy — often the entire reason
//! they configured one — must not find that MCP quietly ignores it and connects
//! direct.
//!
//! # Auth
//!
//! A bearer token or API key the user pastes, stored like every other MCP
//! secret. A full OAuth authorization-code flow is **out of scope**: a partial
//! flow that strands someone mid-redirect is worse than an honest "not yet", and
//! the plan's non-goals rule out OAuth as shared infrastructure.

use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use std::time::Duration;

use crate::proxy::{apply_proxy, ProxyConfig};

/// Overall timeout for a single HTTP exchange with a remote server.
///
/// Generous enough for a slow tool on a distant host, short enough that an
/// unreachable one produces an error rather than a hang — which is the failure
/// this transport is most likely to hit.
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// Everything needed to reach one remote server.
#[derive(Clone, Debug)]
pub struct HttpConfig {
    pub url: String,
    /// The full `Authorization` header value, e.g. `Bearer ghp_…`. `None` for a
    /// server that needs no credential.
    pub auth_header: Option<String>,
}

impl HttpConfig {
    /// Compose an `Authorization` value from a pasted token.
    ///
    /// A token pasted with its scheme already on it (`Bearer abc`) is used as
    /// given; a bare token gets `Bearer `. People paste both, and prefixing a
    /// value that already has a scheme produces a 401 nobody can explain from
    /// the UI.
    pub fn bearer(url: impl Into<String>, token: Option<&str>) -> Self {
        let auth_header = token.map(str::trim).filter(|t| !t.is_empty()).map(|t| {
            if has_auth_scheme(t) {
                t.to_string()
            } else {
                format!("Bearer {t}")
            }
        });
        Self {
            url: url.into(),
            auth_header,
        }
    }
}

/// Whether a pasted credential already names an HTTP auth scheme.
///
/// Deliberately narrow: only the schemes a user might plausibly paste, matched
/// case-insensitively at the start and followed by a space. A token that merely
/// begins with the letters "basic" is still a token.
fn has_auth_scheme(token: &str) -> bool {
    const SCHEMES: [&str; 3] = ["bearer ", "basic ", "token "];
    let lower = token.to_ascii_lowercase();
    SCHEMES.iter().any(|scheme| lower.starts_with(scheme))
}

/// Reject anything that is not an absolute http(s) URL.
///
/// Checked before a connection is attempted so the error names the problem. A
/// `file://` or relative URL would otherwise fail somewhere inside the transport
/// with a message about the request rather than about what the user typed.
pub fn validate_url(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url.trim()).map_err(|e| format!("'{url}' is not a valid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        other => Err(format!(
            "MCP servers are reached over http or https; '{other}' is not supported"
        )),
    }
}

/// Build a streamable-HTTP transport for one remote server.
pub fn transport(
    config: &HttpConfig,
    proxy: Option<&ProxyConfig>,
) -> Result<StreamableHttpClientTransport<reqwest::Client>, String> {
    validate_url(&config.url)?;
    let client = apply_proxy(reqwest::Client::builder().timeout(HTTP_TIMEOUT), proxy)?
        .build()
        .map_err(|e| format!("could not create an HTTP client: {e}"))?;

    let mut transport_config = StreamableHttpClientTransportConfig::with_uri(config.url.trim());
    transport_config.auth_header = config.auth_header.clone();
    // The 2026-07-28 revision has no session at all, so a modern server will
    // never mint one. Requiring a session would fail every stateless server.
    transport_config.allow_stateless = true;

    Ok(StreamableHttpClientTransport::with_client(
        client,
        transport_config,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_token_gets_a_bearer_prefix() {
        let config = HttpConfig::bearer("https://mcp.example.test/mcp", Some("ghp_abc"));
        assert_eq!(config.auth_header.as_deref(), Some("Bearer ghp_abc"));
    }

    #[test]
    fn a_token_pasted_with_its_scheme_is_used_as_given() {
        // People paste both forms. Prefixing one that already has a scheme
        // produces a 401 nobody can explain from the UI.
        for pasted in ["Bearer ghp_abc", "bearer ghp_abc", "Basic dXNlcjpwdw=="] {
            let config = HttpConfig::bearer("https://x.test", Some(pasted));
            assert_eq!(config.auth_header.as_deref(), Some(pasted));
        }
    }

    #[test]
    fn a_token_that_merely_starts_with_scheme_letters_is_still_a_token() {
        let config = HttpConfig::bearer("https://x.test", Some("bearershaped"));
        assert_eq!(config.auth_header.as_deref(), Some("Bearer bearershaped"));
    }

    #[test]
    fn a_blank_token_sends_no_header_at_all() {
        // An empty Authorization header is worse than none: some servers reject
        // it outright rather than treating the request as anonymous.
        assert!(HttpConfig::bearer("https://x.test", None)
            .auth_header
            .is_none());
        assert!(HttpConfig::bearer("https://x.test", Some(""))
            .auth_header
            .is_none());
        assert!(HttpConfig::bearer("https://x.test", Some("   "))
            .auth_header
            .is_none());
    }

    #[test]
    fn surrounding_whitespace_is_trimmed_off_a_pasted_token() {
        let config = HttpConfig::bearer("https://x.test", Some("  ghp_abc  "));
        assert_eq!(config.auth_header.as_deref(), Some("Bearer ghp_abc"));
    }

    #[test]
    fn only_http_urls_are_accepted() {
        assert!(validate_url("https://mcp.example.test/mcp").is_ok());
        assert!(validate_url("http://localhost:8000/mcp").is_ok());
        assert!(validate_url("  https://x.test/mcp  ").is_ok());
    }

    #[test]
    fn a_non_http_url_is_refused_by_name() {
        // Named before a connection is attempted, so the message is about what
        // the user typed rather than about a request that never made sense.
        let err = validate_url("file:///etc/passwd").expect_err("not an MCP endpoint");
        assert!(err.contains("file"), "got {err}");
        assert!(
            validate_url("mcp.example.test/mcp").is_err(),
            "not absolute"
        );
        assert!(validate_url("").is_err());
    }

    // A tokio test: rmcp spawns the transport's worker task on construction, so
    // building one outside a runtime panics.
    #[tokio::test]
    async fn the_transport_is_built_stateless_because_a_modern_server_mints_no_session() {
        let config = HttpConfig::bearer("https://x.test/mcp", Some("t"));
        assert!(
            transport(&config, None).is_ok(),
            "a valid URL should produce a transport"
        );
    }

    #[test]
    fn a_bad_url_fails_before_any_request_is_made() {
        let config = HttpConfig::bearer("nonsense", None);
        assert!(transport(&config, None).is_err());
    }

    #[test]
    fn a_broken_proxy_url_surfaces_as_a_configuration_error() {
        // The user's proxy setting is wrong, not the server's URL, and the
        // message has to be able to say so.
        let config = HttpConfig::bearer("https://x.test/mcp", None);
        let proxy = ProxyConfig {
            mode: "manual".into(),
            url: "not a url".into(),
            bypass: String::new(),
        };
        let err = match transport(&config, Some(&proxy)) {
            Err(e) => e,
            // The transport type is not Debug, so this cannot be expect_err.
            Ok(_) => panic!("an unparseable proxy URL must not produce a transport"),
        };
        assert!(err.to_lowercase().contains("proxy"), "got {err}");
    }
}
