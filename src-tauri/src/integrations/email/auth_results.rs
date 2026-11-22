//! `Authentication-Results` (RFC 8601) → DKIM, SPF and DMARC outcomes, for
//! showing beside a request on Home's Email requests card.
//!
//! Only the topmost header counts. The receiving server adds its own above
//! whatever came with the message, so a lower one may be the sender's
//! forgery. Nothing here decides whether a request is trusted: that is the
//! Sent-copy check in `requests`.

use serde::{Deserialize, Serialize};

/// One method's outcome, as the card shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum AuthResult {
    Pass,
    /// Any result but pass or none: fail, softfail, neutral, temperror,
    /// permerror, policy, or a DKIM pass for a domain other than the From's.
    Fail,
    /// The header says the method wasn't checked, or doesn't mention it.
    None,
    /// The message carries no `Authentication-Results` at all.
    Absent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AuthResults {
    pub dkim: AuthResult,
    pub spf: AuthResult,
    pub dmarc: AuthResult,
}

impl AuthResults {
    pub const ABSENT: AuthResults = AuthResults {
        dkim: AuthResult::Absent,
        spf: AuthResult::Absent,
        dmarc: AuthResult::Absent,
    };
}

/// Parse the `Authentication-Results` values of one message, in the order
/// they appear in it (topmost first), for a message whose From is in
/// `from_domain`.
pub fn parse(values: &[String], from_domain: &str) -> AuthResults {
    let Some(top) = values.first() else {
        return AuthResults::ABSENT;
    };
    let from_domain = from_domain.trim().to_ascii_lowercase();
    let mut dkim: Option<AuthResult> = None;
    let mut spf: Option<AuthResult> = None;
    let mut dmarc: Option<AuthResult> = None;

    // The first segment is the authserv-id (and maybe a version).
    for segment in strip_comments(top).split(';').skip(1) {
        let mut tokens = segment.split_whitespace();
        let Some((method, result)) = tokens.next().and_then(|t| t.split_once('=')) else {
            continue;
        };
        let method = method.to_ascii_lowercase();
        let result = result.to_ascii_lowercase();
        match method.as_str() {
            "dkim" => {
                let outcome = match result.as_str() {
                    "pass" => {
                        let signer = tokens.find_map(signer_domain);
                        if signer.is_some_and(|d| aligned(&from_domain, &d)) {
                            AuthResult::Pass
                        } else {
                            AuthResult::Fail
                        }
                    }
                    "none" => AuthResult::None,
                    _ => AuthResult::Fail,
                };
                // One aligned passing signature is enough.
                if dkim != Some(AuthResult::Pass) {
                    dkim = Some(match (dkim, outcome) {
                        (_, AuthResult::Pass) => AuthResult::Pass,
                        (Some(AuthResult::Fail), _) => AuthResult::Fail,
                        (_, o) => o,
                    });
                }
            }
            "spf" if spf.is_none() => spf = Some(outcome_of(&result)),
            "dmarc" if dmarc.is_none() => dmarc = Some(outcome_of(&result)),
            _ => {}
        }
    }

    AuthResults {
        dkim: dkim.unwrap_or(AuthResult::None),
        spf: spf.unwrap_or(AuthResult::None),
        dmarc: dmarc.unwrap_or(AuthResult::None),
    }
}

fn outcome_of(result: &str) -> AuthResult {
    match result {
        "pass" => AuthResult::Pass,
        "none" => AuthResult::None,
        _ => AuthResult::Fail,
    }
}

/// The signing domain a DKIM property names: `header.d=example.com`, or the
/// domain of `header.i=@example.com` / `header.i=user@example.com`.
fn signer_domain(token: &str) -> Option<String> {
    let (key, value) = token.split_once('=')?;
    let value = value.trim_matches(|c| c == '"' || c == ';');
    match key.to_ascii_lowercase().as_str() {
        "header.d" => Some(value.to_ascii_lowercase()),
        "header.i" => value.rsplit_once('@').map(|(_, d)| d.to_ascii_lowercase()),
        _ => None,
    }
}

