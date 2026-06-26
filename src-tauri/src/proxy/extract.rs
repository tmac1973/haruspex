//! HTML scraping, URL validation, and the `fetch_and_extract` helper
//! that every search backend uses to pull a single page's text content.
//! All items are crate-internal to `proxy` except `validate_url`, which
//! is consumed by `fs_tools::download::fs_download_url`.

use super::bypass::apply_proxy;
use super::config::FETCH_TIMEOUT;
use super::paywall::{detect_paywall_signal, PAYWALL_SENTINEL};
use super::ProxyConfig;
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

    let client = build_fetch_client(proxy)?;

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

/// Build the HTTP client every external page/image fetch uses: the shared fetch
/// timeout plus the SSRF-[`validating_redirect_policy`]. Centralized so the
/// redirect guard — what stops a 30x from bouncing a fetch to an internal
/// address — can't be omitted by one call site.
pub(super) fn build_fetch_client(proxy: Option<&ProxyConfig>) -> Result<reqwest::Client, String> {
    apply_proxy(
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(validating_redirect_policy()),
        proxy,
    )?
    .build()
    .map_err(|e| format!("Failed to create HTTP client: {}", e))
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

#[cfg(test)]
mod tests {
    use super::*;

    // -- validate_url / validate_parsed_url SSRF cases ----------------------

    #[test]
    fn validate_url_accepts_https() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("http://example.com/path?q=1").is_ok());
    }

    #[test]
    fn validate_url_rejects_non_http() {
        assert!(validate_url("ftp://example.com").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn validate_url_rejects_localhost() {
        assert!(validate_url("http://localhost").is_err());
        assert!(validate_url("http://127.0.0.1").is_err());
        assert!(validate_url("http://0.0.0.0").is_err());
    }

    #[test]
    fn validate_url_rejects_private_ips() {
        assert!(validate_url("http://10.0.0.1").is_err());
        assert!(validate_url("http://192.168.1.1").is_err());
        assert!(validate_url("http://172.16.0.1").is_err());
    }

    #[test]
    fn validate_url_rejects_invalid() {
        assert!(validate_url("not a url").is_err());
        assert!(validate_url("").is_err());
    }

    #[test]
    fn validate_url_rejects_ipv6_loopback_and_local_ranges() {
        // Bracketed IPv6 literals never parse via host_str() — these went
        // through unchecked before validate_parsed_url matched on url::Host.
        assert!(validate_url("http://[::1]:8765/").is_err());
        assert!(validate_url("http://[::]/").is_err());
        // IPv4-mapped addresses reach the V4 network
        assert!(validate_url("http://[::ffff:127.0.0.1]/").is_err());
        assert!(validate_url("http://[::ffff:192.168.1.1]/").is_err());
        // Unique-local (fc00::/7) and link-local (fe80::/10)
        assert!(validate_url("http://[fc00::1]/").is_err());
        assert!(validate_url("http://[fd12:3456::1]/").is_err());
        assert!(validate_url("http://[fe80::1]/").is_err());
        // Public IPv6 still allowed
        assert!(validate_url("http://[2606:4700::6810:84e5]/").is_ok());
    }

    #[test]
    fn validate_url_rejects_localhost_subdomains() {
        assert!(validate_url("http://foo.localhost:8765/").is_err());
        assert!(validate_url("http://LOCALHOST/").is_err());
    }

    #[test]
    fn validate_url_rejects_link_local_v4() {
        // 169.254.169.254 — cloud metadata endpoint
        assert!(validate_url("http://169.254.169.254/latest/meta-data/").is_err());
    }

    #[test]
    fn is_private_ip_detects_rfc1918() {
        assert!(is_private_ip(&"10.0.0.1".parse().unwrap()));
        assert!(is_private_ip(&"192.168.1.1".parse().unwrap()));
        assert!(is_private_ip(&"172.16.0.1".parse().unwrap()));
        assert!(is_private_ip(&"127.0.0.1".parse().unwrap()));
        assert!(!is_private_ip(&"8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip(&"1.1.1.1".parse().unwrap()));
    }

    // -- extract_text basics + truncation ------------------------------------

    #[test]
    fn extract_text_from_simple_html() {
        let html = r#"<html><body><article><p>Hello world</p><p>Second paragraph</p></article></body></html>"#;
        let text = extract_text(html);
        assert!(text.contains("Hello world"));
        assert!(text.contains("Second paragraph"));
    }

    #[test]
    fn extract_text_truncates_long_content() {
        let long_text = "word ".repeat(2000);
        let html = format!(
            "<html><body><article><p>{}</p></article></body></html>",
            long_text
        );
        let text = extract_text(&html);
        assert!(text.len() <= MAX_FETCH_LENGTH + 10); // +10 for "..."
        assert!(text.ends_with("..."));
    }

    #[test]
    fn extract_text_truncates_multibyte_content_on_char_boundary() {
        // 3-byte chars with no whitespace guarantee a char straddles the
        // MAX_FETCH_LENGTH byte index (4000 is not a multiple of 3), which
        // panicked before truncation backed off to a char boundary.
        let long_text = "—".repeat(3000);
        let html = format!(
            "<html><body><article><p>{}</p></article></body></html>",
            long_text
        );
        let text = extract_text(&html);
        assert!(text.len() <= MAX_FETCH_LENGTH + 3); // +3 for "..."
        assert!(text.ends_with("..."));
    }

    #[test]
    fn extract_text_prefers_article() {
        let html = r#"
            <html><body>
            <nav>Navigation stuff</nav>
            <article><p>This is the main article content that should be extracted because it is long enough to be considered real content.</p></article>
            <footer>Footer stuff</footer>
            </body></html>"#;
        let text = extract_text(html);
        assert!(text.contains("main article content"));
    }

    // -- diagnostic_snippet ------------------------------------------------

    #[test]
    fn diagnostic_snippet_starts_200_bytes_before_needle() {
        let html = format!("{}NEEDLE{}", "a".repeat(300), "b".repeat(50));
        let snippet = diagnostic_snippet(&html, &["NEEDLE"], 250);
        // Needle is at byte 300, so the snippet starts at byte 100 and the
        // needle sits 200 chars in.
        assert!(snippet.starts_with("aaa"));
        assert!(snippet.contains("NEEDLE"));
        assert_eq!(snippet.chars().count(), 250);
    }

    #[test]
    fn diagnostic_snippet_tries_needles_in_order() {
        let html = "alpha beta gamma";
        let snippet = diagnostic_snippet(html, &["missing", "beta"], 10);
        assert!(snippet.starts_with("alpha beta"));
    }

    #[test]
    fn diagnostic_snippet_falls_back_to_prefix_when_no_needle_matches() {
        assert_eq!(diagnostic_snippet("hello world", &["zzz"], 5), "hello");
        assert_eq!(diagnostic_snippet("hello", &[], 99), "hello");
    }

    #[test]
    fn diagnostic_snippet_saturates_when_needle_is_near_the_start() {
        let html = "NEEDLE then some trailing text";
        let snippet = diagnostic_snippet(html, &["NEEDLE"], 11);
        assert_eq!(snippet, "NEEDLE then");
    }

    #[test]
    fn diagnostic_snippet_backs_off_mid_codepoint_start() {
        // 100 3-byte chars put the needle at byte 300; start = 300 - 200 =
        // 100, which is mid-codepoint ('€' boundaries are multiples of 3).
        // Without the walk-forward loop, slicing html[100..] panics.
        let html = format!("{}NEEDLE", "€".repeat(100));
        let snippet = diagnostic_snippet(&html, &["NEEDLE"], 80);
        assert!(snippet.starts_with('€'));
        assert!(snippet.contains("NEEDLE"));
    }

    // -- strip_html_tags ---------------------------------------------------

    #[test]
    fn strip_html_tags_removes_tags_and_keeps_text() {
        assert_eq!(strip_html_tags("<p>Hello <b>world</b></p>"), "Hello world");
    }

    #[test]
    fn strip_html_tags_collapses_whitespace() {
        assert_eq!(
            strip_html_tags("  Hello \n\t <span> big </span>  world  "),
            "Hello big world"
        );
    }

    #[test]
    fn strip_html_tags_passes_through_plain_text() {
        assert_eq!(strip_html_tags("no tags here"), "no tags here");
    }

    #[test]
    fn strip_html_tags_drops_content_after_unclosed_tag() {
        // An unterminated '<' swallows the rest of the string — documented
        // current behavior of the scanner.
        assert_eq!(strip_html_tags("before<a href=unclosed"), "before");
    }

    // -- extract_text selection + whitespace cleanup ------------------------

    /// Filler long enough (>100 chars) for try_select_text to accept the
    /// element as main content.
    const LONG: &str = "This sentence is repeated to pass the one-hundred-character minimum \
        that try_select_text enforces on candidate containers.";

    #[test]
    fn extract_text_falls_back_to_main_when_no_article() {
        let html =
            format!("<html><body><nav>Site nav</nav><main><p>{LONG}</p></main></body></html>");
        let text = extract_text(&html);
        assert!(text.contains("one-hundred-character minimum"));
        assert!(!text.contains("Site nav"));
    }

    #[test]
    fn extract_text_falls_back_to_role_main() {
        let html = format!(
            "<html><body><div role='main'><p>{LONG}</p></div><footer>Foot</footer></body></html>"
        );
        let text = extract_text(&html);
        assert!(text.contains("one-hundred-character minimum"));
        assert!(!text.contains("Foot"));
    }

    #[test]
    fn extract_text_ignores_short_article_and_uses_body() {
        // The <article> is under 100 chars, so it is rejected as "probably
        // not the main content" and the whole body text is used instead.
        let html =
            format!("<html><body><article>tiny</article><div><p>{LONG}</p></div></body></html>");
        let text = extract_text(&html);
        assert!(text.contains("one-hundred-character minimum"));
        // Body fallback keeps everything, including the short article text.
        assert!(text.contains("tiny"));
    }

    #[test]
    fn extract_text_trims_lines_and_drops_blank_ones() {
        let html = "<html><body><p>  Line one  </p>\n\n\n<p>\t Line two \t</p></body></html>";
        assert_eq!(extract_text(html), "Line one\nLine two");
    }

    #[test]
    fn extract_text_handles_documents_without_body() {
        // Fragment parsing still produces a document; this must not panic
        // and should return the text content.
        let text = extract_text("just plain text, no markup");
        assert!(text.contains("just plain text"));
    }
}
