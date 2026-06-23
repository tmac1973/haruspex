//! WSL bridge (Phase 17d).
//!
//! The Shell tab runs the interactive Linux shell inside a distro via
//! `wsl.exe -d <distro> -- bash --rcfile <wslpath>`, reusing the
//! platform-agnostic `haruspex.bash` hook unchanged. This module translates the
//! Windows resource path to a path the distro can read, and probes the distro
//! for its OS/shell identity so the session context reflects the distro, not the
//! Windows host.

use super::context::SessionContext;

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

/// One-shot probe (one wsl.exe spawn) that emits the distro's identity for
/// `build_context` to parse. `bash -c` so `$BASH_VERSION` is set.
const PROBE: &str = "printf 'KERNEL=%s\\n' \"$(uname -r)\"; \
                     printf 'HOME=%s\\n' \"$HOME\"; \
                     printf 'HOSTNAME=%s\\n' \"$(hostname 2>/dev/null)\"; \
                     printf 'BASHVER=%s\\n' \"$BASH_VERSION\"; \
                     echo '---OSRELEASE---'; \
                     cat /etc/os-release 2>/dev/null";

/// Capture session context from *inside* a WSL distro (uname/os-release/home/
/// hostname/bash version) so the badge reads e.g. "Ubuntu 24.04 · bash · Linux
/// …-WSL2". Returns `None` if the distro can't be probed (also the case off
/// Windows, where `wsl.exe` doesn't exist) so the caller falls back to host
/// capture. Captured once at spawn — `wsl.exe` probes are slow.
pub fn capture_context(distro: &str) -> Option<SessionContext> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-d", distro, "--", "bash", "-c", PROBE]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    if text.trim().is_empty() {
        return None;
    }
    Some(build_context(&text))
}

fn build_context(text: &str) -> SessionContext {
    let mut kernel = "unknown".to_string();
    let mut home = None;
    let mut hostname = None;
    let mut bashver = None;
    let mut os_release = String::new();
    let mut in_os_release = false;

    for line in text.lines() {
        if in_os_release {
            os_release.push_str(line);
            os_release.push('\n');
            continue;
        }
        if line.trim() == "---OSRELEASE---" {
            in_os_release = true;
        } else if let Some(v) = line.strip_prefix("KERNEL=") {
            if !v.is_empty() {
                kernel = v.to_string();
            }
        } else if let Some(v) = line.strip_prefix("HOME=") {
            if !v.is_empty() {
                home = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("HOSTNAME=") {
            if !v.is_empty() {
                hostname = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("BASHVER=") {
            if !v.is_empty() {
                bashver = Some(v.to_string());
            }
        }
    }

    let (distro_id, distro_name, distro_version) = parse_os_release(&os_release);
    SessionContext {
        os: "linux".to_string(),
        kernel,
        distro_id,
        distro_name,
        distro_version,
        // We always launch the distro via bash (the injection shell).
        shell_path: "/bin/bash".to_string(),
        shell_name: "bash".to_string(),
        shell_version: bashver.map(|v| format!("bash {v}")),
        home,
        hostname,
    }
}

/// Parse `/etc/os-release` text for id / pretty name / version. Mirrors the
/// file-based parser in `platform.rs`, but for a string we captured over the
/// wsl.exe bridge.
fn parse_os_release(text: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut id = None;
    let mut pretty = None;
    let mut name = None;
    let mut version = None;
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim().trim_matches('"').to_string();
        match k {
            "ID" => id = Some(v),
            "PRETTY_NAME" => pretty = Some(v),
            "NAME" => name = Some(v),
            "VERSION_ID" => version = Some(v),
            _ => {}
        }
    }
    // Prefer PRETTY_NAME ("Ubuntu 24.04 LTS") over NAME ("Ubuntu") regardless of
    // the order they appear in the file.
    (id, pretty.or(name), version)
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
        assert_eq!(win_to_wsl_path("d:\\a/b").as_deref(), Some("/mnt/d/a/b"));
    }

    #[test]
    fn rejects_non_drive_paths() {
        assert_eq!(win_to_wsl_path("/already/unix"), None);
        assert_eq!(win_to_wsl_path("relative\\path"), None);
        assert_eq!(win_to_wsl_path(""), None);
    }

    #[test]
    fn builds_context_from_probe_output() {
        let sample = "KERNEL=5.15.0-microsoft-standard-WSL2\n\
                      HOME=/home/tim\n\
                      HOSTNAME=wintest\n\
                      BASHVER=5.2.21(1)-release\n\
                      ---OSRELEASE---\n\
                      NAME=\"Ubuntu\"\n\
                      VERSION_ID=\"24.04\"\n\
                      ID=ubuntu\n\
                      PRETTY_NAME=\"Ubuntu 24.04 LTS\"\n";
        let ctx = build_context(sample);
        assert_eq!(ctx.os, "linux");
        assert_eq!(ctx.kernel, "5.15.0-microsoft-standard-WSL2");
        assert_eq!(ctx.distro_id.as_deref(), Some("ubuntu"));
        assert_eq!(ctx.distro_name.as_deref(), Some("Ubuntu 24.04 LTS"));
        assert_eq!(ctx.distro_version.as_deref(), Some("24.04"));
        assert_eq!(ctx.shell_name, "bash");
        assert_eq!(ctx.home.as_deref(), Some("/home/tim"));
        assert_eq!(ctx.hostname.as_deref(), Some("wintest"));
        assert!(ctx.shell_version.as_deref().unwrap().contains("5.2.21"));
    }
}
