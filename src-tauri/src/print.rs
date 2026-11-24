//! Printing a chat answer, a conversation or a notebook.
//!
//! The webview prints what it shows, so a document is printed from a window
//! of its own (`print-<id>` on the `/print` route) rather than from the main
//! window, whose layout clips everything to one screen. `print_open` keeps
//! the document here and opens that window; the window reads it back with
//! `print_document` (a document can be megabytes of inline pictures, too much
//! for a URL) and its Print button calls `print_run`.
//!
//! `Webview::print` opens the system print dialog on Linux (WebKitGTK) and
//! WebView2's print preview on Windows. On macOS wry builds the print
//! operation but never runs it, so the dialog is run here instead.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Webview};

use crate::app_windows::{self, WindowSpec};

/// The label prefix of a print window.
const PREFIX: &str = "print-";

/// Documents kept for print windows. A window may reload (or be opened
/// again from the window menu), so a document is kept after it is read and
/// only the oldest is dropped.
const KEEP: usize = 8;

/// What a print window shows: a title and the HTML of the document's body,
/// already sanitized by the webview that made it.
#[derive(Clone, Debug, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct PrintDoc {
    pub title: String,
    pub html: String,
}

/// The kept documents, newest last.
#[derive(Default)]
struct Store {
    next: u64,
    items: VecDeque<(String, PrintDoc)>,
}

impl Store {
    fn keep(&mut self, doc: PrintDoc) -> String {
        self.next += 1;
        let id = self.next.to_string();
        self.items.push_back((id.clone(), doc));
        while self.items.len() > KEEP {
            self.items.pop_front();
        }
        id
    }

    fn find(&self, id: &str) -> Option<PrintDoc> {
        self.items
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, d)| d.clone())
    }
}

fn store() -> std::sync::MutexGuard<'static, Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// A window title for `title`: never empty, never long.
fn window_title(title: &str) -> String {
    let t: String = title.trim().chars().take(80).collect();
    if t.is_empty() {
        "Print".into()
    } else {
        format!("Print — {t}")
    }
}

/// Keep `doc` and open a print window on it.
#[tauri::command]
pub async fn print_open(app: AppHandle, doc: PrintDoc) -> Result<(), String> {
    let title = window_title(&doc.title);
    let id = store().keep(doc);
    app_windows::open(
        &app,
        WindowSpec {
            label: format!("{PREFIX}{id}"),
            url: format!("/print?id={id}"),
            title,
            width: 880.0,
            height: 960.0,
            x: None,
            y: None,
        },
    )
}

/// The document a print window shows; None once it has been dropped.
#[tauri::command]
pub fn print_document(id: String) -> Option<PrintDoc> {
    store().find(&id)
}

/// Open the print dialog for the print window that asks.
#[tauri::command]
pub fn print_run(webview: Webview) -> Result<(), String> {
    if !webview.label().starts_with(PREFIX) {
        return Err("Only a print window can print.".into());
    }
    run(&webview)
}

#[cfg(not(target_os = "macos"))]
fn run(webview: &Webview) -> Result<(), String> {
    webview
        .print()
        .map_err(|e| format!("Couldn't open the print dialog: {e}"))
}

#[cfg(target_os = "macos")]
fn run(webview: &Webview) -> Result<(), String> {
    use objc2_app_kit::{NSPrintInfo, NSWindow};
    use objc2_web_kit::WKWebView;

    webview
        .with_webview(|pv| unsafe {
            // Both pointers are live for the closure, which runs on the main
            // thread: wry's WKWebView and the NSWindow that holds it.
            let wk = &*(pv.inner() as *const WKWebView);
            let window = &*(pv.ns_window() as *const NSWindow);
            let info = NSPrintInfo::sharedPrintInfo();
            let op = wk.printOperationWithPrintInfo(&info);
            op.setShowsPrintPanel(true);
            op.setShowsProgressPanel(true);
            // Without a frame the operation's view prints blank pages.
            if let Some(view) = op.view() {
                view.setFrame(wk.bounds());
            }
            op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                window,
                None,
                None,
                std::ptr::null_mut(),
            );
        })
        .map_err(|e| format!("Couldn't open the print dialog: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(title: &str) -> PrintDoc {
        PrintDoc {
            title: title.into(),
            html: format!("<p>{title}</p>"),
        }
    }

    #[test]
    fn a_kept_document_is_read_back_more_than_once() {
        let mut s = Store::default();
        let id = s.keep(doc("once"));
        assert_eq!(s.find(&id).unwrap().title, "once");
        assert_eq!(s.find(&id).unwrap().html, "<p>once</p>");
        assert!(s.find("no-such-id").is_none());
    }

    #[test]
    fn only_the_newest_documents_are_kept() {
        let mut s = Store::default();
        let first = s.keep(doc("first"));
        let second = s.keep(doc("second"));
        for i in 1..KEEP {
            s.keep(doc(&format!("later {i}")));
        }
        assert!(s.find(&first).is_none());
        assert!(s.find(&second).is_some());
    }

    #[test]
    fn window_titles_are_short_and_never_empty() {
        assert_eq!(window_title("  "), "Print");
        assert_eq!(window_title("Trip"), "Print — Trip");
        assert_eq!(window_title(&"x".repeat(200)).chars().count(), 80 + 8);
    }
}
