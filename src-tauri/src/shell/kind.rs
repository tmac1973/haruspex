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
