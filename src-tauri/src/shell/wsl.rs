//! WSL bridge (Phase 17d).
//!
//! The Shell tab runs the interactive Linux shell inside a distro via
//! `wsl.exe -d <distro> -- bash --rcfile <wslpath>`, reusing the
//! platform-agnostic `haruspex.bash` hook unchanged. This module translates the
//! Windows resource path to a path the distro can read (and, in 17d-2, probes
//! in-distro OS/shell context).

/// Translate a Windows path ("C:\\Users\\tim\\x") to its default WSL mount path
/// ("/mnt/c/Users/tim/x"). Returns `None` if it isn't a drive-letter path.
///
/// Uses the standard `/mnt/<drive>` automount (the default), which avoids a
/// `wsl.exe wslpath` round-trip at spawn. A non-default `automount.root` in
/// wsl.conf would need `wslpath` instead — a documented edge case.
pub fn win_to_wsl_path(win: &str) -> Option<String> {
    let bytes = win.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return None;
    }
    let drive = win[0..1].to_ascii_lowercase();
    let rest = win[2..].replace('\\', "/");
    let rest = rest.trim_start_matches('/');
    Some(format!("/mnt/{drive}/{rest}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_drive_paths() {
        assert_eq!(
            win_to_wsl_path("C:\\Users\\tim\\proj").as_deref(),
            Some("/mnt/c/Users/tim/proj")
        );
        // Mixed/forward separators and a lowercase drive both normalize.
        assert_eq!(win_to_wsl_path("d:\\a/b").as_deref(), Some("/mnt/d/a/b"));
    }

    #[test]
    fn rejects_non_drive_paths() {
        assert_eq!(win_to_wsl_path("/already/unix"), None);
        assert_eq!(win_to_wsl_path("relative\\path"), None);
        assert_eq!(win_to_wsl_path(""), None);
    }
}
