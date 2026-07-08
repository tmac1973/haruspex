//! Process-environment helpers shared across child-process spawn sites.

/// Compute the AppImage-sanitized `LD_LIBRARY_PATH` for a child process.
///
/// AppImage's AppRun script prepends the bundled `$APPDIR/usr/lib` to
/// `LD_LIBRARY_PATH` so the main binary can find its sidecar libs; that
/// path is then inherited by every child process, which can fail subtly
/// when AppImage-bundled libs (libssl, libpcre2, libnss3, …) ABI-collide
/// with the child's own. This strips `$APPDIR`-prefixed entries so the
/// child loads system libs instead. The receiver types differ per caller
/// (`std::process::Command` in `links.rs`, `portable_pty::CommandBuilder`
/// in `shell/session.rs`), so this returns the decision and each caller
/// applies it to its own builder:
///
///   - `None`          — not running inside an AppImage (`APPDIR` unset);
///     leave the child's env untouched.
///   - `Some(None)`    — every entry was AppImage-bundled; remove the var.
///   - `Some(Some(v))` — set `LD_LIBRARY_PATH` to `v` (bundled entries
///     stripped).
#[cfg(target_os = "linux")]
pub fn appimage_cleaned_ld_path() -> Option<Option<String>> {
    let appdir = match std::env::var("APPDIR") {
        Ok(v) if !v.is_empty() => v,
        _ => return None,
    };
    let current = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
    let cleaned: Vec<&str> = current
        .split(':')
        .filter(|p| !p.is_empty() && !p.starts_with(&appdir))
        .collect();
    if cleaned.is_empty() {
        Some(None)
    } else {
        Some(Some(cleaned.join(":")))
    }
}
