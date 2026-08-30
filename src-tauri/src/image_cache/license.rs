//! Licence normalisation: turn each source's free-form licence string into a
//! stable code, and decide whether the image may be redistributed inside a
//! document the app generates.
//!
//! Why this is licence-driven rather than source-driven: a 20-result Openverse
//! sample on 2026-08-30 came back `by-nc` ×7, `by-sa` ×6, `by` ×5, `by-nc-nd`
//! ×1, `by-nc-sa` ×1. Over a third carried NC or ND. "Came from Openverse"
//! therefore says nothing useful about what may be done with an image, so
//! `embeddable` is derived from the specific licence every time.
//!
//! The bar for `embeddable` is deliberately conservative. It answers "may this
//! be baked into a file the user might hand to anyone, for any purpose?", so:
//!
//!   - **NC** fails. The user's deck might be commercial and we cannot know.
//!   - **ND** fails. Placing an image into a document scales, crops and
//!     recomposes it, which is exactly what "no derivatives" forbids.
//!   - **Unknown** fails. Absence of evidence is not permission.
//!
//! Nothing in this codebase reads `embeddable` yet. It exists so the later
//! document-embedding work can filter on it without re-fetching or
//! re-classifying anything already cached.

/// What an image's licence permits, plus the normalised code recorded with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LicenseVerdict {
    /// Stable code: `pd`, `cc-by-4.0`, `cc-by-sa-3.0`, `cc-by-nc-2.0`,
    /// `unknown`, … Lowercase, hyphenated, version appended when known.
    pub code: String,
    /// May this be redistributed inside a generated document?
    pub embeddable: bool,
    /// Does displaying it require a visible credit line?
    pub requires_attribution: bool,
}

impl LicenseVerdict {
    fn unknown() -> Self {
        Self {
            code: "unknown".to_string(),
            embeddable: false,
            requires_attribution: false,
        }
    }
}

/// Public-domain markers, matched as whole phrases against the lowercased
/// input. `cc0`, `pdm` and `publicdomain` also appear as bare tokens or inside
/// the licence URLs Openverse returns, so they are checked by substring below.
const PUBLIC_DOMAIN_PHRASES: &[&str] = &[
    "public domain",
    "no known copyright",
    "no restrictions",
    "pd-old",
    "pd-us",
    "pd-self",
];

/// Normalise a licence string from any source.
///
/// `raw` is whatever the source gave us: Openverse's short codes (`by-sa`),
/// Commons' `extmetadata` names (`CC BY-SA 4.0`, `Public domain`), or nothing
/// at all. `version` is Openverse's separate `license_version` field; Commons
/// bakes the version into the name, so it passes `None`.
pub fn normalize(raw: Option<&str>, version: Option<&str>) -> LicenseVerdict {
    let Some(raw) = raw else {
        return LicenseVerdict::unknown();
    };
    let lower = raw.trim().to_lowercase();
    if lower.is_empty() {
        return LicenseVerdict::unknown();
    }

    // Public domain and CC0 first: they are the only cases that need no
    // credit, and `cc0` would otherwise fall through the CC matcher below
    // as an unrecognised variant.
    if lower.contains("cc0")
        || lower.contains("publicdomain")
        || lower.contains("pdm")
        || PUBLIC_DOMAIN_PHRASES.iter().any(|p| lower.contains(p))
    {
        return LicenseVerdict {
            code: "pd".to_string(),
            embeddable: true,
            requires_attribution: false,
        };
    }

    // Everything else we recognise is a Creative Commons attribution licence.
    // Detect the clauses independently rather than matching whole strings, so
    // `by-nc-nd`, `CC BY-NC-ND 4.0` and `cc-by-nc-nd` all land the same way.
    let is_cc = lower.contains("cc") || lower.starts_with("by");
    if !is_cc || !has_by_clause(&lower) {
        // A real licence string we do not understand. Keep it verbatim so a
        // later pass can improve this mapping against data we have actually
        // seen, rather than discarding the evidence.
        return LicenseVerdict {
            code: raw.trim().to_lowercase(),
            embeddable: false,
            requires_attribution: true,
        };
    }

    let nc = has_clause(&lower, "nc");
    let nd = has_clause(&lower, "nd");
    let sa = has_clause(&lower, "sa");

    let mut code = String::from("cc-by");
    if nc {
        code.push_str("-nc");
    }
    if nd {
        code.push_str("-nd");
    } else if sa {
        // SA and ND are mutually exclusive in the CC suite; if a string
        // somehow claims both, ND is the stricter reading and wins.
        code.push_str("-sa");
    }
    if let Some(v) = license_version(&lower, version) {
        code.push('-');
        code.push_str(&v);
    }

    LicenseVerdict {
        // NC forbids the commercial use we cannot rule out; ND forbids the
        // adaptation that placing an image in a document performs.
        embeddable: !nc && !nd,
        requires_attribution: true,
        code,
    }
}