/// Relaxed alignment: the signer is the From's domain or a parent of it.
fn aligned(from_domain: &str, signer: &str) -> bool {
    !signer.is_empty() && (from_domain == signer || from_domain.ends_with(&format!(".{signer}")))
}

/// Drop `( … )` comments, which may hold `;` and `=`. Quoted strings are
/// kept as they are.
fn strip_comments(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut depth = 0u32;
    let mut quoted = false;
    let mut escaped = false;
    for c in v.chars() {
        if escaped {
            escaped = false;
            if depth == 0 {
                out.push(c);
            }
            continue;
        }
        match c {
            '\\' => {
                escaped = true;
                if depth == 0 {
                    out.push(c);
                }
            }
            '"' if depth == 0 => {
                quoted = !quoted;
                out.push(c);
            }
            '(' if !quoted => depth += 1,
            ')' if !quoted && depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use AuthResult::*;

    fn one(v: &str, domain: &str) -> AuthResults {
        parse(&[v.to_string()], domain)
    }

    #[test]
    fn gmail_from_outside_passes_all_three() {
        let v = "mx.google.com;\r\n       dkim=pass header.i=@example.com header.s=s1 header.b=AbC;\r\n       spf=pass (google.com: domain of me@example.com designates 1.2.3.4 as permitted sender; x=y) smtp.mailfrom=me@example.com;\r\n       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com";
        assert_eq!(
            one(v, "example.com"),
            AuthResults {
                dkim: Pass,
                spf: Pass,
                dmarc: Pass
            }
        );
    }

    #[test]
    fn fastmail_style_with_header_d_and_a_subdomain_from() {
        let v = "mx6.messagingengine.com; dkim=pass (2048-bit rsa key sha256) header.d=fastmail.com header.i=@fastmail.com header.b=x; spf=softfail smtp.mailfrom=a@fastmail.com; dmarc=none header.from=mail.fastmail.com";
        assert_eq!(
            one(v, "mail.fastmail.com"),
            AuthResults {
                dkim: Pass,
                spf: Fail,
                dmarc: None
            }
        );
    }

    #[test]
    fn a_dkim_pass_for_another_domain_is_not_a_pass() {
        let v = "mx.example.net; dkim=pass header.d=evil.example header.b=x; spf=pass smtp.mailfrom=evil.example";
        assert_eq!(one(v, "gmail.com").dkim, Fail);
        // A lookalike suffix isn't a parent domain.
        let v = "mx; dkim=pass header.d=ail.com";
        assert_eq!(one(v, "gmail.com").dkim, Fail);
    }

    #[test]
    fn one_aligned_signature_among_several_passes() {
        let v = "mx; dkim=pass header.d=esp.example; dkim=pass header.d=gmail.com; dkim=fail header.d=gmail.com";
        assert_eq!(one(v, "gmail.com").dkim, Pass);
    }

    #[test]
    fn only_the_topmost_header_counts() {
        let forged =
            "mx.google.com; dkim=pass header.d=gmail.com; spf=pass; dmarc=pass".to_string();
        let top = "mx.google.com; dkim=fail header.d=gmail.com; spf=fail; dmarc=fail".to_string();
        assert_eq!(
            parse(&[top, forged], "gmail.com"),
            AuthResults {
                dkim: Fail,
                spf: Fail,
                dmarc: Fail
            }
        );
    }

    #[test]
    fn none_and_missing_methods_read_as_none_and_no_header_as_absent() {
        assert_eq!(
            one("mx.example.com; none", "example.com"),
            AuthResults {
                dkim: None,
                spf: None,
                dmarc: None
            }
        );
        assert_eq!(one("mx; spf=pass", "example.com").dkim, None);
        assert_eq!(parse(&[], "example.com"), AuthResults::ABSENT);
    }

    #[test]
    fn comments_holding_semicolons_and_equals_are_skipped() {
        assert_eq!(
            strip_comments("a (b; c=d (nested)) e \"(kept)\""),
            "a  e \"(kept)\""
        );
    }
}
