//! Interactive Python artifacts (plotly, bokeh, altair, folium output),
//! served from a custom scheme of their own.
//!
//! These documents are model-authored HTML whose `<script>` tags have to run:
//! inline scripts, CDN scripts, sometimes `eval`. They used to render as
//! `srcdoc` iframes, and a `srcdoc` document inherits the page's Content
//! Security Policy, so the app's own policy had to allow all of that for
//! the main window too. Served from `haruspex-artifact:`, each one gets a
//! policy of its own in a response header, and the main window's can be
//! strict. The iframe stays `sandbox="allow-scripts"` without
//! `allow-same-origin`, so the document runs in an opaque origin that can
//! reach neither the app nor IPC.
//!
//! The webview registers a document and gets an id back; the iframe's `src`
//! names the id. Documents are kept for the session, oldest dropped first
//! past a total size, so a long chat cannot grow without bound.

use std::collections::VecDeque;
use std::sync::Mutex;

use tauri::http::{header, Request, Response, StatusCode};

use crate::sync_util::LockExt;

/// Room for a long session's plots; each is a few MB with plotly inlined.
const MAX_TOTAL_BYTES: usize = 256 * 1024 * 1024;

/// The app's own origin, which artifact documents may load scripts from: the
/// sandbox points plotly figures at the bundled `/plotly/plotly.min.js` there
/// so they need no network. `tauri:` and its Windows form in a release build;
/// the Vite dev server as well in a debug one.
#[cfg(debug_assertions)]
const APP_ORIGINS: &str = "tauri: http://tauri.localhost http://localhost:1420";
#[cfg(not(debug_assertions))]
const APP_ORIGINS: &str = "tauri: http://tauri.localhost";

/// What an artifact document may do. Everything a plotting library needs —
/// inline and CDN scripts, the app's bundled plotly.js, eval, wasm — and
/// nothing that reaches back: no forms, no nested frames, no `<base>`, and
/// only HTTPS outward.
fn artifact_csp() -> String {
    format!(
        "default-src 'none'; \
         script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https: blob: data: {APP_ORIGINS}; \
         style-src 'unsafe-inline' https:; \
         img-src data: blob: https:; \
         font-src data: https:; \
         connect-src https:; \
         worker-src blob:; \
         frame-src 'none'; \
         form-action 'none'; \
         base-uri 'none'"
    )
}

#[derive(Default)]
pub struct ArtifactFrames(Mutex<Store>);

#[derive(Default)]
struct Store {
    docs: VecDeque<(String, String)>,
    total: usize,
}

impl ArtifactFrames {
    pub fn register(&self, html: String) -> String {
        let id = new_id();
        let mut s = self.0.lock_or_recover();
        s.total += html.len();
        s.docs.push_back((id.clone(), html));
        while s.total > MAX_TOTAL_BYTES && s.docs.len() > 1 {
            if let Some((_, old)) = s.docs.pop_front() {
                s.total -= old.len();
            }
        }
        id
    }

    fn get(&self, id: &str) -> Option<String> {
        self.0
            .lock_or_recover()
            .docs
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, html)| html.clone())
    }

    /// Answer a `haruspex-artifact:` request: the document named by the
    /// path, with its own policy, or a 404.
    pub fn handle(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let id = request.uri().path().trim_start_matches('/');
        let builder = Response::builder()
            // The app window is cross-origin isolated (COEP credentialless),
            // and a frame inside it must opt in the same way to load.
            .header("Cross-Origin-Embedder-Policy", "credentialless")
            .header("Cross-Origin-Resource-Policy", "cross-origin");
        match self.get(id) {
            Some(html) => builder
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header("Content-Security-Policy", artifact_csp())
                .body(html.into_bytes()),
            None => builder
                .status(StatusCode::NOT_FOUND)
                .header(header::CONTENT_TYPE, "text/plain")
                .body(b"This plot is no longer available.".to_vec()),
        }
        .unwrap_or_else(|_| Response::new(Vec::new()))
    }
}

fn new_id() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut b = [0u8; 16];
    // An unguessable id is not what keeps a document private (the frame's
    // origin is opaque and nothing lists ids), but it costs nothing.
    let _ = SystemRandom::new().fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Keep an artifact document for its iframe and return the id to load it by.
#[tauri::command]
pub fn artifact_register(state: tauri::State<'_, ArtifactFrames>, html: String) -> String {
    state.register(html)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str) -> Request<Vec<u8>> {
        Request::builder()
            .uri(format!("haruspex-artifact://localhost{path}"))
            .body(Vec::new())
            .unwrap()
    }

    #[test]
    fn a_registered_document_is_served_with_its_own_policy() {
        let frames = ArtifactFrames::default();
        let id = frames.register("<script>plot()</script>".into());
        let r = frames.handle(&request(&format!("/{id}")));
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), b"<script>plot()</script>");
        let csp = r.headers()["content-security-policy"].to_str().unwrap();
        assert!(csp.contains("script-src 'unsafe-inline'"), "{csp}");
        assert!(csp.contains("form-action 'none'"), "{csp}");
        // The bundled plotly.js is loaded from the app's own origin.
        assert!(csp.contains("tauri:"), "{csp}");
        assert_eq!(
            r.headers()["cross-origin-embedder-policy"],
            "credentialless"
        );
    }

    #[test]
    fn an_unknown_id_is_a_404() {
        let frames = ArtifactFrames::default();
        assert_eq!(
            frames.handle(&request("/nope")).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn the_oldest_documents_go_first_past_the_cap() {
        let frames = ArtifactFrames::default();
        let big = "x".repeat(MAX_TOTAL_BYTES / 2 + 1);
        let first = frames.register(big.clone());
        let second = frames.register(big.clone());
        assert!(frames.get(&first).is_none());
        assert!(frames.get(&second).is_some());
        // One document larger than the cap is still kept: it is the one on
        // screen.
        let huge = frames.register("y".repeat(MAX_TOTAL_BYTES + 1));
        assert!(frames.get(&huge).is_some());
    }
}
