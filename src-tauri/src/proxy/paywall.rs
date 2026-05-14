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
