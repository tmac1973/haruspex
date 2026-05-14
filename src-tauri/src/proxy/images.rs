//! Image-search backend (Wikimedia Commons) and per-page image
//! extraction (`extract_page_images`). The Tauri commands
//! `proxy_image_search` and `proxy_fetch_url_images` live here and are
//! re-exported from `mod.rs` so the `lib.rs` invoke handler keeps using
//! `proxy::proxy_image_search` / `proxy::proxy_fetch_url_images`.

use super::bypass::apply_proxy;
use super::extract::{strip_html_tags, validate_url, USER_AGENT};
use super::{ProxyConfig, FETCH_TIMEOUT};
use log::info;
use scraper::{Html, Selector};
use serde::Serialize;

/// and height are from the HTML attributes when present — many modern
/// pages omit them (relying on CSS), so they're optional. `src` is
/// always absolute (relative URLs are resolved against the page URL
/// before they leave `fetch_url_images`).
#[derive(Clone, Debug, Serialize)]
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

    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5)),
        proxy.as_ref(),
    )?
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Fetch failed with status: {}", response.status()));
    }

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
///   - `description_url`: Commons page URL for the file (attribution link)
#[derive(Clone, Debug, Serialize)]
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
}

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
#[tauri::command]
pub async fn proxy_image_search(
    query: String,
    max_results: Option<usize>,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<ImageSearchResult>, String> {
    use serde_json::Value;

    let limit = max_results.unwrap_or(5).clamp(1, 20);
    info!("image_search (commons) q={:?} limit={}", query, limit);

    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5)),
        proxy.as_ref(),
    )?
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Step 1: search for file titles in the File: namespace.
    let search_url = format!(
        "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit={}&srsearch={}",
        limit,
        urlencoding::encode(&query)
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
pub(super) fn parse_commons_imageinfo(
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
        });
    }
    out
}
