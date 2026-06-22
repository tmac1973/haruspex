//! Per-OS shell behavior behind a single seam.
//!
//! Phase 15 left this file as a planned-but-uncreated abstraction; Phase 16
//! creates it with two real implementors (Linux + macOS) so the design is
//! proven before Windows (Phase 17 — the most divergent branch) plugs in
//! here without touching the Linux/macOS code paths.
//!
//! Everything platform-varying about spawning a shell and describing the host
//! lives behind this module:
//!   - `default_shell()`     — fallback shell when neither override nor $SHELL resolves
//!   - `login_args()`        — extra argv to launch the shell in login mode where needed
//!   - `login_env()`         — env overrides (PATH seed) for shells not launched login
//!   - `capture_os()`        — OS / distro identity for the session context
//!   - `platform_supported()`— whether the Shell tab opens on this host

/// OS / distro identity captured at spawn time. Mirrors the subset of
/// `SessionContext` fields that vary by platform; `context.rs` fills the
/// rest (kernel, shell, hostname, …) which are captured the same way
/// everywhere.
#[derive(Debug, Clone)]
pub struct OsInfo {
    pub os: String,
    pub distro_id: Option<String>,
    pub distro_name: Option<String>,
    pub distro_version: Option<String>,
}

pub use imp::{capture_os, default_shell, login_args, login_env, platform_supported};

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------
#[cfg(target_os = "linux")]
mod imp {
    use super::OsInfo;
    use std::fs;

    pub fn default_shell() -> String {
        "/bin/bash".to_string()
    }

    /// Linux GUI sessions inherit a usable PATH, so no login wrapping is
    /// needed — the shell launches non-login and our `--rcfile` / `ZDOTDIR`
    /// injection sources the user's rc plus our OSC 133 hook.
    pub fn login_args(_shell_path: &str) -> Vec<String> {
        Vec::new()
    }

    pub fn login_env(_shell_path: &str) -> Vec<(String, String)> {
        Vec::new()
    }

    pub fn platform_supported() -> bool {
        true
    }

    pub fn capture_os() -> OsInfo {
        let (distro_id, distro_name, distro_version) = parse_os_release();
        OsInfo {
            os: std::env::consts::OS.to_string(),
            distro_id,
            distro_name,
            distro_version,
        }
    }

    /// Read `/etc/os-release` (or its `/usr/lib` fallback) for the distro
    /// id / pretty name / version. Returns all-None if neither file exists
    /// or parses — the caller degrades to just the bare OS string.
    fn parse_os_release() -> (Option<String>, Option<String>, Option<String>) {
        let candidates = ["/etc/os-release", "/usr/lib/os-release"];
        for path in candidates {
            if let Ok(text) = fs::read_to_string(path) {
                let mut id = None;
                let mut name = None;
                let mut version = None;
                for line in text.lines() {
                    let Some((k, v)) = line.split_once('=') else {
                        continue;
                    };
                    let v = v.trim().trim_matches('"').to_string();
                    match k {
                        "ID" => id = Some(v),
                        "PRETTY_NAME" if name.is_none() => name = Some(v),
                        "NAME" if name.is_none() => name = Some(v),
                        "VERSION_ID" => version = Some(v),
                        _ => {}
                    }
                }
                return (id, name, version);
            }
        }
        (None, None, None)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn default_shell_is_bash() {
            assert_eq!(default_shell(), "/bin/bash");
        }

        #[test]
        fn login_args_empty_on_linux() {
            assert!(login_args("/bin/bash").is_empty());
            assert!(login_args("/bin/zsh").is_empty());
        }

        #[test]
        fn capture_os_reports_linux() {
            let info = capture_os();
            assert_eq!(info.os, "linux");
        }

        // No test for parse_os_release: it reads /etc/os-release directly
        // (no injectable input), so any assertion on its output would just
        // restate whatever distro the test box happens to run.
    }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
mod imp {
    use super::OsInfo;
    use std::path::Path;
    use std::process::Command;

    /// macOS guarantees `/bin/zsh` and it is the platform default since
    /// 10.15. `/bin/bash` exists but is Apple's frozen 3.2 and is *not* the
    /// default — falling back to it would surprise Mac users.
    pub fn default_shell() -> String {
        "/bin/zsh".to_string()
    }

    /// macOS GUI apps inherit a minimal `launchd` PATH (no `/opt/homebrew/bin`).
    /// Launching the interactive shell as a *login* shell makes
    /// `/etc/zprofile` → `/usr/libexec/path_helper` and the user's
    /// `~/.zprofile`/`~/.zshrc` populate PATH the same way Terminal.app does.
    ///
    /// We do this for zsh (and any other shell), but **not** bash: a login
    /// bash reads `~/.bash_profile` and ignores `--rcfile`, which would drop
    /// our OSC 133 hook. bash gets its PATH seeded via `login_env()` instead.
    pub fn login_args(shell_path: &str) -> Vec<String> {
        if shell_basename(shell_path) == "bash" {
            Vec::new()
        } else {
            vec!["-l".to_string()]
        }
    }

