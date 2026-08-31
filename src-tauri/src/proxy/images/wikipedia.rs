//! Wikipedia lead images.
//!
//! Different in kind from a Commons file search: this asks "what picture does
//! the article about X use?", which is usually the single most representative
//! image of a named thing. Spot-checked on 2026-08-30, `Red_panda`,
//! `Tesla_Model_3`, `Ada_Lovelace`, `Kyoto` and `ThinkPad` all returned strong
//! photographs where a Commons keyword search returns a scattering of loosely
//! related files.
//!
//! # The non-free trap
//!
//! `Eiffel_Tower` returns a **logo** hosted at
//! `upload.wikimedia.org/wikipedia/en/…`. That path is the English Wikipedia's
//! *local* upload namespace, which exists precisely to hold files that cannot
//! live on Commons — overwhelmingly non-free logos and covers used under
//! fair-use rationales that do not extend to redistribution by us.
//!
//! So this module accepts `/wikipedia/commons/` and discards everything else.
//! It is the most important rule in the file: without it the app would cache
//! and display copyrighted logos as if they were freely licensed.

use super::ImageSearchResult;
use crate::proxy::extract::USER_AGENT;
use log::debug;
use serde_json::Value;

/// The only image host path we accept. See the module docs.
const COMMONS_PREFIX: &str = "https://upload.wikimedia.org/wikipedia/commons/";

pub(super) async fn search(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<ImageSearchResult>, String> {
    let title = to_page_title(query);
    let url = format!(
        "https://en.wikipedia.org/api/rest_v1/page/summary/{}",
        urlencoding::encode(&title)
    );
    let response = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Wikipedia request failed: {}", e))?;

    // No such article. Common and uninteresting — most queries are not page
    // titles — so it contributes nothing rather than failing the search.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        debug!("no wikipedia page for {:?}", title);
        return Ok(Vec::new());
    }
    if !response.status().is_success() {
        return Err(format!("Wikipedia returned {}", response.status()));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Wikipedia JSON parse failed: {}", e))?;
    Ok(parse(&body))
}

/// `red panda` → `Red_panda`. The REST endpoint wants an article title, and
/// underscores are what it uses for spaces.
fn to_page_title(query: &str) -> String {
    query.trim().replace(' ', "_")
}

/// Free function so the accept rule is testable against fixtures with no
/// network — and it is the rule most worth testing in this module.
pub(super) fn parse(body: &Value) -> Vec<ImageSearchResult> {
    let Some(original) = body
        .get("originalimage")
        .and_then(|i| i.get("source"))
        .and_then(|s| s.as_str())
    else {
        return Vec::new();
    };

    // The non-free trap. Anything not served from the Commons namespace is
    // discarded outright rather than displayed with an unknown licence.
    if !original.starts_with(COMMONS_PREFIX) {
        debug!("discarding non-Commons wikipedia lead image: {}", original);
        return Vec::new();
    }

    let title = body
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    let thumb_url = body
        .get("thumbnail")
        .and_then(|t| t.get("source"))
        .and_then(|s| s.as_str())
        .map(String::from)
        .unwrap_or_else(|| original.to_string());

    vec![ImageSearchResult {
        title,
        url: original.to_string(),
        thumb_url,
        width: body
            .get("originalimage")
            .and_then(|i| i.get("width"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        height: body
            .get("originalimage")
            .and_then(|i| i.get("height"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        mime: String::new(),
        // The file is on Commons but this endpoint does not report its
        // licence. Left empty rather than guessed: the licence normaliser
        // turns that into `unknown`, which is display-only — the honest
        // outcome, since we genuinely do not know.
        license: String::new(),
        attribution: String::new(),
        description_url: body
            .get("content_urls")
            .and_then(|c| c.get("desktop"))
            .and_then(|d| d.get("page"))
            .and_then(|p| p.as_str())
            .unwrap_or_default()
            .to_string(),
        source: "wikipedia".to_string(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(image_url: &str) -> Value {
        serde_json::json!({
            "title": "Test Page",
            "originalimage": { "source": image_url, "width": 800, "height": 600 },
            "thumbnail": { "source": image_url, "width": 320, "height": 240 },
            "content_urls": { "desktop": { "page": "https://en.wikipedia.org/wiki/Test_Page" } }
        })
    }

    /// The shape `Red_panda`, `Kyoto`, `Ada_Lovelace` and `ThinkPad` all
    /// returned on 2026-08-30.
    #[test]
    fn accepts_a_commons_hosted_lead_image() {
        let out = parse(&summary(
            "https://upload.wikimedia.org/wikipedia/commons/thumb/f/fd/Red_Panda.jpg/800px.jpg",
        ));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, "wikipedia");
        assert_eq!(out[0].title, "Test Page");
        assert_eq!(
            out[0].description_url,
            "https://en.wikipedia.org/wiki/Test_Page"
        );
    }

    /// The Eiffel_Tower case, and the reason this filter exists: en-wiki local
    /// uploads are overwhelmingly non-free logos under fair-use rationales
    /// that do not let us redistribute them.
    #[test]
    fn discards_a_non_free_en_wiki_local_upload() {
        let out = parse(&summary(
            "https://upload.wikimedia.org/wikipedia/en/thumb/b/ba/Eiffel_Tower_logo.svg/330px.png",
        ));
        assert!(
            out.is_empty(),
            "an en-wiki local upload must never be offered"
        );
    }

    #[test]
    fn discards_anything_hosted_somewhere_else_entirely() {
        for url in [
            "https://example.com/not-wikimedia.jpg",
            "http://upload.wikimedia.org/wikipedia/commons/x.jpg",
            "https://upload.wikimedia.org.evil.test/wikipedia/commons/x.jpg",
        ] {
            assert!(parse(&summary(url)).is_empty(), "should discard {url}");
        }
    }

    #[test]
    fn a_page_with_no_lead_image_yields_nothing() {
        assert!(parse(&serde_json::json!({"title": "No Picture"})).is_empty());
        assert!(parse(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn licence_is_left_unknown_rather_than_guessed() {
        let out = parse(&summary(
            "https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg",
        ));
        assert_eq!(out[0].license, "");
    }

    #[test]
    fn spaces_become_underscores_for_the_article_lookup() {
        assert_eq!(to_page_title("red panda"), "red_panda");
        assert_eq!(to_page_title("  Ada Lovelace  "), "Ada_Lovelace");
    }
}
