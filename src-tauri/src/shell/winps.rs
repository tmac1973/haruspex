//! PowerShell OSC 133 injection (Phase 17c).
//!
//! PowerShell has no `--rcfile`/`ZDOTDIR` equivalent, so we inject our hook by
//! launching `pwsh -NoExit -Command ". '<haruspex.ps1>'"`. We do NOT pass
//! `-NoProfile`: the user's `$PROFILE` loads first, then our dot-source runs and
//! wraps their final `prompt`. Mirrors VS Code / Windows Terminal.

use std::path::Path;

/// Build the args that turn a bare PowerShell launch into one that dot-sources
/// `script_path` after the user's profile. Works for both `pwsh.exe` and
/// `powershell.exe`.
pub fn powershell_args(script_path: &Path) -> Vec<String> {
    // Single-quote the path for PowerShell and escape embedded single quotes by
    // doubling them (PowerShell's literal-string escaping).
    let quoted = script_path.to_string_lossy().replace('\'', "''");
    vec![
        "-NoLogo".to_string(),
        "-NoExit".to_string(),
        "-Command".to_string(),
        format!(". '{quoted}'"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn builds_dot_source_invocation() {
        let args = powershell_args(&PathBuf::from("C:\\res\\haruspex.ps1"));
        assert_eq!(args[0], "-NoLogo");
        assert_eq!(args[1], "-NoExit");
        assert_eq!(args[2], "-Command");
        assert_eq!(args[3], ". 'C:\\res\\haruspex.ps1'");
    }

    #[test]
    fn escapes_single_quotes_in_path() {
        let args = powershell_args(&PathBuf::from("C:\\o'brien\\haruspex.ps1"));
        assert_eq!(args[3], ". 'C:\\o''brien\\haruspex.ps1'");
    }
}
