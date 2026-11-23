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
//! On Linux we write the autostart file ourselves, at the path
//! `tauri-plugin-autostart` uses, because the plugin leaves `Exec=` unquoted
//! and a path with a space in it then starts nothing. An AppImage launch also
//! points an existing entry at itself, since an update is usually a new file
//! with a new name and the old one may be gone.
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
#[cfg(not(target_os = "linux"))]
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
    #[cfg(target_os = "linux")]
    if let Some(appimage) = app.env().appimage.map(PathBuf::from) {
        if let Some(file) = xdg::entry_file(&app.package_info().name) {
            match xdg::resync(&file, &appimage) {
                Ok(true) => log::info!("login entry now starts this AppImage"),
                Ok(false) => {}
                Err(e) => log::warn!("login entry not updated: {e}"),
            }
        }
    }
}

/// Whether the OS starts Haruspex at login.
#[cfg(target_os = "linux")]
fn login_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    xdg::entry_file(&app.package_info().name).is_some_and(|f| f.exists())
}

#[cfg(not(target_os = "linux"))]
fn login_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn set_login<R: Runtime>(app: &AppHandle<R>, on: bool) -> Result<(), String> {
    let file = xdg::entry_file(&app.package_info().name)
        .ok_or_else(|| "No home directory for the autostart file".to_string())?;
    if on {
        // An AppImage's own path, not the mount it runs from, which is gone
        // after a reboot.
        let exe = match app.env().appimage {
            Some(p) => PathBuf::from(p),
            None => std::env::current_exe().map_err(|e| e.to_string())?,
        };
        xdg::write(&file, &exe)
    } else {
        match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn set_login<R: Runtime>(app: &AppHandle<R>, on: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if on {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| e.to_string())
}

/// The XDG autostart file: `$XDG_CONFIG_HOME/autostart/<name>.desktop`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod xdg {
    use std::path::{Path, PathBuf};

    use super::HIDDEN_ARG;

    pub fn entry_file(app_name: &str) -> Option<PathBuf> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|h| !h.is_empty())
                    .map(|h| PathBuf::from(h).join(".config"))
            })?;
        Some(config.join("autostart").join(format!("{app_name}.desktop")))
    }

    /// One `Exec=` argument, quoted by the Desktop Entry rules: `"`, `` ` ``,
    /// `$` and `\` take a backslash inside the quotes, then the value's own
    /// string escapes apply on top (so a literal backslash is four), and `%`
    /// is doubled so it isn't read as a field code.
    pub fn quote_arg(arg: &str) -> String {
        let mut quoted = String::from("\"");
        for c in arg.chars() {
            if matches!(c, '"' | '`' | '$' | '\\') {
                quoted.push('\\');
            }
            quoted.push(c);
        }
        quoted.push('"');
        let mut out = String::new();
        for c in quoted.chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\t' => out.push_str("\\t"),
                '\r' => out.push_str("\\r"),
                '%' => out.push_str("%%"),
                c => out.push(c),
            }
        }
        out
    }

    pub fn contents(exe: &Path) -> String {
        format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Version=1.0\n\
             Name=Haruspex\n\
             Comment=Start Haruspex at login\n\
             Exec={} {HIDDEN_ARG}\n\
             StartupNotify=false\n\
             Terminal=false\n",
            quote_arg(&exe.to_string_lossy())
        )
    }

    pub fn write(file: &Path, exe: &Path) -> Result<(), String> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(file, contents(exe)).map_err(|e| e.to_string())
    }

    /// Rewrite an existing entry that doesn't start `exe` the way we would.
    /// No entry stays no entry. True when it was rewritten.
    pub fn resync(file: &Path, exe: &Path) -> Result<bool, String> {
        let Ok(current) = std::fs::read_to_string(file) else {
            return Ok(false);
        };
        if current == contents(exe) {
            return Ok(false);
        }
        write(file, exe)?;
        Ok(true)
    }
}

fn state<R: Runtime>(app: &AppHandle<R>) -> BackgroundState {
    BackgroundState {
        tray: app.state::<Background>().tray_enabled(),
        start_at_login: login_enabled(app),
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
    set_login(&app, on)?;
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

    #[test]
    fn exec_quotes_the_path() {
        assert_eq!(
            xdg::quote_arg("/usr/bin/haruspex"),
            r#""/usr/bin/haruspex""#
        );
        assert_eq!(
            xdg::quote_arg("/home/me/My Apps/Haruspex.AppImage"),
            r#""/home/me/My Apps/Haruspex.AppImage""#
        );
        // Shell-special characters take a backslash, which the string
        // escape then doubles; a literal backslash ends up as four.
        assert_eq!(xdg::quote_arg(r#"/a"b$c`d"#), r#""/a\\"b\\$c\\`d""#);
        assert_eq!(xdg::quote_arg(r"/a\b"), r#""/a\\\\b""#);
        assert_eq!(xdg::quote_arg("/100%"), r#""/100%%""#);
    }

    #[test]
    fn the_entry_starts_hidden() {
        let entry = xdg::contents(Path::new("/opt/Haruspex 1.AppImage"));
        assert!(entry.contains("\nExec=\"/opt/Haruspex 1.AppImage\" --hidden\n"));
        assert!(entry.starts_with("[Desktop Entry]\n"));
    }

    #[test]
    fn resync_points_an_entry_at_the_new_appimage() {
        let dir = temp_dir("background-resync");
        let file = dir.join("autostart").join("Haruspex.desktop");
        let new = Path::new("/home/me/Haruspex_0.3.0.AppImage");

        // No entry: the user never turned it on, so none appears.
        assert!(!xdg::resync(&file, new).unwrap());
        assert!(!file.exists());

        // The plugin's old unquoted entry for an older AppImage.
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            "[Desktop Entry]\nExec=/home/me/Haruspex_0.2.9.AppImage --hidden\n",
        )
        .unwrap();
        assert!(xdg::resync(&file, new).unwrap());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), xdg::contents(new));

        // Already right: left alone.
        assert!(!xdg::resync(&file, new).unwrap());
    }
}
