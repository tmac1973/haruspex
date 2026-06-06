use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use super::platform;

/// Captured at PTY spawn time. Cheap to read but doesn't change for the
/// lifetime of the shell session — distro upgrades mid-session would
/// require respawning anyway.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContext {
    pub os: String,
    pub kernel: String,
    pub distro_id: Option<String>,
    pub distro_name: Option<String>,
    pub distro_version: Option<String>,
    pub shell_path: String,
    pub shell_name: String,
    pub shell_version: Option<String>,
    pub home: Option<String>,
    pub hostname: Option<String>,
}

impl SessionContext {
    pub fn capture(shell_path: &str) -> Self {
        let kernel = uname_r();
        // OS / distro identity is platform-specific: Linux parses
        // /etc/os-release, macOS reads sw_vers. The kernel (uname -r),
        // shell, history, and hostname are captured the same way everywhere.
        let os_info = platform::capture_os();
        let os = os_info.os;
        let distro_id = os_info.distro_id;
        let distro_name = os_info.distro_name;
        let distro_version = os_info.distro_version;
        let shell_name = Path::new(shell_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(shell_path)
            .to_string();
        let shell_version = probe_shell_version(shell_path);
        Self {
            os,
            kernel,
            distro_id,
            distro_name,
            distro_version,
            shell_path: shell_path.to_string(),
            shell_name,
            shell_version,
            home: std::env::var("HOME").ok(),
            hostname: hostname(),
        }
    }
}

fn uname_r() -> String {
    Command::new("uname")
        .arg("-r")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn probe_shell_version(shell_path: &str) -> Option<String> {
    let name = Path::new(shell_path).file_name()?.to_str()?;
    // Most shells respond to --version on stdout; fish puts it there too.
    // bash prints to stdout; zsh prints to stdout; fish prints to stdout.
    let output = Command::new(shell_path).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // Take just the first line; bash/zsh print a verbose banner.
    let first_line = text.lines().next().unwrap_or("").trim().to_string();
    if first_line.is_empty() {
        None
    } else {
        Some(format!("{name}: {first_line}"))
    }
}

fn hostname() -> Option<String> {
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() {
            return Some(h);
        }
    }
    Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Best-effort read of the user's shell history. Returns at most `n`
/// most-recent commands. Empty Vec on failure or unrecognized shell.
pub fn read_recent_history(shell_name: &str, n: usize) -> Vec<String> {
    let path = match history_path(shell_name) {
        Some(p) => p,
        None => return Vec::new(),
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let lines: Vec<&str> = match shell_name {
        "zsh" => parse_zsh_history(&text),
        _ => text.lines().filter(|l| !l.is_empty()).collect(),
    };
    let start = lines.len().saturating_sub(n);
    lines[start..].iter().map(|s| s.to_string()).collect()
}

fn history_path(shell_name: &str) -> Option<PathBuf> {
    // Honor the standard env vars first.
    if let Ok(h) = std::env::var("HISTFILE") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    let home = std::env::var("HOME").ok()?;
    let file = match shell_name {
        "bash" => ".bash_history",
        "zsh" => ".zsh_history",
        "fish" => return Some(PathBuf::from(home).join(".local/share/fish/fish_history")),
        _ => return None,
    };
    Some(PathBuf::from(home).join(file))
}

/// zsh history lines optionally start with `: <timestamp>:<duration>;<cmd>`.
/// Multi-line commands use `\` continuation. Keep it simple: take the
/// command after the first `;` if the line starts with `:`, otherwise
/// take the whole line.
fn parse_zsh_history(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix(':') {
            if let Some((_, cmd)) = rest.split_once(';') {
                out.push(cmd);
                continue;
            }
        }
        out.push(line);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_zsh_history_with_timestamps() {
        let text = ": 1700000000:0;ls -la\n: 1700000010:1;echo hi\nplain command\n";
        let lines = parse_zsh_history(text);
        assert_eq!(lines, vec!["ls -la", "echo hi", "plain command"]);
    }
}
