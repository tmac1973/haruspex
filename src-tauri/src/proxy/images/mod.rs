//! Image sourcing: a per-page scraper (`extract_page_images`) and the
//! multi-source search behind the `image_search` tool.
//!
//! [`proxy_image_search`] queries Openverse, Commons and Wikipedia
//! concurrently and interleaves the results. It is one Tauri command and one
//! model-facing tool no matter how many sources sit behind it — every tool
//! added to the schema costs quality on the small models this project targets,
//! so the source list grows here and never in the tool list.

mod commons;
mod openverse;
mod wikipedia;

use super::extract::validate_url;
use super::ProxyConfig;
use log::info;
use scraper::{Html, Selector};
use serde::Serialize;

/// One image found on a page. `width` and `height` come from the HTML
/// attributes when present — many modern pages omit them, relying on CSS — so
/// they are optional. `src` is always absolute: relative URLs are resolved
/// against the page URL before they leave `fetch_url_images`.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct PageImage {
    pub src: String,
    pub alt: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Fetch a web page and extract up to 50 image URLs from its HTML.
/// Sources scanned, in order:
///
///   1. `<meta property="og:image">` — usually the page's hero image
///      and often the highest quality single URL.
///   2. `<link rel="image_src">` — legacy but some sites still emit it.
///   3. `<img src="...">` — everything visible in the body.
///
/// Relative `src` values are resolved against the page URL. Obviously
/// decorative entries are dropped: empty `src`, `data:` URLs under 500
/// bytes (tracking pixels, tiny icons), and `src` values that don't
/// parse as a valid URL after resolution.
///
/// The model uses this in combination with `fs_download_url` to fetch
/// manufacturer product shots or other page-hosted imagery and embed
/// them in a generated presentation. See the tool description for the
/// licensing caveat (results are NOT guaranteed to be free-to-use).
#[tauri::command]
pub async fn proxy_fetch_url_images(
    url: String,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<PageImage>, String> {
    validate_url(&url)?;
    info!("fetch_url_images: {}", url);

    let client = super::extract::build_fetch_client(proxy.as_ref())?;

    let response = super::extract::fetch_ok(&client, &url).await?;

    // Capture the final URL after any redirects so we resolve relative
    // `src` attributes against the page the browser actually landed on,
    // not the URL we originally requested.
    let base_url = response.url().clone();

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !content_type.contains("text/html") && !content_type.contains("application/xhtml") {
        return Err(format!(
            "Content type not HTML ({}); nothing to scan for images.",
            content_type
        ));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    Ok(extract_page_images(&html, &base_url))
}

/// Parse `html` and return up to 50 deduplicated image references.
/// Extracted as a standalone function so it can be unit-tested against
/// HTML fixtures without touching the network.
pub(super) fn extract_page_images(html: &str, base_url: &url::Url) -> Vec<PageImage> {
    const MAX_RESULTS: usize = 50;
    // Minimum size for a data: URL to be worth returning. Below this
    // it's almost certainly a tracking pixel or decorative sprite.
    const MIN_DATA_URL_BYTES: usize = 500;

    let doc = Html::parse_document(html);
    let mut seen_srcs: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<PageImage> = Vec::new();

    // Helper: resolve a raw src against the page base, validate, dedup.
    let mut push_candidate = |src: &str, alt: &str, width: Option<u32>, height: Option<u32>| {
        if out.len() >= MAX_RESULTS {
            return;
        }
        let raw = src.trim();
        if raw.is_empty() {
            return;
        }

        // Reject tiny data: URLs outright (tracking pixels / blank
        // placeholders). Larger data URLs could be legitimate inline
        // photos, so we keep those.
        if raw.starts_with("data:") {
            if raw.len() < MIN_DATA_URL_BYTES {
                return;
            }
            if !seen_srcs.insert(raw.to_string()) {
                return;
            }
            out.push(PageImage {
                src: raw.to_string(),
                alt: alt.to_string(),
                width,
                height,
            });
            return;
        }

        // Resolve relative URLs against the page base. Skip anything
        // that doesn't parse or ends up with an unsupported scheme.
        let absolute = match base_url.join(raw) {
            Ok(u) => u,
            Err(_) => return,
        };
        match absolute.scheme() {
            "http" | "https" => {}
            _ => return,
        }
        let abs_string: String = absolute.into();
        if !seen_srcs.insert(abs_string.clone()) {
            return;
        }
        out.push(PageImage {
            src: abs_string,
            alt: alt.to_string(),
            width,
            height,
        });
    };

    // 1) og:image meta tag — often the hero/best single image
    if let Ok(sel) = Selector::parse(r#"meta[property="og:image"]"#) {
        for el in doc.select(&sel) {
            if let Some(content) = el.value().attr("content") {
                push_candidate(content, "og:image", None, None);
            }
        }
    }
    // Also twitter:image, same idea
    if let Ok(sel) = Selector::parse(r#"meta[name="twitter:image"]"#) {
        for el in doc.select(&sel) {
            if let Some(content) = el.value().attr("content") {
                push_candidate(content, "twitter:image", None, None);
            }
        }
    }
    // 2) link rel=image_src — legacy discovery hint
    if let Ok(sel) = Selector::parse(r#"link[rel="image_src"]"#) {
        for el in doc.select(&sel) {
            if let Some(href) = el.value().attr("href") {
                push_candidate(href, "image_src", None, None);
            }
        }
    }
    // 3) body <img src="...">
    if let Ok(sel) = Selector::parse("img") {
        for el in doc.select(&sel) {
            let Some(src) = el.value().attr("src") else {
                continue;
            };
            let alt = el.value().attr("alt").unwrap_or("");
            let width = el
                .value()
                .attr("width")
                .and_then(|s| s.trim().parse::<u32>().ok());
            let height = el
                .value()
                .attr("height")
                .and_then(|s| s.trim().parse::<u32>().ok());
            push_candidate(src, alt, width, height);
        }
    }

    out
}

/// One image result from the Wikimedia Commons search. Fields are what
/// the frontend / agent need to decide whether to download:
///   - `title`: the File: page title, e.g. "File:Eiffel Tower.jpg"
///   - `url`: full-resolution image URL (upload.wikimedia.org)
///   - `thumb_url`: 800px-wide thumbnail for preview
///   - `width`/`height`: original pixel dimensions
///   - `mime`: server-declared MIME type
///   - `license`: short license name if present (e.g. "CC BY-SA 4.0")
///   - `attribution`: author/credit line, plain text
///   - `description_url`: page to link a caption to (attribution link)
///   - `source`: which backend produced it — `openverse`, `commons` or
///     `wikipedia`. Carried through so the caption can name it and so the
///     licence normaliser knows what it is looking at.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ImageSearchResult {
    pub title: String,
    pub url: String,
    pub thumb_url: String,
    pub width: u32,
    pub height: u32,
    pub mime: String,
    pub license: String,
    pub attribution: String,
    pub description_url: String,
    pub source: String,
}

/// Search every image source at once and interleave what comes back.
///
/// One Tauri command and one model-facing tool regardless of how many sources
/// exist. Round-robin interleaving rather than concatenation matters: the
/// model usually looks at the first few results, and three Openverse hits
/// followed by three Commons hits would hide whichever source happened to be
/// slower to the front of the list.
///
/// A source that errors, times out or rate-limits contributes nothing and is
/// otherwise ignored. Only when all three come back empty does the caller see
/// an empty result, which keeps one flaky backend from breaking image search.
#[tauri::command]
pub async fn proxy_image_search(
    query: String,
    max_results: Option<usize>,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<ImageSearchResult>, String> {
    let limit = max_results.unwrap_or(5).clamp(1, 20);
    info!("image_search q={:?} limit={}", query, limit);

    let client = super::extract::build_fetch_client(proxy.as_ref())?;

    // Ask each source for the full limit: interleaving then trims, so a source
    // that returns nothing costs the others no slots.
    let (openverse_res, commons_res, wikipedia_res) = tokio::join!(
        openverse::search(&client, &query, limit),
        commons::search(&client, &query, limit),
        wikipedia::search(&client, &query),
    );

    let lists: Vec<Vec<ImageSearchResult>> = [
        ("openverse", openverse_res),
        ("commons", commons_res),
        ("wikipedia", wikipedia_res),
    ]
    .into_iter()
    .map(|(name, res)| match res {
        Ok(items) => items,
        Err(e) => {
            // Warn, not debug: a source dropping out silently degrades results
            // to whatever is left, and Commons alone is the weakest of the
            // three. When someone reports poor images this is the first thing
            // worth knowing, so it belongs in the Log Viewer by default.
            log::warn!("image source {} unavailable: {}", name, e);
            Vec::new()
        }
    })
    .collect();

    let merged = interleave(lists.clone(), limit);
    // Per-source counts, because "which source answered" is the question that
    // matters when results are poor, and the merged list alone cannot answer
    // it — a source that returned nothing and one that was never reached look
    // identical downstream.
    info!(
        "image_search q={:?} → openverse={} commons={} wikipedia={}, merged={}",
        query,
        lists.first().map(Vec::len).unwrap_or(0),
        lists.get(1).map(Vec::len).unwrap_or(0),
        lists.get(2).map(Vec::len).unwrap_or(0),
        merged.len()
    );
    Ok(merged)
}

/// Round-robin the lists together, dropping duplicate URLs, until `limit` is
/// reached or every list is exhausted.
fn interleave(lists: Vec<Vec<ImageSearchResult>>, limit: usize) -> Vec<ImageSearchResult> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let longest = lists.iter().map(Vec::len).max().unwrap_or(0);

    for i in 0..longest {
        for list in &lists {
            let Some(item) = list.get(i) else { continue };
            if !seen.insert(item.url.clone()) {
                continue;
            }
            out.push(item.clone());
            if out.len() == limit {
                return out;
            }
        }
    }
    out
}

/// Substrings that mark a URL as decoration rather than a subject photograph.
/// Matched against the lowercased path, so `/assets/site-logo.png` is caught
/// but a legitimate `/photos/logotype-museum.jpg` article image is not
/// meaningfully at risk — a false negative here costs one skipped image, a
/// false positive puts a site's logo in the middle of an answer.
const DECORATIVE_MARKERS: &[&str] = &[
    "sprite",
    "logo",
    "icon",
    "favicon",
    "avatar",
    "placeholder",
    "spacer",
    "banner-ad",
];

/// The page's own declared hero image, if it has one.
///
/// Only the three *declared* sources are consulted, in this order:
/// `og:image`, `twitter:image`, then `link rel="image_src"`. Body `<img>`
/// tags are deliberately excluded — [`extract_page_images`] returns those for
/// the explicit "find images on this page" tool, but a page's first `<img>` is
/// as likely to be a logo or a nav sprite as a photograph of the subject, and
/// this result is offered to the model unprompted on every fetch.
///
/// Nothing is downloaded here. The URL is only surfaced; it is fetched later,
/// and only if the model actually cites it.
pub(crate) fn extract_hero_image(html: &str, base_url: &url::Url) -> Option<String> {
    let doc = Html::parse_document(html);

    let candidates = [
        (r#"meta[property="og:image"]"#, "content"),
        (r#"meta[name="twitter:image"]"#, "content"),
        (r#"link[rel="image_src"]"#, "href"),
    ];

    for (selector, attr) in candidates {
        let Ok(sel) = Selector::parse(selector) else {
            continue;
        };
        for el in doc.select(&sel) {
            let Some(raw) = el.value().attr(attr) else {
                continue;
            };
            if let Some(url) = usable_hero_url(raw, base_url) {
                return Some(url);
            }
        }
    }
    None
}

/// Resolve a raw hero candidate and reject the ones not worth offering.
fn usable_hero_url(raw: &str, base_url: &url::Url) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.starts_with("data:") {
        // A data: URL is already inline; there is nothing for the cache to
        // fetch and nothing to attribute.
        return None;
    }

    let absolute = base_url.join(raw).ok()?;
    if !matches!(absolute.scheme(), "http" | "https") {
        return None;
    }

    let path = absolute.path().to_lowercase();
    if DECORATIVE_MARKERS.iter().any(|m| path.contains(m)) {
        return None;
    }

    Some(absolute.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_page_images_resolves_relative_urls() {
        let base = url::Url::parse("https://example.com/products/mobo/").unwrap();
        let html = r#"<html><body>
            <img src="hero.png" alt="Hero shot">
            <img src="/static/gallery/side.jpg" alt="Side">
            <img src="https://cdn.example.com/top.webp" alt="Top" width="1200" height="800">
        </body></html>"#;
        let images = extract_page_images(html, &base);
        assert_eq!(images.len(), 3);
        // Relative URL resolved against the page directory.
        assert!(images
            .iter()
            .any(|i| i.src == "https://example.com/products/mobo/hero.png"));
        // Absolute-path URL resolved against the page host.
        assert!(images
            .iter()
            .any(|i| i.src == "https://example.com/static/gallery/side.jpg"));
        // Fully-qualified URL passes through unchanged with width/height.
        let top = images
            .iter()
            .find(|i| i.src == "https://cdn.example.com/top.webp")
            .unwrap();
        assert_eq!(top.alt, "Top");
        assert_eq!(top.width, Some(1200));
        assert_eq!(top.height, Some(800));
    }

    #[test]
    fn extract_page_images_picks_up_og_and_twitter_meta() {
        let base = url::Url::parse("https://example.com/article").unwrap();
        let html = r#"<html><head>
            <meta property="og:image" content="https://cdn.example.com/og.jpg">
            <meta name="twitter:image" content="https://cdn.example.com/twitter.jpg">
            <link rel="image_src" href="https://cdn.example.com/legacy.jpg">
        </head><body></body></html>"#;
        let images = extract_page_images(html, &base);
        let srcs: Vec<&str> = images.iter().map(|i| i.src.as_str()).collect();
        assert!(srcs.contains(&"https://cdn.example.com/og.jpg"));
        assert!(srcs.contains(&"https://cdn.example.com/twitter.jpg"));
        assert!(srcs.contains(&"https://cdn.example.com/legacy.jpg"));
    }

    #[test]
    fn extract_page_images_deduplicates_and_filters_garbage() {
        let base = url::Url::parse("https://example.com/").unwrap();
        let html = r#"<html><body>
            <img src="photo.jpg" alt="x">
            <img src="photo.jpg" alt="y">
            <img src="" alt="empty">
            <img src="data:image/gif;base64,R0lGOD" alt="tiny pixel">
            <img src="javascript:alert(1)" alt="bad scheme">
        </body></html>"#;
        let images = extract_page_images(html, &base);
        // Duplicate photo.jpg collapses to one entry
        assert_eq!(
            images
                .iter()
                .filter(|i| i.src == "https://example.com/photo.jpg")
                .count(),
            1
        );
        // Empty src is dropped
        assert!(!images.iter().any(|i| i.alt == "empty"));
        // Short data: URL is dropped (below threshold)
        assert!(!images.iter().any(|i| i.alt == "tiny pixel"));
        // Bad scheme is dropped
        assert!(!images.iter().any(|i| i.alt == "bad scheme"));
    }

    fn result(url: &str, source: &str) -> ImageSearchResult {
        ImageSearchResult {
            title: url.to_string(),
            url: url.to_string(),
            thumb_url: url.to_string(),
            width: 1,
            height: 1,
            mime: String::new(),
            license: String::new(),
            attribution: String::new(),
            description_url: String::new(),
            source: source.to_string(),
        }
    }

    #[test]
    fn interleave_takes_one_from_each_source_in_turn() {
        let out = interleave(
            vec![
                vec![result("o1", "openverse"), result("o2", "openverse")],
                vec![result("c1", "commons"), result("c2", "commons")],
                vec![result("w1", "wikipedia")],
            ],
            10,
        );
        let urls: Vec<&str> = out.iter().map(|r| r.url.as_str()).collect();
        assert_eq!(urls, vec!["o1", "c1", "w1", "o2", "c2"]);
    }

    #[test]
    fn interleave_respects_the_limit() {
        let out = interleave(
            vec![
                vec![result("o1", "openverse"), result("o2", "openverse")],
                vec![result("c1", "commons")],
            ],
            2,
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].url, "o1");
        assert_eq!(out[1].url, "c1");
    }

    /// Openverse aggregates Wikimedia, so the same file can legitimately come
    /// back from two sources. The first one wins.
    #[test]
    fn interleave_drops_duplicate_urls() {
        let out = interleave(
            vec![
                vec![result("same", "openverse")],
                vec![result("same", "commons"), result("other", "commons")],
            ],
            10,
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].source, "openverse");
        assert_eq!(out[1].url, "other");
    }

    /// One or two sources failing must not empty the result — that is the
    /// whole point of querying three.
    #[test]
    fn interleave_survives_empty_sources() {
        let out = interleave(vec![vec![], vec![result("c1", "commons")], vec![]], 10);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].url, "c1");

        assert!(interleave(vec![vec![], vec![], vec![]], 10).is_empty());
        assert!(interleave(vec![], 10).is_empty());
    }

    #[test]
    fn hero_prefers_og_image_then_twitter_then_image_src() {
        let base = url::Url::parse("https://example.com/article").unwrap();

        let all = r#"<html><head>
            <meta property="og:image" content="https://cdn.example.com/og.jpg">
            <meta name="twitter:image" content="https://cdn.example.com/tw.jpg">
            <link rel="image_src" href="https://cdn.example.com/legacy.jpg">
        </head></html>"#;
        assert_eq!(
            extract_hero_image(all, &base).as_deref(),
            Some("https://cdn.example.com/og.jpg")
        );

        let no_og = r#"<html><head>
            <meta name="twitter:image" content="https://cdn.example.com/tw.jpg">
            <link rel="image_src" href="https://cdn.example.com/legacy.jpg">
        </head></html>"#;
        assert_eq!(
            extract_hero_image(no_og, &base).as_deref(),
            Some("https://cdn.example.com/tw.jpg")
        );

        let legacy_only = r#"<html><head>
            <link rel="image_src" href="https://cdn.example.com/legacy.jpg">
        </head></html>"#;
        assert_eq!(
            extract_hero_image(legacy_only, &base).as_deref(),
            Some("https://cdn.example.com/legacy.jpg")
        );
    }

    /// Body images are for the explicit fetch_url_images tool. This one is
    /// offered unprompted, so it must never guess at a random <img>.
    #[test]
    fn hero_ignores_body_images_entirely() {
        let base = url::Url::parse("https://example.com/article").unwrap();
        let html = r#"<html><body><img src="photo.jpg" alt="a photo"></body></html>"#;
        assert_eq!(extract_hero_image(html, &base), None);
    }

    #[test]
    fn hero_resolves_a_relative_url_against_the_page() {
        let base = url::Url::parse("https://example.com/news/2026/story").unwrap();
        let html = r#"<html><head><meta property="og:image" content="../hero.jpg"></head></html>"#;
        assert_eq!(
            extract_hero_image(html, &base).as_deref(),
            Some("https://example.com/news/hero.jpg")
        );
    }

    #[test]
    fn hero_rejects_decoration_and_unusable_schemes() {
        let base = url::Url::parse("https://example.com/").unwrap();
        for src in [
            "https://cdn.example.com/assets/site-logo.png",
            "https://cdn.example.com/sprite-sheet.png",
            "https://cdn.example.com/img/favicon.ico",
            "https://cdn.example.com/users/avatar.jpg",
            "https://cdn.example.com/placeholder.png",
            "data:image/png;base64,iVBORw0KGgo=",
            "javascript:alert(1)",
            "",
        ] {
            let html =
                format!(r#"<html><head><meta property="og:image" content="{src}"></head></html>"#);
            assert_eq!(
                extract_hero_image(&html, &base),
                None,
                "should reject {src}"
            );
        }
    }

    /// A junk og:image must not stop a usable twitter:image being found.
    #[test]
    fn hero_falls_through_when_the_first_candidate_is_junk() {
        let base = url::Url::parse("https://example.com/").unwrap();
        let html = r#"<html><head>
            <meta property="og:image" content="https://cdn.example.com/logo.png">
            <meta name="twitter:image" content="https://cdn.example.com/real-photo.jpg">
        </head></html>"#;
        assert_eq!(
            extract_hero_image(html, &base).as_deref(),
            Some("https://cdn.example.com/real-photo.jpg")
        );
    }

    #[test]
    fn hero_is_absent_when_the_page_declares_none() {
        let base = url::Url::parse("https://example.com/").unwrap();
        assert_eq!(extract_hero_image("<html></html>", &base), None);
    }
}

/// Live-API checks, `#[ignore]`d like the browser-search integration tests.
///
/// The unit tests above parse recorded fixtures, which proves the parsers are
/// right and says nothing about whether the endpoints still answer the way the
/// fixtures were captured. Run these when a source stops returning results:
///
/// ```text
/// cargo test --lib proxy::images::integration -- --ignored --nocapture
/// ```
#[cfg(test)]
mod integration {
    use super::*;

    fn client() -> reqwest::Client {
        crate::proxy::build_fetch_client(None).unwrap()
    }

    #[tokio::test]
    #[ignore]
    async fn openverse_returns_results() {
        let out = openverse::search(&client(), "spider monkey", 3)
            .await
            .unwrap();
        println!("openverse: {} results", out.len());
        assert!(!out.is_empty(), "openverse returned nothing");
    }

    #[tokio::test]
    #[ignore]
    async fn commons_returns_results() {
        let out = commons::search(&client(), "spider monkey", 3)
            .await
            .unwrap();
        println!("commons: {} results", out.len());
        for r in &out {
            println!("  {} [{}]", r.title, r.mime);
        }
    }

    #[tokio::test]
    #[ignore]
    async fn wikipedia_returns_a_lead_image() {
        let out = wikipedia::search(&client(), "Spider monkey").await.unwrap();
        println!("wikipedia: {} results", out.len());
    }

    /// The one that matters: with a small limit, the merged search must not
    /// collapse to a single source.
    #[tokio::test]
    #[ignore]
    async fn merged_search_draws_from_more_than_commons() {
        let c1 = client();
        let (o, c, w) = tokio::join!(
            openverse::search(&c1, "baboon", 1),
            commons::search(&c1, "baboon", 1),
            wikipedia::search(&c1, "Baboon"),
        );
        println!("openverse: {:?}", o.as_ref().map(|v| v.len()));
        println!("commons:   {:?}", c.as_ref().map(|v| v.len()));
        println!("wikipedia: {:?}", w.as_ref().map(|v| v.len()));
        if let Err(e) = &o {
            println!("OPENVERSE ERROR: {e}");
        }
    }
}
