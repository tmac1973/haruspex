//! Openverse image search.
//!
//! Roughly 700 million openly-licensed images aggregated from Flickr,
//! Wikimedia, museum collections and more. No API key, which is why it is here:
//! the Brave and SearXNG paths serve a small minority of users, and anything
//! built for images has to work on the free default.
//!
//! Verified anonymously on 2026-08-30: `GET /v1/images/?q=red+panda` returned
//! HTTP 200 with 240 results carrying `license`, `license_version`, `creator`
//! and `foreign_landing_url` — everything an attribution caption needs.
//!
//! Openverse rate-limits anonymous callers. A 429 is normal operation, not a
//! fault: it contributes no results and the merged search carries on with the
//! other two sources.

use super::ImageSearchResult;
use crate::proxy::extract::USER_AGENT;
use log::debug;
use serde_json::Value;

const ENDPOINT: &str = "https://api.openverse.org/v1/images/";

pub(super) async fn search(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<ImageSearchResult>, String> {
    let url = format!(
        "{ENDPOINT}?q={}&page_size={}",
        urlencoding::encode(query),
        limit
    );
    let response = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Openverse request failed: {}", e))?;

    // Anonymous quota exhausted. Expected, and not the caller's problem.
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        debug!("openverse rate-limited; contributing no results");
        return Ok(Vec::new());
    }
    if !response.status().is_success() {
        return Err(format!("Openverse returned {}", response.status()));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Openverse JSON parse failed: {}", e))?;
    Ok(parse(&body))
}

/// Free function so the shape is testable against a recorded fixture with no
/// network.
pub(super) fn parse(body: &Value) -> Vec<ImageSearchResult> {
    let Some(results) = body.get("results").and_then(|r| r.as_array()) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for item in results {
        let url = item
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if url.is_empty() {
            continue;
        }

        // Openverse's `thumbnail` is its own proxy endpoint. Preferred because
        // it is consistently sized; the full URL stands in when absent.
        let thumb_url = item
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| url.clone());

        // `license` is a bare code (`by-sa`) with the version in a separate
        // field. Rejoin them so the licence normaliser sees one string of the
        // same shape Commons produces.
        let license = match (
            item.get("license").and_then(|v| v.as_str()),
            item.get("license_version").and_then(|v| v.as_str()),
        ) {
            (Some(code), Some(ver)) if !ver.is_empty() => format!("{code} {ver}"),
            (Some(code), _) => code.to_string(),
            (None, _) => String::new(),
        };

        out.push(ImageSearchResult {
            title: item
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            url,
            thumb_url,
            width: item.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            height: item.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            mime: String::new(),
            license,
            attribution: item
                .get("creator")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            description_url: item
                .get("foreign_landing_url")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            source: "openverse".to_string(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real response captured on 2026-08-30.
    fn fixture() -> Value {
        serde_json::json!({
            "result_count": 240,
            "results": [
                {
                    "title": "Red Panda",
                    "url": "https://live.staticflickr.com/4048/4597717451_08728db720_b.jpg",
                    "thumbnail": "https://api.openverse.org/v1/images/7f40b358/thumb/",
                    "license": "by-nd",
                    "license_version": "2.0",
                    "creator": "Chester Zoo",
                    "foreign_landing_url": "https://www.flickr.com/photos/8488209@N07/4597717451",
                    "width": 1024,
                    "height": 685
                },
                {
                    "title": "Panda",
                    "url": "https://example.org/panda.jpg",
                    "license": "by-sa",
                    "license_version": "4.0",
                    "creator": "Someone",
                    "foreign_landing_url": "https://example.org/panda",
                    "width": 800,
                    "height": 600
                }
            ]
        })
    }

    #[test]
    fn parses_the_fields_an_attribution_caption_needs() {
        let out = parse(&fixture());
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, "Red Panda");
        assert_eq!(out[0].attribution, "Chester Zoo");
        assert_eq!(
            out[0].description_url,
            "https://www.flickr.com/photos/8488209@N07/4597717451"
        );
        assert_eq!(out[0].source, "openverse");
    }

    /// The code and version arrive separately; rejoining them is what lets the
    /// licence normaliser produce `cc-by-nd-2.0` rather than losing the
    /// version.
    #[test]
    fn licence_code_and_version_are_rejoined() {
        let out = parse(&fixture());
        assert_eq!(out[0].license, "by-nd 2.0");
        assert_eq!(out[1].license, "by-sa 4.0");
    }

    #[test]
    fn falls_back_to_the_full_url_when_no_thumbnail_is_offered() {
        let out = parse(&fixture());
        assert_eq!(out[1].thumb_url, out[1].url);
    }

    #[test]
    fn tolerates_a_malformed_or_empty_body() {
        assert!(parse(&serde_json::json!({})).is_empty());
        assert!(parse(&serde_json::json!({"results": []})).is_empty());
        // An entry with no URL is unusable and is skipped rather than
        // returned with an empty src.
        assert!(parse(&serde_json::json!({"results": [{"title": "no url"}]})).is_empty());
    }
}
