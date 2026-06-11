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

#[cfg(test)]
mod tests {
    use super::*;

    // -- basic positive/negative fixtures ------------------------------------

    #[test]
    fn detect_paywall_signal_schema_org_is_accessible_for_free() {
        let html = r#"<html><head>
            <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"NewsArticle","isAccessibleForFree":false}
            </script></head><body><p>Short preview.</p></body></html>"#;
        let result = detect_paywall_signal(html);
        assert!(result.is_some());
        assert!(result.unwrap().contains("isAccessibleForFree"));
    }

    #[test]
    fn detect_paywall_signal_schema_org_spaced() {
        // JSON-LD with spacing and mixed-case, as emitted by some CMS.
        let html = r#"<script type="application/ld+json">
            {
                "@type": "NewsArticle",
                "isAccessibleForFree": false
            }
        </script>"#;
        assert!(detect_paywall_signal(html).is_some());
    }

    #[test]
    fn detect_paywall_signal_og_content_tier_locked() {
        let html = r#"<html><head>
            <meta property="article:content_tier" content="locked">
        </head><body>Preview</body></html>"#;
        let result = detect_paywall_signal(html);
        assert!(result.is_some());
        assert!(result.unwrap().contains("content_tier"));
    }

    #[test]
    fn detect_paywall_signal_og_content_tier_reversed_attributes() {
        // Attribute order is arbitrary for OG meta tags.
        let html = r#"<meta content="locked" property="article:content_tier">"#;
        assert!(detect_paywall_signal(html).is_some());
    }

    #[test]
    fn detect_paywall_signal_free_article_not_flagged() {
        let html = r#"<html><head>
            <script type="application/ld+json">
            {"@type":"NewsArticle","isAccessibleForFree":true}
            </script>
            <meta property="article:content_tier" content="free">
        </head><body>Full article body.</body></html>"#;
        assert!(detect_paywall_signal(html).is_none());
    }

    #[test]
    fn detect_paywall_signal_plain_article_not_flagged() {
        let html = r#"<html><body><article>
            <p>A perfectly normal free article with no paywall metadata.</p>
        </article></body></html>"#;
        assert!(detect_paywall_signal(html).is_none());
    }

    #[test]
    fn detect_paywall_signal_content_tier_key_without_locked_value_not_flagged() {
        // A page that mentions the key name in prose or a different
        // config block should not be flagged — the "locked" value has
        // to live within the attribute window.
        let html = r#"<p>The article:content_tier metadata convention is interesting.</p>
            <p>Some systems mark content as "locked" elsewhere on the page.</p>"#;
        assert!(detect_paywall_signal(html).is_none());
    }

    // -- tag-boundary scanner edge cases --------------------------------------

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
