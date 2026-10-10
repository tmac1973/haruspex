//! The app's extra windows — editor windows, detached Code sessions and
//! detached Shell tabs — made here rather than with the JS `WebviewWindow`.
//!
//! On Windows every webview in the app shares one WebView2 data folder, and
//! WebView2 refuses a second webview whose browser arguments differ from the
//! first's ("The group or resource is not in the correct state",
//! 0x8007139F). The main window starts with `additionalBrowserArgs` from
//! `tauri.conf.json`, which the JS API can't pass on, so a window it made
//! never opened. Here each one gets the main window's arguments, read from
//! the config so the two can't drift.

use serde::Deserialize;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// The windows this may make, by label prefix; anything else is refused.
const PREFIXES: [&str; 3] = ["editor-", "code-", "shell-"];

/// A window to open: the frontend's own route, its size, and where.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSpec {
    pub label: String,
    /// An app route, such as `/editor?root=…`.
    pub url: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    /// Where to put it; centred when either is missing.
    pub x: Option<f64>,
    pub y: Option<f64>,
}

fn check(spec: &WindowSpec) -> Result<(), String> {
    if !PREFIXES.iter().any(|p| spec.label.starts_with(p)) {
        return Err(format!("not a window this can open: {}", spec.label));
    }
    // An app route only: never a page from elsewhere in an app window.
    if !spec.url.starts_with('/') || spec.url.starts_with("//") {
        return Err(format!("not an app route: {}", spec.url));
    }
    Ok(())
}

/// Open `spec` as a window like the main one. Async: on Windows a window
/// made from a synchronous command can deadlock.
#[tauri::command]
pub async fn app_window_open(app: AppHandle, spec: WindowSpec) -> Result<(), String> {
    check(&spec)?;
    let mut builder =
        WebviewWindowBuilder::new(&app, &spec.label, WebviewUrl::App(spec.url.into()))
            .title(&spec.title)
            .inner_size(spec.width, spec.height);
    builder = match (spec.x, spec.y) {
        (Some(x), Some(y)) => builder.position(x, y),
        _ => builder.center(),
    };
    let main_args = app
        .config()
        .app
        .windows
        .first()
        .and_then(|w| w.additional_browser_args.clone());
    if let Some(args) = main_args {
        builder = builder.additional_browser_args(&args);
    }
    builder
        .build()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open the window: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(label: &str, url: &str) -> WindowSpec {
        WindowSpec {
            label: label.into(),
            url: url.into(),
            title: String::new(),
            width: 800.0,
            height: 600.0,
            x: None,
            y: None,
        }
    }

    #[test]
    fn only_the_apps_own_windows_and_routes() {
        assert!(check(&spec("editor-abc", "/editor?root=x")).is_ok());
        assert!(check(&spec("code-1", "/code/1")).is_ok());
        assert!(check(&spec("shell-3", "/shell-detached?id=3")).is_ok());
        assert!(check(&spec("main", "/")).is_err());
        assert!(check(&spec("evil", "/editor")).is_err());
        assert!(check(&spec("editor-x", "https://example.com")).is_err());
        assert!(check(&spec("editor-x", "//example.com/x")).is_err());
    }

    #[test]
    fn the_main_window_has_browser_args_to_copy() {
        // If the config stops setting them, this module has nothing to do.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let args = conf["app"]["windows"][0]["additionalBrowserArgs"].as_str();
        assert!(args.is_some_and(|a| !a.is_empty()));
    }
}
