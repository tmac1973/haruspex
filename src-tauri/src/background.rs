//! Keeping Haruspex running with its window closed: the tray icon, the
//! close button that hides rather than quits, and starting at login.
//!
//! Settings → General → Background holds both switches. The tray one is kept
//! in `background.json` in the app data directory rather than in the
//! webview's settings, because Rust needs it before any page has loaded: at
//! startup, to put the icon up and decide whether a login start shows the
//! window, and in the close handler. Whether Haruspex starts at login is the
//! OS's own entry (an XDG autostart file, a LaunchAgent, a Run key), so the
//! switch reads that rather than keeping a copy that could drift.
//!
//! Hiding is the point: the job scheduler and the Home cards run in the main
//! webview, so the window stays alive, only out of sight. Quit from the tray
//! closes it the ordinary way, so the quit path is the one closing the window
//! always was.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_autostart::ManagerExt;

const FILE_NAME: &str = "background.json";
const TRAY_ID: &str = "main";
const MENU_SHOW: &str = "tray-show";
const MENU_QUIT: &str = "tray-quit";

/// The argument the login entry starts Haruspex with, so a login start can
/// stay in the tray while one from the menu opens the window.
pub const HIDDEN_ARG: &str = "--hidden";

#[derive(Default, Serialize, Deserialize)]
struct Prefs {
    #[serde(default)]
    tray: bool,
}

/// What Settings → General → Background shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundState {
    /// Closing the window hides it, and an icon stays in the tray.
    pub tray: bool,
    /// The OS starts Haruspex when the user logs in.
    pub start_at_login: bool,
}

pub struct Background {
    path: Option<PathBuf>,
    tray: AtomicBool,
    /// Set by Quit, so the close that follows is let through.
    quitting: AtomicBool,
}

impl Background {
    pub fn load(data_dir: Option<PathBuf>) -> Self {
        let path = data_dir.map(|d| d.join(FILE_NAME));
        let prefs = path.as_deref().map(read).unwrap_or_default();
        Self {
            path,
            tray: AtomicBool::new(prefs.tray),
            quitting: AtomicBool::new(false),
        }
    }

    pub fn tray_enabled(&self) -> bool {
        self.tray.load(Ordering::SeqCst)
    }

    /// Whether a close of the main window should hide it instead.
    pub fn hides_on_close(&self) -> bool {
        self.tray_enabled() && !self.quitting.load(Ordering::SeqCst)
    }

    fn set_tray(&self, on: bool) -> Result<(), String> {
        if let Some(path) = &self.path {
            write(path, &Prefs { tray: on })?;
        }
        self.tray.store(on, Ordering::SeqCst);
        Ok(())
    }
}

fn read(path: &Path) -> Prefs {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write(path: &Path, prefs: &Prefs) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(prefs).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Whether this process was started by the login entry.
pub fn started_hidden(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|a| a == HIDDEN_ARG)
}

/// Bring the main window forward: from the tray, the Dock, or a second launch.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Quit for real: close the main window the ordinary way, so editor and Code
/// windows still ask about unsaved work, and the app ends as it always did.
fn quit<R: Runtime>(app: &AppHandle<R>) {
    app.state::<Background>()
        .quitting
        .store(true, Ordering::SeqCst);
    match app.get_webview_window("main") {
        Some(w) => {
            if w.close().is_err() {
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}

/// Put the tray icon up, unless it is up already.
pub fn add_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let show = MenuItem::with_id(app, MENU_SHOW, "Show Haruspex", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "Quit Haruspex", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Haruspex")
        .menu(&menu)
        // A left click shows the window; the menu is on the right button.
        // Some Linux trays open the menu on either button, which is why it
        // has Show too.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => show_main(app),
            MENU_QUIT => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn remove_tray<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.remove_tray_by_id(TRAY_ID);
}

/// At startup: the icon when the tray is on, and the window unless a login
/// start can stay in the tray. A login start with the tray off shows the
/// window, since nothing else would let the user find it.
pub fn on_startup<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    let bg = app.state::<Background>();
    let mut tray = bg.tray_enabled();
    if tray {
        if let Err(e) = add_tray(app) {
            log::warn!("tray icon unavailable: {e}");
            tray = false;
        }
    }
    if !(hidden && tray) {
        show_main(app);
    }
}

fn state<R: Runtime>(app: &AppHandle<R>) -> BackgroundState {
    BackgroundState {
        tray: app.state::<Background>().tray_enabled(),
        start_at_login: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[tauri::command]
pub fn background_get(app: AppHandle) -> BackgroundState {
    state(&app)
}

#[tauri::command]
pub fn background_set_tray(
    app: AppHandle,
    bg: State<'_, Background>,
    on: bool,
) -> Result<BackgroundState, String> {
    if on {
        // Up before it is saved: a desktop with no tray says so here, rather
        // than leaving a window that hides with no way back.
        add_tray(&app).map_err(|e| format!("No tray icon on this desktop: {e}"))?;
    } else {
        remove_tray(&app);
    }
    bg.set_tray(on)?;
    Ok(state(&app))
}

#[tauri::command]
pub fn background_set_start_at_login(app: AppHandle, on: bool) -> Result<BackgroundState, String> {
    let launcher = app.autolaunch();
    let result = if on {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| e.to_string())?;
    Ok(state(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    #[test]
    fn tray_is_off_until_saved_on() {
        let dir = temp_dir("background-prefs");
        assert!(!Background::load(Some(dir.clone())).tray_enabled());
        Background::load(Some(dir.clone())).set_tray(true).unwrap();
        assert!(Background::load(Some(dir.clone())).tray_enabled());
        Background::load(Some(dir.clone())).set_tray(false).unwrap();
        assert!(!Background::load(Some(dir.to_path_buf())).tray_enabled());
    }

    #[test]
    fn a_broken_file_reads_as_off() {
        let dir = temp_dir("background-broken");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), "not json").unwrap();
        assert!(!Background::load(Some(dir.to_path_buf())).tray_enabled());
    }

    #[test]
    fn quit_lets_the_close_through() {
        let bg = Background::load(None);
        bg.set_tray(true).unwrap();
        assert!(bg.hides_on_close());
        bg.quitting.store(true, Ordering::SeqCst);
        assert!(!bg.hides_on_close());
    }

    #[test]
    fn only_the_login_entry_starts_hidden() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(started_hidden(args(&["haruspex", HIDDEN_ARG])));
        assert!(!started_hidden(args(&["haruspex"])));
        assert!(!started_hidden(args(&["haruspex", "--hiddenx"])));
    }
}
