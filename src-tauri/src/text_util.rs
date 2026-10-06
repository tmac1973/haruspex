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
}
