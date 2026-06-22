//! The set of shells the user can pick in the Shell-tab toolbar.
//!
//! On Windows this enumerates PowerShell 7 (`pwsh.exe`), Windows PowerShell 5.1
//! (`powershell.exe`), and every installed WSL2 distro; a known-but-uninstalled
//! shell is returned greyed-out with an install hint rather than hidden. On
//! other platforms it returns a single native entry so the picker is harmless
//! cross-platform. Enumeration never errors — a missing `wsl.exe` or zero
//! distros must not break the picker.

use serde::Serialize;

use super::kind::ShellSelection;

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ShellCatalogEntry {
    /// Stable id for persisting the selection (e.g. "pwsh", "powershell",
    /// "wsl:Ubuntu", "native").
    pub id: String,
    /// Human label for the picker.
    pub label: String,
    /// How to spawn this shell. `None` for the non-Windows native entry, which
    /// uses the legacy shell-path resolution.
    pub selection: Option<ShellSelection>,
    /// Whether the shell is installed/usable. Uninstalled entries render
    /// greyed-out and aren't pickable.
    pub installed: bool,
    /// Hint shown on a greyed-out entry (e.g. "Install PowerShell 7").
    pub install_hint: Option<String>,
    /// The default pick for a fresh session.
    pub is_default: bool,
}

pub fn enumerate_shells() -> Vec<ShellCatalogEntry> {
    imp::enumerate_shells()
}

#[cfg(target_os = "windows")]
mod imp {
    use super::ShellCatalogEntry;
    use crate::shell::kind::ShellSelection;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn enumerate_shells() -> Vec<ShellCatalogEntry> {
        let mut out = Vec::new();

        // PowerShell 7 (pwsh) — the preferred default when installed.
        let pwsh = find_pwsh();
        let pwsh_installed = pwsh.is_some();
        out.push(ShellCatalogEntry {
            id: "pwsh".to_string(),
            label: "PowerShell 7".to_string(),
            selection: Some(ShellSelection::Powershell {
                exe: pwsh.unwrap_or_else(|| "pwsh.exe".to_string()),
            }),
            installed: pwsh_installed,
            install_hint: if pwsh_installed {
                None
            } else {
                Some("Install PowerShell 7".to_string())
            },
            is_default: pwsh_installed,
        });

        // Windows PowerShell 5.1 — always in-box; default only if pwsh absent.
        out.push(ShellCatalogEntry {
            id: "powershell".to_string(),
            label: "Windows PowerShell".to_string(),
            selection: Some(ShellSelection::Powershell {
                exe: find_powershell().unwrap_or_else(|| "powershell.exe".to_string()),
            }),
            installed: true,
            install_hint: None,
            is_default: !pwsh_installed,
        });

        out.extend(enumerate_wsl());
        out
    }

    fn find_pwsh() -> Option<String> {
        find_on_path("pwsh.exe").or_else(|| {
            let pf = std::env::var_os("ProgramFiles")?;
            let candidate = PathBuf::from(pf)
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe");
            candidate
                .is_file()
                .then(|| candidate.to_string_lossy().into_owned())
        })
    }

    fn find_powershell() -> Option<String> {
        find_on_path("powershell.exe").or_else(|| {
            let sysroot = std::env::var_os("SystemRoot")?;
            let candidate = PathBuf::from(sysroot)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            candidate
                .is_file()
                .then(|| candidate.to_string_lossy().into_owned())
        })
    }

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

    /// One entry per WSL2 distro, or a single greyed-out "No WSL distros found"
    /// entry when WSL isn't installed or has no v2 distros.
    fn enumerate_wsl() -> Vec<ShellCatalogEntry> {
        let names = match Command::new("wsl.exe")
            .args(["-l", "-v"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) if o.status.success() => parse_wsl_list(&decode_utf16le(&o.stdout)),
            _ => Vec::new(),
        };
        if names.is_empty() {
            return vec![ShellCatalogEntry {
                id: "wsl".to_string(),
                label: "WSL".to_string(),
                selection: None,
                installed: false,
                install_hint: Some("No WSL distros found".to_string()),
                is_default: false,
            }];
        }
        names
            .into_iter()
            .map(|name| ShellCatalogEntry {
                id: format!("wsl:{name}"),
                label: name.clone(),
                selection: Some(ShellSelection::Wsl { distro: name }),
                installed: true,
                install_hint: None,
                // PowerShell stays the default; WSL is opt-in via the picker.
                is_default: false,
            })
            .collect()
    }

    /// `wsl.exe` emits UTF-16LE. Decode to a String, lossily.
    fn decode_utf16le(bytes: &[u8]) -> String {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    }

    /// Parse the `wsl -l -v` table (`* NAME  STATE  VERSION`), keeping only
    /// VERSION 2 distro names. The first line is the header.
    fn parse_wsl_list(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        for (i, line) in text.lines().enumerate() {
            if i == 0 {
                continue;
            }
            let cleaned = line.trim().trim_start_matches('*').trim();
            if cleaned.is_empty() {
                continue;
            }
            let cols: Vec<&str> = cleaned.split_whitespace().collect();
            // NAME STATE VERSION — NAME never contains spaces.
            if cols.len() >= 3 && cols[cols.len() - 1] == "2" {
                out.push(cols[0].to_string());
            }
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_wsl_list_v2_only() {
            let sample = "  NAME            STATE           VERSION\n\
                          * Ubuntu          Running         2\n\
                          \u{20}\u{20}Debian          Stopped         2\n\
                          \u{20}\u{20}Legacy          Stopped         1\n";
            assert_eq!(parse_wsl_list(sample), vec!["Ubuntu", "Debian"]);
        }

        #[test]
        fn catalog_lists_both_powershells() {
            let entries = enumerate_shells();
            assert!(entries.iter().any(|e| e.id == "powershell" && e.installed));
            assert!(entries.iter().any(|e| e.id == "pwsh"));
            // Exactly one default.
            assert_eq!(entries.iter().filter(|e| e.is_default).count(), 1);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::ShellCatalogEntry;
    use std::path::Path;

    pub fn enumerate_shells() -> Vec<ShellCatalogEntry> {
        let shell = crate::shell::platform::default_shell();
        let label = Path::new(&shell)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(shell.as_str())
            .to_string();
        vec![ShellCatalogEntry {
            id: "native".to_string(),
            label,
            selection: None,
            installed: true,
            install_hint: None,
            is_default: true,
        }]
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn native_entry_is_the_only_default() {
            let entries = enumerate_shells();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].id, "native");
            assert!(entries[0].is_default);
            assert!(entries[0].selection.is_none());
        }
    }
}
