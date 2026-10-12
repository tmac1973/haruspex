//! The shared secret that stands between a LAN and someone else's GPU.
//!
//! This is deliberately not an identity system, and the code should not read
//! like one. There are no users and no sessions-as-credentials: one token,
//! carried in the link the host hands out, which exists so that a housemate's
//! laptop, a smart TV or a guest phone cannot spend the host's hardware by
//! finding an open port. Rotating it is the whole of revocation. The link is
//! traded for a cookie on the first visit, so the token leaves the address bar
//! and every URL after it.

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

/// The cookie a guest's browser keeps after opening a valid link, so the page
/// still works from a bookmark or a home-screen shortcut, which never carry
/// the token: the first visit is redirected to a URL without it.
///
/// It holds [`cookie_value`], not the token itself, so what sits in a
/// browser's cookie jar is not the secret that gets shared; and it is still
/// revoked by rotating the link, since a new token derives a new value.
///
/// `SameSite=Strict` is what keeps this from becoming a CSRF hole: another site
/// on the same network cannot make a browser attach it. The JSON content type
/// the API requires is a second layer, since a cross-site form post cannot set
/// one without a preflight.
pub const TOKEN_COOKIE: &str = "haruspex_remote";

/// How long the cookie lasts after the last visit. Every page load renews it,
/// so a shortcut used at least once a month keeps working; one left alone
/// longer needs the link again.
pub const COOKIE_MAX_AGE_SECS: u64 = 30 * 86_400;

/// How a request proved it may use the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Proof {
    /// `Authorization: Bearer <token>`: a script.
    Bearer,
    /// `?t=<token>`: the shared link, accepted on the page load only.
    Link,
    /// The derived cookie.
    Cookie,
    /// A cookie holding the raw token, as builds before the derived cookie
    /// set it. Accepted on the page load only, which replaces it.
    LegacyCookie,
}

/// How the request proves it knows `token`, if it does. `allow_link` is for
/// the page itself: the API never takes the token from the query string, so
/// it stays out of every URL a page makes.
pub fn check(
    headers: &HeaderMap,
    query: Option<&str>,
    token: &str,
    allow_link: bool,
) -> Option<Proof> {
    if bearer(headers).is_some_and(|b| token_matches(token, &b)) {
        return Some(Proof::Bearer);
    }
    if allow_link
        && query
            .and_then(query_token)
            .is_some_and(|q| token_matches(token, &q))
    {
        return Some(Proof::Link);
    }
    let cookie = cookie_token(headers)?;
    if token_matches(&cookie_value(token), &cookie) {
        return Some(Proof::Cookie);
    }
    (allow_link && token_matches(token, &cookie)).then_some(Proof::LegacyCookie)
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let text = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let rest = text.strip_prefix("Bearer ")?.trim();
    (!rest.is_empty()).then(|| rest.to_string())
}

fn query_token(query: &str) -> Option<String> {
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

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for pair in cookies.split(';') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key.trim() == TOKEN_COOKIE {
            return Some(value.trim().to_string());
        }
    }
    None
}

/// What the cookie holds for `token`: a one-way hash, so the cookie can't be
/// turned back into a shareable link.
pub fn cookie_value(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("haruspex-guest-cookie:{token}").as_bytes());
    crate::hash_util::hex(&digest)
}

/// The `Set-Cookie` value for a guest who proved they have the link.
/// `Secure`: the page is HTTPS only.
pub fn guest_cookie(token: &str) -> String {
    format!(
        "{TOKEN_COOKIE}={}; Path=/; Max-Age={COOKIE_MAX_AGE_SECS}; SameSite=Strict; HttpOnly; Secure",
        cookie_value(token)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{
        header::{AUTHORIZATION, COOKIE},
        HeaderValue,
    };

    const TOKEN: &str = "link-token";

    fn with(name: axum::http::HeaderName, value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(name, HeaderValue::from_str(value).unwrap());
        headers
    }

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
    fn the_link_works_on_the_page_only() {
        let none = HeaderMap::new();
        assert_eq!(
            check(&none, Some("t=link-token"), TOKEN, true),
            Some(Proof::Link)
        );
        // The API never takes it from the query string.
        assert_eq!(check(&none, Some("t=link-token"), TOKEN, false), None);
        assert_eq!(check(&none, Some("t=wrong"), TOKEN, true), None);
    }

    #[test]
    fn the_query_token_is_url_decoded_and_found_after_other_parameters() {
        let none = HeaderMap::new();
        assert_eq!(
            check(&none, Some("x=1&t=a%2Bb%3Dc"), "a+b=c", true),
            Some(Proof::Link)
        );
        assert_eq!(
            check(&none, Some("debug&t=xyz"), "xyz", true),
            Some(Proof::Link)
        );
    }

    #[test]
    fn a_bearer_header_works_everywhere() {
        let h = with(AUTHORIZATION, "Bearer link-token");
        assert_eq!(check(&h, None, TOKEN, false), Some(Proof::Bearer));
        assert_eq!(
            check(&with(AUTHORIZATION, "Basic nope"), None, TOKEN, false),
            None
        );
        assert_eq!(
            check(&with(AUTHORIZATION, "Bearer "), None, TOKEN, false),
            None
        );
    }

    #[test]
    fn the_cookie_holds_a_derived_value_not_the_token() {
        let value = cookie_value(TOKEN);
        assert_ne!(value, TOKEN);
        assert_eq!(value.len(), 64);
        let h = with(COOKIE, &format!("other=1; {TOKEN_COOKIE}={value}"));
        assert_eq!(check(&h, None, TOKEN, false), Some(Proof::Cookie));
        assert_eq!(check(&h, None, TOKEN, true), Some(Proof::Cookie));
    }

    #[test]
    fn rotating_the_link_revokes_the_cookie() {
        let h = with(COOKIE, &format!("{TOKEN_COOKIE}={}", cookie_value(TOKEN)));
        assert_eq!(check(&h, None, "rotated", true), None);
    }

    #[test]
    fn an_old_raw_token_cookie_is_accepted_on_the_page_only() {
        let h = with(COOKIE, &format!("{TOKEN_COOKIE}={TOKEN}"));
        assert_eq!(check(&h, None, TOKEN, true), Some(Proof::LegacyCookie));
        assert_eq!(check(&h, None, TOKEN, false), None);
    }

    #[test]
    fn the_cookie_cannot_be_sent_cross_site_or_in_the_clear_and_lapses() {
        let set = guest_cookie(TOKEN);
        assert!(set.contains("SameSite=Strict"));
        assert!(set.contains("HttpOnly"));
        assert!(set.contains("Secure"));
        assert!(set.contains("Max-Age=2592000"));
        assert!(
            !set.contains(TOKEN),
            "the raw token never goes in the cookie: {set}"
        );
    }

    #[test]
    fn nothing_proves_nothing() {
        let none = HeaderMap::new();
        assert_eq!(check(&none, None, TOKEN, true), None);
        assert_eq!(check(&none, Some(""), TOKEN, true), None);
        assert_eq!(check(&none, Some("other=1"), TOKEN, true), None);
    }
}
