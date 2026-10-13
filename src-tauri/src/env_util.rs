//! Process-environment helpers: the environment variables Haruspex reads of
//! its own, and the corrections child processes need.
//!
//! ## Haruspex's own variables
//!
//! Every variable that changes how Haruspex behaves is read through an
//! accessor here, so this table is the whole list:
//!
//! | Variable | Read | Effect |
//! |---|---|---|
//! | `HARUSPEX_DEBUG_LOG_FILE` | at startup, any build | Mirror the agent debug log — prompts, tool output, model replies, clipped unless verbose payloads are on — to `agent-debug.log` in the app's log folder ([`debug_log_file_requested`]). Debug builds do this regardless. |
//! | `HARUSPEX_BROWSER_PATH` | per search | The browser the "browser" search provider drives, when Settings names none ([`browser_path_override`]). |
//! | `HARUSPEX_GOOGLE_CLIENT_ID`, `HARUSPEX_GOOGLE_CLIENT_SECRET` | at build time (`option_env!`, `integrations/dav/google.rs`) | The Google sign-in client; unset means a build without Google sign-in. |
//!
//! The rest of the `HARUSPEX_*` names in the source are test fixtures, read
//! only inside `#[cfg(test)]` (`HARUSPEX_PDEATH_CHILD`, `HARUSPEX_GOOGLE_TOKEN_FILE`,
//! `HARUSPEX_TILE_DIR` and the like). Conventions of the OS or of a library —
//! `HOME`, `PATH`, `SHELL`, `XDG_*`, `USERPROFILE`, `APPDIR`, `HF_HOME` — are
//! read where they are used.

/// See the table above.
pub const DEBUG_LOG_FILE_VAR: &str = "HARUSPEX_DEBUG_LOG_FILE";

/// Whether `HARUSPEX_DEBUG_LOG_FILE` asks for the debug log on disk. Any
/// value counts, as a release build has no other way to turn it on.
pub fn debug_log_file_requested() -> bool {
    std::env::var_os(DEBUG_LOG_FILE_VAR).is_some()
}

/// See the table above.
pub const BROWSER_PATH_VAR: &str = "HARUSPEX_BROWSER_PATH";

/// The browser `HARUSPEX_BROWSER_PATH` names, if it names one. For headless
/// and CI runs, and for the layout nobody's detection anticipated.
pub fn browser_path_override() -> Option<String> {
    std::env::var(BROWSER_PATH_VAR)
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// One correction to apply to a child process's environment.
///
/// Returned by [`appimage_env_fixes`]. The receiver types differ per
/// caller (`std::process::Command` in `links.rs`,
/// `portable_pty::CommandBuilder` in `shell/session.rs`), so this
/// returns the decisions and each caller applies them to its own
/// builder.
#[cfg(target_os = "linux")]
pub enum EnvFix {
    /// Remove the variable from the child's environment.
    Remove(&'static str),
    /// Set the variable to the given cleaned value.
    Set(&'static str, String),
}

/// Compute the corrections needed to undo AppImage's AppRun env mangling
/// for a child process.
///
/// AppImage's AppRun script points several variables into the mounted
/// `$APPDIR` so the main binary can find its bundled payload; every
/// child process then inherits them, which breaks tools that expect the
/// system layout:
///
///   - `LD_LIBRARY_PATH` gets `$APPDIR/usr/lib` prepended, so children
///     load AppImage-bundled libs (libssl, libpcre2, libnss3, …) that
///     can ABI-collide with their own.
///   - `PYTHONHOME` / `PYTHONPATH` point at `$APPDIR/usr/`, which
///     bundles no Python stdlib — any `python` run by a child fails to
///     even initialize ("Could not find platform independent
///     libraries"), and the mount vanishes once the app exits.
///   - `PYTHONDONTWRITEBYTECODE=1` is exported alongside them.
///
/// Path-list variables keep any entries the user had that aren't
/// `$APPDIR`-prefixed; `PYTHONHOME` is dropped only when it points into
/// `$APPDIR` (and `PYTHONDONTWRITEBYTECODE` with it, since an
/// AppImage-set `PYTHONHOME` is the tell that AppRun exported both).
/// Returns no fixes when not running inside an AppImage (`APPDIR`
/// unset), so dev mode and .deb / .rpm installs are unaffected.
#[cfg(target_os = "linux")]
pub fn appimage_env_fixes() -> Vec<EnvFix> {
    let appdir = match std::env::var("APPDIR") {
        Ok(v) if !v.is_empty() => v,
        _ => return Vec::new(),
    };
    let get = |var: &str| std::env::var(var).unwrap_or_default();
    let mut fixes = vec![
        path_list_fix("LD_LIBRARY_PATH", &get("LD_LIBRARY_PATH"), &appdir),
        path_list_fix("PYTHONPATH", &get("PYTHONPATH"), &appdir),
    ];
    if get("PYTHONHOME").starts_with(&appdir) {
        fixes.push(EnvFix::Remove("PYTHONHOME"));
        fixes.push(EnvFix::Remove("PYTHONDONTWRITEBYTECODE"));
    }
    fixes
}

/// Apply [`appimage_env_fixes`] to a std `Command` (a tokio one through
/// `as_std_mut`). Every host child that may run the user's own tools needs
/// it: the URL opener, the Code tab's commands, git. The PTY spawn in
/// `shell/session.rs` applies the same fixes to its own builder.
#[cfg(target_os = "linux")]
pub fn sanitize_appimage_env(cmd: &mut std::process::Command) {
    for fix in appimage_env_fixes() {
        match fix {
            EnvFix::Remove(var) => {
                cmd.env_remove(var);
            }
            EnvFix::Set(var, value) => {
                cmd.env(var, value);
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
pub fn sanitize_appimage_env(_cmd: &mut std::process::Command) {}

/// Strip `$APPDIR`-prefixed entries from a colon-separated path list,
/// removing the variable outright when nothing survives.
#[cfg(target_os = "linux")]
fn path_list_fix(var: &'static str, value: &str, appdir: &str) -> EnvFix {
    let cleaned: Vec<&str> = value
        .split(':')
        .filter(|p| !p.is_empty() && !p.starts_with(appdir))
        .collect();
    if cleaned.is_empty() {
        EnvFix::Remove(var)
    } else {
        EnvFix::Set(var, cleaned.join(":"))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    const APPDIR: &str = "/tmp/.mount_Haruspx";

    #[test]
    fn path_list_all_appimage_entries_removes_var() {
        // AppRun's exact shape: bundled entry plus a trailing colon from
        // appending an empty inherited value.
        let fix = path_list_fix(
            "PYTHONPATH",
            "/tmp/.mount_Haruspx/usr/share/pyshared/:",
            APPDIR,
        );
        assert!(matches!(fix, EnvFix::Remove("PYTHONPATH")));
    }

    #[test]
    fn path_list_keeps_user_entries() {
        let fix = path_list_fix(
            "LD_LIBRARY_PATH",
            "/tmp/.mount_Haruspx/usr/lib:/opt/mylibs:/tmp/.mount_Haruspx/usr/lib/x86_64",
            APPDIR,
        );
        match fix {
            EnvFix::Set("LD_LIBRARY_PATH", v) => assert_eq!(v, "/opt/mylibs"),
            _ => panic!("expected Set with cleaned value"),
        }
    }

    #[test]
    fn path_list_empty_value_removes_var() {
        let fix = path_list_fix("LD_LIBRARY_PATH", "", APPDIR);
        assert!(matches!(fix, EnvFix::Remove("LD_LIBRARY_PATH")));
    }
}
