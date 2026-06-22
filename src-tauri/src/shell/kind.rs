//! What shell a Windows Shell-tab session runs.
//!
//! PowerShell variants run natively over ConPTY; WSL distros run the Linux
//! shell inside the named distro via `wsl.exe`. Linux/macOS sessions don't use
//! this — they resolve a plain shell path via the legacy `shell_override`
//! string and a `None` selection.

use serde::{Deserialize, Serialize};

/// A concrete shell the user can launch, as sent from the picker. Serialized
/// with an internal `kind` tag, so the frontend sends
/// `{ kind: "powershell", exe: "..." }` or `{ kind: "wsl", distro: "Ubuntu" }`.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ShellSelection {
    /// Native PowerShell. `exe` is the resolved path to `pwsh.exe` /
    /// `powershell.exe`.
    Powershell { exe: String },
    /// A WSL2 distro; the interactive Linux shell runs inside it.
    Wsl { distro: String },
}

/// The program + leading args to spawn for a selection, before any OSC 133
/// integration args the spawn plan layers on. `program` is what
/// `CommandBuilder::new` execs; `args` come first in the child's argv.
pub struct ShellSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl ShellSelection {
    pub fn to_spec(&self) -> ShellSpec {
        match self {
            ShellSelection::Powershell { exe } => ShellSpec {
                program: exe.clone(),
                args: Vec::new(),
            },
            ShellSelection::Wsl { distro } => ShellSpec {
                // `wsl.exe -d <distro>` launches the distro's default login
                // shell. In-distro OSC 133 injection (the --rcfile bridge) is
                // 17d; 17b is a bare WSL terminal.
                program: "wsl.exe".to_string(),
                args: vec!["-d".to_string(), distro.clone()],
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_spec_is_just_the_exe() {
        let spec = ShellSelection::Powershell {
            exe: "C:\\pwsh.exe".to_string(),
        }
        .to_spec();
        assert_eq!(spec.program, "C:\\pwsh.exe");
        assert!(spec.args.is_empty());
    }

    #[test]
    fn wsl_spec_invokes_distro() {
        let spec = ShellSelection::Wsl {
            distro: "Ubuntu".to_string(),
        }
        .to_spec();
        assert_eq!(spec.program, "wsl.exe");
        assert_eq!(spec.args, vec!["-d".to_string(), "Ubuntu".to_string()]);
    }
}
