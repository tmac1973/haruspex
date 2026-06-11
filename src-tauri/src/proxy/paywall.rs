//! Paywall detection — looks for the sentinel HARUSPEX_PAYWALL_SIGNAL
//! left by the fetcher, plus known paywall fingerprints embedded in
//! the page HTML itself.

pub(crate) const PAYWALL_SENTINEL: &str = "[[HARUSPEX_PAYWALL_SIGNAL]]";

pub(super) fn detect_paywall_signal(html: &str) -> Option<&'static str> {
    let lowered = html.to_lowercase();

    // Compact form collapses all whitespace so JSON keys/values and
    // attribute spacing don't have to match a specific layout.
    let compact: String = lowered.chars().filter(|c| !c.is_whitespace()).collect();

    if compact.contains("\"isaccessibleforfree\":false") {
        return Some("Schema.org isAccessibleForFree=false");
    }

    // OG meta attribute order is arbitrary (`property` before `content`
    // or vice versa). Rather than match the whole tag literally, walk
    // every `<meta ...>` tag and flag it only when BOTH the tier key
    // and a "locked" value live inside the same tag's angle brackets.
    // Restricting to tag boundaries prevents prose that happens to
    // mention both strings from tripping the detector.
    let mut cursor = 0;
    while let Some(rel) = lowered[cursor..].find("<meta") {
        let start = cursor + rel;
        let tag_end = lowered[start..]
            .find('>')
            .map(|e| start + e + 1)
            .unwrap_or(lowered.len());
        let tag = &lowered[start..tag_end];
        if tag.contains("article:content_tier")
            && (tag.contains("\"locked\"") || tag.contains("'locked'"))
        {
            return Some("OpenGraph article:content_tier=locked");
        }
        cursor = tag_end;
    }

    None
}

// Basic positive/negative fixtures (schema.org JSON-LD, OG content_tier,
// free articles) live in `proxy::tests` (mod.rs). These cover the
// tag-boundary scanner edge cases only.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_unterminated_meta_tag() {
        // A truncated page can end mid-tag; the scanner treats end-of-input
        // as the tag boundary rather than skipping the tag.
        let html = r#"<meta property="article:content_tier" content="locked""#;
        assert_eq!(
            detect_paywall_signal(html),
            Some("OpenGraph article:content_tier=locked")
        );
    }

    #[test]
    fn does_not_flag_locked_value_in_a_different_meta_tag() {
        // Key and value must live inside the SAME <meta> tag.
        let html = r#"<meta property="article:content_tier" content="free">
            <meta property="something:else" content="locked">"#;
        assert_eq!(detect_paywall_signal(html), None);
    }

    #[test]
    fn detection_is_case_insensitive() {
        let html = r#"<META PROPERTY="ARTICLE:CONTENT_TIER" CONTENT="LOCKED">"#;
        assert!(detect_paywall_signal(html).is_some());

        let json_ld = r#"<script>{"ISACCESSIBLEFORFREE": FALSE}</script>"#;
        assert!(detect_paywall_signal(json_ld).is_some());
    }

    #[test]
    fn flags_single_quoted_locked_value() {
        let html = "<meta property='article:content_tier' content='locked'>";
        assert!(detect_paywall_signal(html).is_some());
    }

    #[test]
    fn scans_past_earlier_meta_tags() {
        // The locked tier marker is found even when other meta tags precede it.
        let html = r#"<meta charset="utf-8">
            <meta name="viewport" content="width=device-width">
            <meta property="article:content_tier" content="locked">"#;
        assert!(detect_paywall_signal(html).is_some());
    }

    #[test]
    fn empty_input_is_not_flagged() {
        assert_eq!(detect_paywall_signal(""), None);
    }
}
