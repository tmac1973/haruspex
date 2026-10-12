//! Small string helpers shared across modules.

/// Truncate `s` to at most `max_bytes` bytes without splitting a UTF-8
/// code point. Slicing `&s[..max_bytes]` directly panics when a
/// multi-byte character straddles the cut — and most truncation sites
/// here cut model- or document-derived text where emoji/CJK are routine.
pub fn truncate_at_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Cap on text extracted from a document (PDF / xlsx) before it's handed
/// to the model, so one huge extraction can't blow up the context window.
pub const MAX_EXTRACTED_TEXT_CHARS: usize = 500_000;

/// If `s` exceeds `max_bytes` bytes, return a truncated copy (cut on a
/// char boundary via [`truncate_at_char_boundary`]) with a trailing note
/// stating the original size; otherwise return `None` so the caller can
/// keep its existing allocation.
pub fn truncate_with_note(s: &str, max_bytes: usize) -> Option<String> {
    if s.len() <= max_bytes {
        return None;
    }
    Some(format!(
        "{}\n\n[... truncated: {} characters total, showing first {}]",
        truncate_at_char_boundary(s, max_bytes),
        s.len(),
        max_bytes
    ))
}

/// If `s` has more than `max_chars` characters, keep the first `max_chars` and
/// append `marker`; otherwise return `s` unchanged. Truncates in place (reusing
/// the allocation) and stops scanning once past the cut, so a huge string isn't
/// fully walked or re-collected to keep a small prefix. Cuts on a `char`
/// boundary so multibyte text is never split mid-codepoint.
pub fn truncate_chars(mut s: String, max_chars: usize, marker: &str) -> String {
    // `nth(max_chars)` is the byte offset of the first char beyond the cap, and
    // is `None` (no truncation) when `s` has `<= max_chars` chars.
    if let Some((idx, _)) = s.char_indices().nth(max_chars) {
        s.truncate(idx);
        s.push_str(marker);
    }
    s
}

/// What a hand-written `Debug` prints in place of a secret: whether one is
/// set, never what it is.
pub fn redacted(secret: &str) -> &'static str {
    if secret.is_empty() {
        "<empty>"
    } else {
        "<redacted>"
    }
}

/// The part of a URL that is safe to log: scheme and host, nothing else.
/// Paths and query strings carry search terms, signed tokens and personal
/// data, and the app log goes into the feedback bundle users attach to public
/// issues.
pub fn url_for_log(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => match u.host_str() {
            Some(host) => format!("{}://{host}", u.scheme()),
            None => format!("{}:", u.scheme()),
        },
        Err(_) => "<unparsable url>".to_string(),
    }
}

/// What replaces a secret in text that leaves a process: an error shown in
/// Settings, a line in the app log (which goes into the diagnostics bundle).
pub const REDACTED: &str = "[redacted]";

/// Words that mark the value after them as a credential: `password=…`,
/// `"api_key": "…"`, `Authorization: …`.
const SECRET_KEY_WORDS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "apikey",
    "api_key",
    "api-key",
    "authorization",
    "auth",
    "credential",
    "cookie",
];

/// Prefixes of credentials that look like nothing else: GitHub, OpenAI and
/// Anthropic, Slack, GitLab, AWS, Hugging Face, Google.
const TOKEN_PREFIXES: &[&str] = &[
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "sk-",
    "sk_live_",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxs-",
    "glpat-",
    "AKIA",
    "hf_",
    "ya29.",
    // Haruspex's own remote-control device tokens (`owner::clients`).
    "hsx_",
];

