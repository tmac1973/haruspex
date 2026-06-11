//! HTML scraping, URL validation, and the `fetch_and_extract` helper
//! that every search backend uses to pull a single page's text content.
//! All items are crate-internal to `proxy` except `validate_url`, which
//! is consumed by `fs_tools::download::fs_download_url`.

use super::bypass::apply_proxy;
use super::paywall::{detect_paywall_signal, PAYWALL_SENTINEL};
use super::{ProxyConfig, FETCH_TIMEOUT};
use scraper::{Html, Selector};
use std::net::IpAddr;

const MAX_FETCH_LENGTH: usize = 4000;
pub(crate) const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

pub(super) fn diagnostic_snippet(html: &str, needles: &[&str], window: usize) -> String {
    for needle in needles {
        if let Some(pos) = html.find(needle) {
            let start = pos.saturating_sub(200);
            // Walk forward from `start` until we hit a char boundary
            let mut s = start;
            while s < html.len() && !html.is_char_boundary(s) {
                s += 1;
            }
            return html[s..].chars().take(window).collect();
        }
    }
    html.chars().take(window).collect()
}

pub(super) async fn fetch_and_extract(
    url: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<String, String> {
    // Validate URL
    validate_url(url)?;

    let client = apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(validating_redirect_policy()),
        proxy,
    )?
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Fetch failed with status: {}", response.status()));
    }

    // Check content type
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !content_type.contains("text/html") && !content_type.contains("text/plain") {
        return Err(format!("Content type not supported: {}", content_type));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // Before stripping to plain text, check whether the raw HTML carries
    // a standardized paywall marker. When a page self-declares as gated,
    // return a sentinel instead of the extracted body — the model can't
    // usefully cite a preview, and the TS layer will reject the URL as a
    // citation source. See the comment on PAYWALL_SENTINEL.
    if let Some(reason) = detect_paywall_signal(&html) {
        return Ok(format!("{} {}", PAYWALL_SENTINEL, reason));
    }

    Ok(extract_text(&html))
}

pub(crate) fn validate_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "Invalid URL".to_string())?;
    validate_parsed_url(&parsed)
}

/// Scheme + host SSRF checks on an already-parsed URL. Matching on
/// `url::Host` (not `host_str`) matters for IPv6: `host_str` returns the
/// bracketed form (`[::1]`), which doesn't parse as an `IpAddr` and would
/// sail past a string-based check.
pub(crate) fn validate_parsed_url(parsed: &url::Url) -> Result<(), String> {
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("Unsupported URL scheme: {}", scheme)),
    }

    match parsed.host() {
        Some(url::Host::Domain(domain)) => {
            let lower = domain.to_ascii_lowercase();
            if lower == "localhost" || lower.ends_with(".localhost") {
                return Err("Local URLs are not allowed".to_string());
            }
        }
        Some(url::Host::Ipv4(ip)) => {
            if is_private_ip(&IpAddr::V4(ip)) {
                return Err("Private IP addresses are not allowed".to_string());
            }
        }
        Some(url::Host::Ipv6(ip)) => {
            if is_private_ip(&IpAddr::V6(ip)) {
                return Err("Private IP addresses are not allowed".to_string());
            }
        }
        None => return Err("URL has no host".to_string()),
    }

    Ok(())
}

/// Redirect policy that re-validates every hop. reqwest's stock policies
/// follow 3xx blindly, so a public page could answer
/// `302 Location: http://127.0.0.1:8765/...` and the response from inside
/// the private network would be read as if it came from the original
/// target. Every client that fetches untrusted external URLs must use
/// this instead of `Policy::limited`.
pub(crate) fn validating_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > 5 {
            return attempt.error("too many redirects");
        }
        match validate_parsed_url(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(reason) => attempt.error(format!("redirect blocked: {}", reason)),
        }
    })
}

pub(super) fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            // An IPv4-mapped address (::ffff:a.b.c.d) reaches the V4 network —
            // judge it by the embedded V4 address.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_ip(&IpAddr::V4(v4));
            }
            let seg0 = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (seg0 & 0xfe00) == 0xfc00 // unique-local fc00::/7
                || (seg0 & 0xffc0) == 0xfe80 // link-local fe80::/10
        }
    }
}

pub(super) fn extract_text(html: &str) -> String {
    let document = Html::parse_document(html);

    // Try to find main content area
    let content = try_select_text(&document, "article")
        .or_else(|| try_select_text(&document, "main"))
        .or_else(|| try_select_text(&document, "[role='main']"))
        .unwrap_or_else(|| extract_body_text(&document));

    // Clean up whitespace
    let cleaned = content
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<&str>>()
        .join("\n");

    // Truncate without splitting a UTF-8 code point.
    if cleaned.len() > MAX_FETCH_LENGTH {
        let truncated = crate::text_util::truncate_at_char_boundary(&cleaned, MAX_FETCH_LENGTH);
        // Find the last complete word
        if let Some(pos) = truncated.rfind(char::is_whitespace) {
            format!("{}...", &truncated[..pos])
        } else {
            format!("{}...", truncated)
        }
    } else {
        cleaned
    }
}

fn try_select_text(document: &Html, selector_str: &str) -> Option<String> {
    let selector = Selector::parse(selector_str).ok()?;
    let element = document.select(&selector).next()?;
    let text = element.text().collect::<String>();
    let trimmed = text.trim();
    if trimmed.len() > 100 {
        Some(trimmed.to_string())
    } else {
        None // Too short, probably not the main content
    }
}

fn extract_body_text(document: &Html) -> String {
    // Remove script, style, nav, header, footer, aside elements by collecting
    // text only from visible content elements
    let body_selector = Selector::parse("body").unwrap();

    if let Some(body) = document.select(&body_selector).next() {
        body.text().collect::<String>()
    } else {
        document.root_element().text().collect::<String>()
    }
}

pub(super) fn strip_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}
