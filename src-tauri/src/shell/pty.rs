use std::io::Write;
use std::path::{Path, PathBuf};

use super::platform;

/// User-configured shell binary takes priority over $SHELL. Invalid
/// overrides (empty string, missing file) fall back to the default
/// detection so a bad setting doesn't break the Shell tab.
pub fn resolve_shell_with_override(override_path: Option<&str>) -> String {
    if let Some(path) = override_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_file() {
            return trimmed.to_string();
        }
    }
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() && Path::new(&s).is_file() {
            return s;
        }
    }
    // Platform default: /bin/bash on Linux, /bin/zsh on macOS.
    platform::default_shell()
}

pub fn resolve_cwd() -> String {
    if let Ok(home) = std::env::var("HOME") {
        if Path::new(&home).is_dir() {
            return home;
        }
    }
    "/".to_string()
}

/// Sniff the shell binary's basename to pick the right integration script.
pub fn shell_name(shell_path: &str) -> &str {
    Path::new(shell_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
}

/// Result of preparing the spawn environment for OSC 133 integration.
pub struct SpawnPlan {
    /// Arguments to pass to the shell (e.g. `--rcfile <path>` for bash).
    pub args: Vec<String>,
    /// Environment variables to override (e.g. ZDOTDIR for zsh).
    pub env: Vec<(String, String)>,
    /// Temp directories to keep alive until the session ends. They
    /// hold the wrapper rcfile / zdotdir contents.
    pub tempdirs: Vec<PathBuf>,
}

impl SpawnPlan {
    pub fn passthrough() -> Self {
        Self {
            args: Vec::new(),
            env: Vec::new(),
            tempdirs: Vec::new(),
        }
    }
}

/// Build a SpawnPlan that injects our OSC 133 hook for the given shell.
/// integration_dir must contain `haruspex.bash` / `haruspex.zsh`.
/// On failure (e.g. unknown shell, write error) returns a passthrough plan.
///
/// Platform login behavior is layered on top of the shell-specific plan:
/// `platform::login_args()` adds the login flag where the platform needs it
/// (macOS, so `path_helper`/login rc files populate PATH), and
/// `platform::login_env()` seeds PATH for shells we *don't* launch login
/// (macOS bash). Both are no-ops on Linux, so Linux plans are unchanged.
pub fn plan_integration(shell_path: &str, integration_dir: &Path) -> SpawnPlan {
    let name = shell_name(shell_path);
    let login = !platform::login_args(shell_path).is_empty();
    let mut plan = match name {
        "bash" => plan_bash(integration_dir).unwrap_or_else(SpawnPlan::passthrough),
        "zsh" => plan_zsh(integration_dir, login).unwrap_or_else(SpawnPlan::passthrough),
        _ => SpawnPlan::passthrough(),
    };
    plan.args.extend(platform::login_args(shell_path));
    plan.env.extend(platform::login_env(shell_path));
    plan
}

fn plan_bash(integration_dir: &Path) -> Option<SpawnPlan> {
    let hook = integration_dir.join("haruspex.bash");
    if !hook.is_file() {
        return None;
    }
    let dir = tempdir_in_session()?;
    let rcfile = dir.join("haruspex-bashrc");
    let home = std::env::var("HOME").unwrap_or_default();
    let user_bashrc = PathBuf::from(&home).join(".bashrc");
    let mut contents = String::new();
    // Source the user's bashrc first if it exists, then our hook.
    if user_bashrc.is_file() {
        contents.push_str(&format!(
            "[ -f {} ] && . {}\n",
            shell_quote(&user_bashrc.to_string_lossy()),
            shell_quote(&user_bashrc.to_string_lossy())
        ));
    }
    contents.push_str(&format!(". {}\n", shell_quote(&hook.to_string_lossy())));
    write_file(&rcfile, &contents).ok()?;
    Some(SpawnPlan {
        args: vec!["--rcfile".to_string(), rcfile.to_string_lossy().to_string()],
        env: Vec::new(),
        tempdirs: vec![dir],
    })
}

/// Prepare a zsh integration plan. We override ZDOTDIR to a temp dir whose
/// `.zshrc` sources the user's real `.zshrc` and then our OSC 133 hook
/// (interactive rc, where the hook belongs).
///
/// When `login` is true (macOS — the shell is launched `zsh -l`), zsh also
/// reads `.zprofile`/`.zlogin` from ZDOTDIR. We write thin shims there that
/// source the user's real login files so their PATH setup (nvm, pyenv, …)
/// runs. `/etc/zprofile` is read regardless of ZDOTDIR, so `path_helper`
/// (and thus `/opt/homebrew/bin`) is already on PATH by the time these run.
fn plan_zsh(integration_dir: &Path, login: bool) -> Option<SpawnPlan> {
    let hook = integration_dir.join("haruspex.zsh");
    if !hook.is_file() {
        return None;
    }
    let dir = tempdir_in_session()?;
    let zdotdir = dir.join("zdotdir");
    std::fs::create_dir_all(&zdotdir).ok()?;
    let user_zdotdir = std::env::var("ZDOTDIR")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
    let user_zshrc = PathBuf::from(&user_zdotdir).join(".zshrc");
    let mut contents = String::new();
    if user_zshrc.is_file() {
        contents.push_str(&format!(
            "[ -f {z} ] && . {z}\n",
            z = shell_quote(&user_zshrc.to_string_lossy())
        ));
    }
    contents.push_str(&format!(". {}\n", shell_quote(&hook.to_string_lossy())));
    write_file(&zdotdir.join(".zshrc"), &contents).ok()?;

    if login {
        // Source the user's real login files so login-only PATH setup runs.
        for name in [".zprofile", ".zlogin"] {
            let user_file = PathBuf::from(&user_zdotdir).join(name);
            if user_file.is_file() {
                let line = format!(
                    "[ -f {f} ] && . {f}\n",
                    f = shell_quote(&user_file.to_string_lossy())
                );
                // Best-effort: a missing shim just means that login file
                // isn't sourced; the interactive hook still loads.
                let _ = write_file(&zdotdir.join(name), &line);
            }
        }
    }

    Some(SpawnPlan {
        args: Vec::new(),
        env: vec![("ZDOTDIR".to_string(), zdotdir.to_string_lossy().to_string())],
        tempdirs: vec![dir],
    })
}

fn tempdir_in_session() -> Option<PathBuf> {
    let base = std::env::temp_dir();
    for _ in 0..16 {
        let name = format!("haruspex-shell-{}", rand_suffix());
        let candidate = base.join(name);
        if std::fs::create_dir(&candidate).is_ok() {
            return Some(candidate);
        }
    }
    None
}

fn rand_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}-{}", now, n, std::process::id())
}

fn write_file(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut f = std::fs::File::create(path)?;
    f.write_all(contents.as_bytes())
}

/// Single-quote a path for safe interpolation into a shell sourcing line.
fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_handles_apostrophes() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("/home/tim"), "'/home/tim'");
    }

    #[test]
    fn shell_name_returns_basename() {
        assert_eq!(shell_name("/usr/bin/bash"), "bash");
        assert_eq!(shell_name("/bin/zsh"), "zsh");
        assert_eq!(shell_name("fish"), "fish");
    }
}