/// `text` with anything that looks like a credential replaced by [`REDACTED`]:
/// each of `known` (values we handed the program, at least 6 characters),
/// URL userinfo (`https://user:pass@host`), the value after `Bearer` or after
/// a key named like a secret (`token=…`, `"password": "…"`), and words with a
/// well-known token prefix. For third-party output — an MCP server's stderr —
/// that ends up in an error or the log. Best effort: it catches the shapes
/// credentials usually take, not every possible one.
pub fn redact_secrets(text: &str, known: &[String]) -> String {
    let mut out = text.to_string();
    for k in known.iter().filter(|k| k.chars().count() >= 6) {
        out = out.replace(k.as_str(), REDACTED);
    }
    out = redact_userinfo(&out);
    let mut result = String::with_capacity(out.len());
    let mut redact_next = false;
    for piece in out.split_inclusive(char::is_whitespace) {
        let word = piece.trim_end_matches(char::is_whitespace);
        let space = &piece[word.len()..];
        if word.is_empty() {
            result.push_str(piece);
            continue;
        }
        let (redacted, then_next) = redact_word(word, redact_next);
        redact_next = then_next;
        result.push_str(&redacted);
        result.push_str(space);
    }
    result
}

/// One whitespace-separated word, and whether the word after it is a value
/// to redact (`Bearer`, `password:`, `"token":`).
fn redact_word(word: &str, is_value: bool) -> (String, bool) {
    let bare = word.trim_matches(|c: char| "\"'`,;()[]{}<>".contains(c));
    // The scheme word stays and hands the redaction on: `Authorization:
    // Bearer <token>` and plain `Bearer <token>` both end on the token.
    if bare.eq_ignore_ascii_case("bearer") || bare.eq_ignore_ascii_case("basic") {
        return (word.to_string(), true);
    }
    if is_value && !bare.is_empty() {
        return (word.replacen(bare, REDACTED, 1), false);
    }
    if TOKEN_PREFIXES.iter().any(|p| bare.starts_with(p)) && bare.len() >= 16 {
        return (word.replacen(bare, REDACTED, 1), false);
    }
    // `key=value` / `key:value` in one word; `key=` / `key:` with the value
    // in the next.
    if let Some(i) = bare.rfind(['=', ':']) {
        let (key, value) = (&bare[..i], &bare[i + 1..]);
        if names_a_secret(key) {
            if value.is_empty() {
                return (word.to_string(), true);
            }
            if !value.starts_with("//") {
                return (word.replacen(value, REDACTED, 1), false);
            }
        }
    }
    (word.to_string(), false)
}

fn names_a_secret(key: &str) -> bool {
    let key = key
        .trim_matches(|c: char| "\"'`".contains(c))
        .to_ascii_lowercase();
    // The last segment: `https://x/mcp?api_key`, `env.GITHUB_TOKEN`.
    let tail = key
        .rsplit(['?', '&', '.', '/', '"', '\''])
        .next()
        .unwrap_or(&key);
    SECRET_KEY_WORDS.iter().any(|w| tail.contains(w))
}

/// A message from someone else's server (Google's `error_description`, an
/// API's `error.message`) made fit to show in an error: control characters
/// and runs of whitespace become single spaces, anything that looks like a
/// credential is redacted, and it is cut to `max_chars`.
pub fn upstream_message(text: &str, max_chars: usize) -> String {
    let flat = text
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    truncate_chars(redact_secrets(&flat, &[]), max_chars, "…")
}

