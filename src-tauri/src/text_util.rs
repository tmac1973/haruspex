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

#[cfg(test)]
mod tests {
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
}
