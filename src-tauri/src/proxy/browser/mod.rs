//! Driving a locally-installed Chromium-family browser for search.
//!
//! Exists because the plain-HTTP rotation keeps losing engines to JavaScript
//! bot walls — Bing and Qwant in April 2026, Startpage and Mojeek by August —
//! and no header combination fakes a JS runtime. A real browser answers that
//! class of failure once rather than per engine.
//!
//! Three concerns, split: `detect` finds a browser the user already has,
//! `process` runs it headless with a throwaway profile, and `cdp` speaks the
//! five DevTools methods needed to open a tab and read its settled DOM. No
//! search knowledge lives here; `proxy::search` supplies the URLs and parsers.

pub(super) mod cdp;
pub(super) mod detect;
pub(super) mod process;
pub(super) mod search;

pub(super) use detect::{detect, DetectedBrowser};

#[cfg(test)]
mod integration {
    use super::*;
    use std::time::Duration;

    /// End-to-end: find a browser, launch it, render a page that only exists
    /// after JavaScript runs, and read it back.
    ///
    /// Ignored because it needs a browser installed and reaches the network —
    /// neither is safe to assume in CI. Run it by hand with:
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml browser_renders -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn browser_renders_javascript_generated_dom() {
        let found = detect(None).expect("a Chromium-family browser must be installed");
        println!("using {} ({})", found.path, found.version);

        let process = process::BrowserProcess::launch(&found).expect("browser should launch");
        // A data: URL whose content only exists once scripts have run, so a
        // pass proves JS execution rather than plain HTML retrieval.
        let url = "data:text/html,<html><body><script>\
                   setTimeout(()=>{document.body.innerHTML='<div id=late>rendered</div>'},300)\
                   </script></body></html>";
        let outcome = cdp::render(
            process.port,
            url,
            &|html: &str| html.contains("id=\"late\""),
            Duration::from_secs(15),
        )
        .await
        .expect("render should succeed");

        assert!(outcome.ready, "ready predicate should have been satisfied");
        assert!(
            outcome.html.contains("rendered"),
            "DOM should hold script-generated content, got {} bytes",
            outcome.html.len()
        );
    }

    /// The user-agent flag is load-bearing — without it Startpage silently
    /// serves its homepage. This asserts the flag actually reaches the page.
    #[tokio::test]
    #[ignore]
    async fn launched_browser_does_not_announce_itself_as_headless() {
        let found = detect(None).expect("a Chromium-family browser must be installed");
        let process = process::BrowserProcess::launch(&found).expect("browser should launch");
        let outcome = cdp::render(
            process.port,
            "data:text/html,<html><body>ua</body></html>",
            &|html: &str| html.contains("ua"),
            Duration::from_secs(10),
        )
        .await
        .expect("render should succeed");
        assert!(outcome.ready);

        let mut page = cdp::CdpConnection::connect(&{
            let targets: Vec<serde_json::Value> =
                reqwest::get(format!("http://127.0.0.1:{}/json", process.port))
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
            targets
                .iter()
                .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
                .and_then(|t| t.get("webSocketDebuggerUrl"))
                .and_then(|v| v.as_str())
                .expect("a page target")
                .to_string()
        })
        .await
        .expect("connect");
        let ua = page
            .call(
                "Runtime.evaluate",
                serde_json::json!({ "expression": "navigator.userAgent", "returnByValue": true }),
            )
            .await
            .expect("evaluate")
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        println!("navigator.userAgent = {ua}");
        assert!(
            !ua.contains("Headless"),
            "UA still announces headless: {ua}"
        );
    }
}