    /// Env overrides for shells we did *not* launch in login mode. Such a
    /// shell never runs `path_helper`, so without this it would only see the
    /// GUI app's minimal PATH and Homebrew tools wouldn't resolve. We probe
    /// the shell's own login PATH once and seed it via the spawn env.
    ///
    /// Complements `login_args()`: a shell that got `-l` populates PATH
    /// itself, so this returns nothing for it.
    pub fn login_env(shell_path: &str) -> Vec<(String, String)> {
        if !login_args(shell_path).is_empty() {
            return Vec::new();
        }
        match probe_login_path(shell_path) {
            Some(path) => vec![("PATH".to_string(), path)],
            None => Vec::new(),
        }
    }

    pub fn platform_supported() -> bool {
        true
    }

    /// Capture the OS identity from `sw_vers`. `/etc/os-release` does not
    /// exist on macOS; `sw_vers` is the canonical source. Degrades to a bare
    /// `os = "macos"` with `distro_id = "macos"` (and None name/version) if
    /// `sw_vers` is somehow unavailable, mirroring the Linux "returns
    /// nothing" path rather than panicking.
    pub fn capture_os() -> OsInfo {
        let product_name = sw_vers("-productName");
        let product_version = sw_vers("-productVersion");
        let build_version = sw_vers("-buildVersion");

        // Human distro string: "14.5 (23F79)" when both are present, else
        // just the version. Combined with distro_name this renders as e.g.
        // "macOS 14.5 (23F79)" in the assistant's session context.
        let distro_version = match (&product_version, &build_version) {
            (Some(v), Some(b)) => Some(format!("{v} ({b})")),
            (Some(v), None) => Some(v.clone()),
            _ => None,
        };

        OsInfo {
            os: std::env::consts::OS.to_string(),
            distro_id: Some("macos".to_string()),
            distro_name: Some(product_name.unwrap_or_else(|| "macOS".to_string())),
            distro_version,
        }
    }