/// The `page_og` verdict, applied to anything scraped from a page.
///
/// A page's `og:image` carries no licence information whatsoever, and whatever
/// the page says about itself is not evidence about the image. Scraped images
/// are display-only, always — which is what makes the future document path
/// safe by construction rather than by remembering to check.
pub fn scraped() -> LicenseVerdict {
    LicenseVerdict::unknown()
}

/// Is one of the CC clause tokens present as a token rather than as a
/// substring of a longer word? Guards against `nd` matching "and", `sa`
/// matching "Sample", and similar.
fn has_clause(lower: &str, clause: &str) -> bool {
    lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|tok| {
            tok == clause
            // Openverse concatenates clauses in one token: `by-nc-nd` splits
            // cleanly, but some sources emit `byncnd`.
            || (tok.starts_with("by") && tok.len() > 2 && contains_clause_run(tok, clause))
        })
}

fn contains_clause_run(token: &str, clause: &str) -> bool {
    token.as_bytes()[2..]
        .chunks(2)
        .any(|c| c == clause.as_bytes())
}

fn has_by_clause(lower: &str) -> bool {
    lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|tok| tok == "by" || (tok.starts_with("by") && tok.len() > 2))
}

/// Pull a version like `4.0` out of the licence string, falling back to the
/// source's separate version field.
fn license_version(lower: &str, version: Option<&str>) -> Option<String> {
    let from_string = lower
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|tok| tok.contains('.') && tok.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_string);
    from_string.or_else(|| {
        version
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact strings the live APIs returned on 2026-08-30. If a source
    /// changes its vocabulary this is what should fail first.
    #[test]
    fn openverse_codes_observed_in_the_wild() {
        // by / by-sa are embeddable with credit.
        for (raw, ver, code) in [
            ("by", Some("2.0"), "cc-by-2.0"),
            ("by-sa", Some("4.0"), "cc-by-sa-4.0"),
        ] {
            let v = normalize(Some(raw), ver);
            assert_eq!(v.code, code, "code for {raw}");
            assert!(v.embeddable, "{raw} should be embeddable");
            assert!(v.requires_attribution, "{raw} needs credit");
        }

        // Anything carrying NC or ND is display-only. This is the assertion
        // that keeps the future document path safe.
        for (raw, ver, code) in [
            ("by-nc", Some("2.0"), "cc-by-nc-2.0"),
            ("by-nd", Some("2.0"), "cc-by-nd-2.0"),
            ("by-nc-nd", Some("4.0"), "cc-by-nc-nd-4.0"),
            ("by-nc-sa", Some("3.0"), "cc-by-nc-sa-3.0"),
        ] {
            let v = normalize(Some(raw), ver);
            assert_eq!(v.code, code, "code for {raw}");
            assert!(!v.embeddable, "{raw} must NOT be embeddable");
        }
    }

    #[test]
    fn commons_style_names() {
        let v = normalize(Some("CC BY-SA 4.0"), None);
        assert_eq!(v.code, "cc-by-sa-4.0");
        assert!(v.embeddable);

        let v = normalize(Some("CC BY-NC-ND 3.0"), None);
        assert!(!v.embeddable);
    }

    #[test]
    fn public_domain_needs_no_credit() {
        for raw in [
            "Public domain",
            "CC0",
            "cc0 1.0",
            "PDM 1.0",
            "No known copyright",
        ] {
            let v = normalize(Some(raw), None);
            assert_eq!(v.code, "pd", "code for {raw}");
            assert!(v.embeddable, "{raw} should be embeddable");
            assert!(!v.requires_attribution, "{raw} needs no credit");
        }
    }

    #[test]
    fn missing_or_empty_is_unknown_and_not_embeddable() {
        for raw in [None, Some(""), Some("   ")] {
            let v = normalize(raw, None);
            assert_eq!(v.code, "unknown");
            assert!(!v.embeddable);
        }
    }

    #[test]
    fn unrecognised_licence_is_kept_verbatim_and_not_embeddable() {
        let v = normalize(Some("Some Bespoke Museum Licence"), None);
        assert_eq!(v.code, "some bespoke museum licence");
        assert!(!v.embeddable);
    }

    #[test]
    fn scraped_images_are_never_embeddable() {
        let v = scraped();
        assert_eq!(v.code, "unknown");
        assert!(!v.embeddable);
        assert!(!v.requires_attribution);
    }

    /// `nd` inside "and" and `sa` inside "Sample" must not read as clauses.
    #[test]
    fn clause_detection_is_token_aware() {
        let v = normalize(Some("CC BY 4.0 and friends"), None);
        assert_eq!(v.code, "cc-by-4.0");
        assert!(v.embeddable, "the 'and' must not read as an ND clause");
    }
}