/// `scheme://user:pass@host` → `scheme://[redacted]@host`.
fn redact_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        out.push_str(&rest[..i + 3]);
        rest = &rest[i + 3..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '/' || c == '"' || c == '\'')
            .unwrap_or(rest.len());
        if let Some(at) = rest[..end].rfind('@') {
            if rest[..at].contains(':') {
                out.push_str(REDACTED);
                rest = &rest[at..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn url_for_log_keeps_only_scheme_and_host() {
        assert_eq!(
            url_for_log("https://user:pw@example.com:8443/a/b?token=x#frag"),
            "https://example.com"
        );
        assert_eq!(url_for_log("javascript:alert(1)"), "javascript:");
        assert_eq!(url_for_log("not a url"), "<unparsable url>");
    }

    use super::*;

    #[test]
    fn shorter_input_is_untouched() {
        assert_eq!(truncate_at_char_boundary("abc", 10), "abc");
        assert_eq!(truncate_at_char_boundary("abc", 3), "abc");
    }

    #[test]
    fn ascii_cuts_exactly() {
        assert_eq!(truncate_at_char_boundary("abcdef", 4), "abcd");
    }

    #[test]
    fn backs_off_mid_codepoint() {
        // 'é' is 2 bytes; cutting at byte 1 must back off to 0
        assert_eq!(truncate_at_char_boundary("é", 1), "");
        // "aé" = 3 bytes; cutting at 2 lands mid-'é' → back off to "a"
        assert_eq!(truncate_at_char_boundary("aé", 2), "a");
    }

    #[test]
    fn emoji_boundary_regression() {
        // 4-byte emoji at every offset of the cut
        let s = "ab😀cd";
        for max in 0..=s.len() {
            let out = truncate_at_char_boundary(s, max);
            assert!(out.len() <= max);
            assert!(s.starts_with(out));
        }
    }

    #[test]
    fn empty_input() {
        assert_eq!(truncate_at_char_boundary("", 5), "");
    }

    #[test]
    fn truncate_with_note_passes_short_input_through() {
        assert_eq!(truncate_with_note("abc", 10), None);
        assert_eq!(truncate_with_note("abc", 3), None);
    }

    #[test]
    fn truncate_with_note_appends_size_note() {
        let out = truncate_with_note("abcdef", 4).unwrap();
        assert_eq!(
            out,
            "abcd\n\n[... truncated: 6 characters total, showing first 4]"
        );
    }

    #[test]
    fn truncate_with_note_respects_char_boundaries() {
        // "aé" = 3 bytes; cutting at 2 lands mid-'é' → back off to "a".
        let out = truncate_with_note("aéxx", 2).unwrap();
        assert!(out.starts_with("a\n\n[... truncated:"));
    }

    #[test]
    fn known_values_and_token_shapes_are_redacted() {
        use super::{redact_secrets, REDACTED};
        let known = vec!["s3cr3t-value".to_string(), "abc".to_string()];
        let cases = [
            (
                "auth failed for s3cr3t-value",
                format!("auth failed for {REDACTED}"),
            ),
            // Too short to be worth matching on its own.
            ("abc ok", "abc ok".to_string()),
            (
                "GET https://bob:hunter2@proxy:3128/x",
                format!("GET https://{REDACTED}@proxy:3128/x"),
            ),
            (
                "Authorization: Bearer eyJhbGciOi.x.y",
                format!("Authorization: Bearer {REDACTED}"),
            ),
            ("password=hunter2 next", format!("password={REDACTED} next")),
            (
                r#"{"api_key": "k-123456", "n": 1}"#,
                format!(r#"{{"api_key": "{REDACTED}", "n": 1}}"#),
            ),
            ("token: abcdef", format!("token: {REDACTED}")),
            (
                "GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaa",
                format!("GITHUB_TOKEN={REDACTED}"),
            ),
            (
                "bad key ghp_aaaaaaaaaaaaaaaaaaaa here",
                format!("bad key {REDACTED} here"),
            ),
            (
                "https://x/mcp?api_key=zzz9",
                format!("https://x/mcp?api_key={REDACTED}"),
            ),
        ];
        for (input, want) in cases {
            assert_eq!(redact_secrets(input, &known), want, "{input}");
        }
    }

    #[test]
    fn ordinary_output_is_left_alone() {
        use super::redact_secrets;
        for line in [
            "Error: ENOENT: no such file or directory, open '/tmp/x.json'",
            "listening on http://127.0.0.1:3000/mcp",
            "  at Object.<anonymous> (/srv/index.js:12:5)",
            "skipping sk-short",
        ] {
            assert_eq!(redact_secrets(line, &[]), line);
        }
    }
}
