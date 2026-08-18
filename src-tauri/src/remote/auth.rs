//! The shared secret that stands between a LAN and someone else's GPU.
//!
//! This is deliberately not an identity system, and the code should not read
//! like one. There are no users, no sessions-as-credentials and no expiry: one
//! token, carried in the link the host hands out, which exists so that a
//! housemate's laptop, a smart TV or a guest phone cannot spend the host's
//! hardware by finding an open port. Rotating it is the whole of revocation.

use axum::http::HeaderMap;

/// Query parameter carrying the token, because the link the host shares is the
/// entire setup procedure for a guest — asking them to set a header is not a
/// realistic instruction for someone standing at a gaming PC.
pub const TOKEN_QUERY_KEY: &str = "t";

/// Compare in time independent of how many leading characters match.
///
/// The realistic threat model here does not include a timing oracle on a LAN,
/// but a token comparison is exactly the place where "realistically fine" ages
/// badly, and the constant-time version is four lines.
pub fn token_matches(expected: &str, provided: &str) -> bool {
    let expected = expected.as_bytes();
    let provided = provided.as_bytes();
    // Length is not secret; comparing different-length inputs byte-wise below
    // would read past the shorter one.
    if expected.len() != provided.len() || expected.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(provided.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Pull a token from an `Authorization: Bearer` header, falling back to the
/// query string of the request URI.
pub fn extract_token(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        if let Ok(text) = value.to_str() {
            if let Some(rest) = text.strip_prefix("Bearer ") {
                let rest = rest.trim();
                if !rest.is_empty() {
                    return Some(rest.to_string());
                }
            }
        }
    }
    let query = query?;
    for pair in query.split('&') {
        // A valueless parameter is skipped rather than ending the search — `?`
        // here would make `?debug&t=…` look like no token at all.
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key == TOKEN_QUERY_KEY {
            return urlencoding::decode(value).ok().map(|v| v.into_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header::AUTHORIZATION, HeaderValue};

    #[test]
    fn matching_is_exact() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        assert!(!token_matches("abc123", "abc12"));
        assert!(!token_matches("abc123", "abc1234"));
    }

    #[test]
    fn an_empty_token_never_matches() {
        // Otherwise a server started before its token was generated would be
        // wide open to anyone who omitted the parameter entirely.
        assert!(!token_matches("", ""));
        assert!(!token_matches("", "anything"));
    }

    #[test]
    fn header_wins_over_query() {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer from-header"),
        );
        assert_eq!(
            extract_token(&headers, Some("t=from-query")).as_deref(),
            Some("from-header")
        );
    }

    #[test]
    fn query_token_is_url_decoded() {
        let headers = HeaderMap::new();
        assert_eq!(
            extract_token(&headers, Some("x=1&t=a%2Bb%3Dc")).as_deref(),
            Some("a+b=c")
        );
    }

    #[test]
    fn missing_or_malformed_yields_none() {
        let headers = HeaderMap::new();
        assert_eq!(extract_token(&headers, None), None);
        assert_eq!(extract_token(&headers, Some("")), None);
        assert_eq!(extract_token(&headers, Some("other=1")), None);
        // A valueless parameter before the token must not end the search.
        assert_eq!(
            extract_token(&headers, Some("debug&t=xyz")).as_deref(),
            Some("xyz")
        );

        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Basic nope"));
        assert_eq!(extract_token(&headers, None), None);
    }
}