    fn shell_basename(shell_path: &str) -> &str {
        Path::new(shell_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
    }

    fn sw_vers(flag: &str) -> Option<String> {
        let output = Command::new("sw_vers").arg(flag).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let s = String::from_utf8(output.stdout).ok()?.trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    /// Probe the shell's login PATH by running it as `<shell> -lc 'print PATH'`.
    /// Using the same shell binary we're about to launch means a bash user's
    /// `~/.bash_profile` additions are captured (probing zsh wouldn't see
    /// them). Returns None on any failure so the caller leaves PATH untouched.
    fn probe_login_path(shell_path: &str) -> Option<String> {
        let output = Command::new(shell_path)
            .arg("-l")
            .arg("-c")
            .arg("printf '%s' \"$PATH\"")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8(output.stdout).ok()?.trim().to_string();
        // Sanity-check it actually looks like a PATH before trusting it.
        if path.is_empty() || !path.contains('/') {
            None
        } else {
            Some(path)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn default_shell_is_zsh() {
            assert_eq!(default_shell(), "/bin/zsh");
        }

        #[test]
        fn login_args_uses_l_except_for_bash() {
            assert_eq!(login_args("/bin/zsh"), vec!["-l".to_string()]);
            assert_eq!(login_args("/usr/local/bin/fish"), vec!["-l".to_string()]);
            assert!(login_args("/bin/bash").is_empty());
        }

        #[test]
        fn capture_os_reports_macos() {
            let info = capture_os();
            assert_eq!(info.os, "macos");
            assert_eq!(info.distro_id.as_deref(), Some("macos"));
            // distro_name is always populated (falls back to "macOS").
            assert!(info.distro_name.is_some());
        }

        #[test]
        fn probe_login_path_returns_a_path() {
            // /bin/zsh is guaranteed on macOS; a login shell must yield a
            // non-empty PATH containing at least one '/'.
            let path = probe_login_path("/bin/zsh");
            assert!(path.is_some());
            assert!(path.unwrap().contains('/'));
        }
    }
}

// ---------------------------------------------------------------------------
// Windows (Phase 17) — PowerShell over ConPTY.
//
// 17a is a bare-terminal baseline: default to PowerShell, no integration
// injection yet (PowerShell gets a passthrough SpawnPlan in pty.rs, OSC 133
// via haruspex.ps1 lands in 17c). The tab is gated behind the
// HARUSPEX_WIN_SHELL dev flag until the port is complete (17e). The shell
// catalog / WSL bridge / ShellKind routing arrive in later sub-phases.
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
mod imp {
    use super::OsInfo;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// Suppress the console window that would otherwise flash when we shell
    /// out (e.g. `cmd /c ver`) from the GUI app.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Prefer PowerShell 7 (`pwsh.exe`) when installed; otherwise fall back to
    /// Windows PowerShell 5.1 (`powershell.exe`), which ships in-box under
    /// System32 and is always resolvable. CMD is intentionally excluded.
    pub fn default_shell() -> String {
        find_on_path("pwsh.exe").unwrap_or_else(|| "powershell.exe".to_string())
    }

    /// No login-shell wrapping on Windows. PowerShell loads `$PROFILE`
    /// automatically; our OSC 133 injection (17c, haruspex.ps1) is layered on
    /// later via the spawn plan, not here.
    pub fn login_args(_shell_path: &str) -> Vec<String> {
        Vec::new()
    }

    pub fn login_env(_shell_path: &str) -> Vec<(String, String)> {
        Vec::new()
    }

    /// Phase 17 is in progress: the Windows Shell tab is gated behind a dev
    /// flag until the port is complete (17e). Set `HARUSPEX_WIN_SHELL=1`
    /// before launching to test the work in progress.
    pub fn platform_supported() -> bool {
        std::env::var_os("HARUSPEX_WIN_SHELL").is_some()
    }

    /// Minimal host identity for 17a: `os = "windows"` plus the build string
    /// from `cmd /c ver`. Richer capture (registry DisplayVersion / "23H2",
    /// `$PSVersionTable`) lands in 17c.
    pub fn capture_os() -> OsInfo {
        let version = windows_version();
        OsInfo {
            os: std::env::consts::OS.to_string(),
            distro_id: Some("windows".to_string()),
            distro_name: Some(windows_product_name(version.as_deref())),
            distro_version: version,
        }
    }

    /// Friendly product name from the build number in "10.0.<build>.x": build
    /// 22000+ is Windows 11, the 10.x line below that is Windows 10. (Microsoft
    /// never bumped the major to 11, so the build is the only reliable signal.)
    fn windows_product_name(version: Option<&str>) -> String {
        let build = version
            .and_then(|v| v.split('.').nth(2))
            .and_then(|b| b.parse::<u32>().ok());
        match build {
            Some(b) if b >= 22000 => "Windows 11".to_string(),
            Some(_) => "Windows 10".to_string(),
            None => "Windows".to_string(),
        }
    }

    /// Search PATH for `exe`, returning its full path if found.
    fn find_on_path(exe: &str) -> Option<String> {
        let paths = std::env::var_os("PATH")?;
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        None
    }

    /// Parse `cmd /c ver` → e.g. "10.0.22631.4317". None on any failure.
    fn windows_version() -> Option<String> {
        let output = Command::new("cmd")
            .args(["/C", "ver"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let start = text.find('[')?;
        let end = text[start..].find(']')? + start;
        let inner = text[start + 1..end].trim();
        let v = inner.strip_prefix("Version ").unwrap_or(inner).trim();
        if v.is_empty() {
            None
        } else {
            Some(v.to_string())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn default_shell_is_powershell() {
            let s = default_shell();
            assert!(
                s.ends_with("pwsh.exe") || s.ends_with("powershell.exe"),
                "got: {s}"
            );
        }

        #[test]
        fn capture_os_reports_windows() {
            let info = capture_os();
            assert_eq!(info.os, "windows");
            assert_eq!(info.distro_id.as_deref(), Some("windows"));
            // "Windows", "Windows 10", or "Windows 11" depending on the build.
            assert!(info
                .distro_name
                .as_deref()
                .unwrap_or("")
                .starts_with("Windows"));
        }

        #[test]
        fn product_name_from_build() {
            assert_eq!(windows_product_name(Some("10.0.22631.4317")), "Windows 11");
            assert_eq!(windows_product_name(Some("10.0.19045.4291")), "Windows 10");
            assert_eq!(windows_product_name(None), "Windows");
        }
    }
}

// ---------------------------------------------------------------------------
// Other (non-Linux/macOS/Windows) — keeps the crate compiling on platforms
// whose real implementation hasn't landed.
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod imp {
    use super::OsInfo;

    pub fn default_shell() -> String {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }

    pub fn login_args(_shell_path: &str) -> Vec<String> {
        Vec::new()
    }

    pub fn login_env(_shell_path: &str) -> Vec<(String, String)> {
        Vec::new()
    }

    pub fn platform_supported() -> bool {
        false
    }

    pub fn capture_os() -> OsInfo {
        OsInfo {
            os: std::env::consts::OS.to_string(),
            distro_id: None,
            distro_name: None,
            distro_version: None,
        }
    }
}
