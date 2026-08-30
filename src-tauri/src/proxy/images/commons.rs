//! Wikimedia Commons image search.
//!
//! Two calls: `list=search&srnamespace=6` finds `File:` titles, then
//! `prop=imageinfo` resolves upload URLs and pulls licence and attribution out
//! of `extmetadata`. Behaviour is unchanged from when this was the only image
//! source; it is now one of three behind [`super::proxy_image_search`].
//!
//! Commons remains the strongest source for landmarks, nature and historical
//! subjects, and everything on it is openly licensed.

use super::ImageSearchResult;
use crate::proxy::extract::{strip_html_tags, USER_AGENT};

/// Types the image cache can actually fetch and display, mirroring
/// `image_cache::fetch::ACCEPTED_MIME`.
///
/// Commons' `File:` namespace is not an image library — it holds PDFs, DjVu
/// scans, video and audio, and its full-text search matches words *inside*
/// those documents. A search for "baboon Old World monkey portrait" on
/// 2026-08-30 returned three scanned books and no photograph at all. Offering
/// those to the model wastes result slots on things that could never render.
const DISPLAYABLE_MIME: &[&str] = &["image/jpeg", "image/png", "image/webp", "image/gif"];

/// Search Wikimedia Commons for images matching `query`. Two-call flow:
///
///   1. `list=search&srnamespace=6` → find File:* page titles
///   2. `prop=imageinfo&iiurlwidth=800` → resolve actual upload URLs
///      and extract license / attribution from extmetadata
///
/// Commons is used because all content is openly licensed (public domain
/// or CC family) — embedding those in a generated PPTX is safe from a
/// licensing standpoint. Returns up to `max_results.unwrap_or(5)` items,
/// capped at 20.
pub(super) async fn search(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<ImageSearchResult>, String> {
    use serde_json::Value;

    // Step 1: search for file titles in the File: namespace.
    let search_url = format!(
        "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit={}&srsearch={}",
        limit,
        urlencoding::encode(query)
    );
    let search_resp: Value = client
        .get(&search_url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Commons search request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Commons search JSON parse failed: {}", e))?;

    let titles: Vec<String> = search_resp
        .get("query")
        .and_then(|q| q.get("search"))
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("title").and_then(|t| t.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if titles.is_empty() {
        return Ok(Vec::new());
    }

    // Step 2: resolve URLs + metadata for all matched titles in a single
    // call. Commons accepts up to 50 pipe-separated titles per request;
    // we're already capped at 20 above so this is always one round trip.
    let titles_param = titles.join("|");
    let info_url = format!(
        "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=800&titles={}",
        urlencoding::encode(&titles_param)
    );
    let info_resp: Value = client
        .get(&info_url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Commons imageinfo request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Commons imageinfo JSON parse failed: {}", e))?;

    let results = parse_commons_imageinfo(&info_resp, &titles);
    Ok(results)
}

/// Pull a string value out of Commons' extmetadata shape, which wraps
/// every field in `{ "value": "...", "source": "...", ... }`. Handles
/// both plain-text values and HTML-ish ones (the caller strips tags).
fn commons_extmetadata_string(extmeta: &serde_json::Value, key: &str) -> String {
    extmeta
        .get(key)
        .and_then(|v| v.get("value"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

/// Parse the JSON response from the imageinfo API call into a list of
/// `ImageSearchResult`. Extracted as a free function so it can be unit-
/// tested against hand-rolled JSON fixtures without touching the network.
/// `ordered_titles` preserves the result order from the search step — the
/// Commons API returns `pages` as an unordered map keyed by pageid, so we
/// re-project through the original title order for deterministic output.
pub(crate) fn parse_commons_imageinfo(
    info_resp: &serde_json::Value,
    ordered_titles: &[String],
) -> Vec<ImageSearchResult> {
    let Some(pages) = info_resp
        .get("query")
        .and_then(|q| q.get("pages"))
        .and_then(|p| p.as_object())
    else {
        return Vec::new();
    };

    // Build a lookup from title → page JSON so we can re-project in the
    // original search order.
    let mut by_title: std::collections::HashMap<&str, &serde_json::Value> =
        std::collections::HashMap::new();
    for page in pages.values() {
        if let Some(title) = page.get("title").and_then(|t| t.as_str()) {
            by_title.insert(title, page);
        }
    }

    let mut out = Vec::new();
    for title in ordered_titles {
        let Some(page) = by_title.get(title.as_str()) else {
            continue;
        };
        let Some(info) = page
            .get("imageinfo")
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
        else {
            continue;
        };
        let url = info
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // Commons returns thumburl when iiurlwidth is specified; fall
        // back to the original url if it's missing (e.g. image smaller
        // than the requested thumbnail width).
        let thumb_url = info
            .get("thumburl")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| url.clone());
        let width = info.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let height = info.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let mime = info
            .get("mime")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let description_url = info
            .get("descriptionurl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let extmeta = info.get("extmetadata").cloned().unwrap_or_default();
        let license = commons_extmetadata_string(&extmeta, "LicenseShortName");
        let artist_raw = commons_extmetadata_string(&extmeta, "Artist");
        let attribution = strip_html_tags(&artist_raw);

        if url.is_empty() {
            continue;
        }
        // Drop anything we could not display even if the model picked it:
        // PDFs, DjVu, video, and SVG (which the fetch path refuses because it
        // is script-capable markup rather than raster data).
        if !DISPLAYABLE_MIME.contains(&mime.as_str()) {
            continue;
        }
        out.push(ImageSearchResult {
            title: title.clone(),
            url,
            thumb_url,
            width,
            height,
            mime,
            license,
            attribution,
            description_url,
            source: "commons".to_string(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Commons search matches text *inside* documents, so a query about an
    /// animal readily returns scanned books. Those can never be displayed, so
    /// they must not occupy a result slot.
    #[test]
    fn non_image_files_are_dropped() {
        let json = serde_json::json!({
            "query": { "pages": {
                "1": {
                    "title": "File:Apes and monkeys; their life and language.pdf",
                    "imageinfo": [{
                        "url": "https://upload.wikimedia.org/x.pdf",
                        "thumburl": "https://upload.wikimedia.org/page1-500px-x.pdf.jpg",
                        "width": 718, "height": 1116, "mime": "application/pdf",
                        "descriptionurl": "https://commons.wikimedia.org/wiki/File:x.pdf",
                        "extmetadata": {}
                    }]
                },
                "2": {
                    "title": "File:Real baboon.jpg",
                    "imageinfo": [{
                        "url": "https://upload.wikimedia.org/baboon.jpg",
                        "thumburl": "https://upload.wikimedia.org/960px-baboon.jpg",
                        "width": 4000, "height": 3000, "mime": "image/jpeg",
                        "descriptionurl": "https://commons.wikimedia.org/wiki/File:baboon.jpg",
                        "extmetadata": {}
                    }]
                }
            }}
        });
        let ordered = vec![
            "File:Apes and monkeys; their life and language.pdf".to_string(),
            "File:Real baboon.jpg".to_string(),
        ];
        let out = parse_commons_imageinfo(&json, &ordered);
        assert_eq!(out.len(), 1, "the PDF should have been dropped");
        assert_eq!(out[0].title, "File:Real baboon.jpg");
    }

    /// SVG is refused by the fetch path because it is script-capable markup,
    /// so offering one would produce an image that silently never renders.
    #[test]
    fn svg_is_dropped_because_the_fetcher_refuses_it() {
        let json = serde_json::json!({
            "query": { "pages": { "1": {
                "title": "File:Diagram.svg",
                "imageinfo": [{
                    "url": "https://upload.wikimedia.org/d.svg",
                    "width": 100, "height": 100, "mime": "image/svg+xml",
                    "extmetadata": {}
                }]
            }}}
        });
        let out = parse_commons_imageinfo(&json, &["File:Diagram.svg".to_string()]);
        assert!(out.is_empty());
    }

    #[test]
    fn parse_commons_imageinfo_extracts_fields() {
        // Minimal response shape mimicking the Commons imageinfo API.
        // Includes two pages to verify title-order projection — the
        // Commons `pages` map is unordered, so we rely on the ordered
        // `titles` slice to define result order.
        let json = serde_json::json!({
            "query": {
                "pages": {
                    "99": {
                        "title": "File:Beta.png",
                        "imageinfo": [{
                            "url": "https://upload.wikimedia.org/full/beta.png",
                            "thumburl": "https://upload.wikimedia.org/thumb/beta.png",
                            "width": 1024,
                            "height": 768,
                            "mime": "image/png",
                            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Beta.png",
                            "extmetadata": {
                                "LicenseShortName": { "value": "CC BY-SA 4.0" },
                                "Artist": { "value": "<a href=\"//foo\">Jane Doe</a>" }
                            }
                        }]
                    },
                    "42": {
                        "title": "File:Alpha.jpg",
                        "imageinfo": [{
                            "url": "https://upload.wikimedia.org/full/alpha.jpg",
                            "thumburl": "https://upload.wikimedia.org/thumb/alpha.jpg",
                            "width": 2000,
                            "height": 1500,
                            "mime": "image/jpeg",
                            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Alpha.jpg",
                            "extmetadata": {
                                "LicenseShortName": { "value": "Public domain" },
                                "Artist": { "value": "John Doe" }
                            }
                        }]
                    }
                }
            }
        });
        let ordered = vec!["File:Alpha.jpg".to_string(), "File:Beta.png".to_string()];
        let out = parse_commons_imageinfo(&json, &ordered);
        // Result order matches the ordered titles slice, not the JSON map order.
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, "File:Alpha.jpg");
        assert_eq!(out[0].url, "https://upload.wikimedia.org/full/alpha.jpg");
        assert_eq!(out[0].width, 2000);
        assert_eq!(out[0].license, "Public domain");
        assert_eq!(out[0].attribution, "John Doe");

        assert_eq!(out[1].title, "File:Beta.png");
        assert_eq!(out[1].license, "CC BY-SA 4.0");
        // HTML tags in the Artist field are stripped.
        assert_eq!(out[1].attribution, "Jane Doe");
    }

    #[test]
    fn parse_commons_imageinfo_returns_empty_on_malformed() {
        let empty = serde_json::json!({});
        assert!(parse_commons_imageinfo(&empty, &["File:X.jpg".to_string()]).is_empty());

        let no_imageinfo = serde_json::json!({
            "query": { "pages": { "1": { "title": "File:Y.jpg" } } }
        });
        assert!(parse_commons_imageinfo(&no_imageinfo, &["File:Y.jpg".to_string()]).is_empty());
    }
}
