//! Where a Code session lives when its project is inside a WSL2 distro.
//!
//! On Windows a session is either a distro plus a Linux path
//! (`Ubuntu` + `/home/tim/proj`) or nothing at all: native Windows folders
//! are not supported yet (#396). The Linux path is canonicalized *inside*
//! the distro with `realpath`, never with `std::fs::canonicalize` on the
//! `\\wsl.localhost\…` share, so the `\\wsl$\`, `\\wsl.localhost\` and
//! `\\?\UNC\…` spellings of one folder all store the same row, and prompts,
//! links and git see the path the user's own shell shows.
//!
//! Off Windows `wsl_distro` is always `None` and sessions are host folders,
//! as before. See plan/code-tab/phase-10-windows-wsl.md.

use serde::Serialize;

/// Where a session works: a host folder (`distro: None`) or a Linux path
/// inside a WSL distro.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CodeLocation {
    pub wsl_distro: Option<String>,
    pub root: String,
}

/// Why a native Windows folder is refused. Shown as-is in the picker.
pub const NATIVE_WINDOWS_REFUSED: &str =
    "Native Windows folders are coming later (#396). Pick a folder inside a WSL distro.";

/// A distro name safe to pass to `wsl.exe -d` and to put in a share path.
/// WSL itself allows letters, digits, `.`, `-` and `_`.
pub fn valid_distro(d: &str) -> bool {
    !d.is_empty()
        && !d.starts_with(['.', '-'])
        && d.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Split a path on a distro's share — `\\wsl.localhost\Ubuntu\home\tim`,
/// `\\wsl$\Ubuntu\…` or the verbatim `\\?\UNC\wsl.localhost\…`, with either
/// slash — into the distro and the Linux path. `None` for anything else.
/// The Linux path is not canonical; `..` is left for `realpath`.
pub fn parse_wsl_unc(path: &str) -> Option<(String, String)> {
    let s = path.replace('/', "\\");
    let rest = s
        .strip_prefix(r"\\?\UNC\")
        .or_else(|| s.strip_prefix(r"\\"))?;
    let (host, rest) = rest.split_once('\\')?;
    if !host.eq_ignore_ascii_case("wsl.localhost") && !host.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let (distro, tail) = rest.split_once('\\').unwrap_or((rest, ""));
    if !valid_distro(distro) {
        return None;
    }
    let tail: Vec<&str> = tail.split('\\').filter(|c| !c.is_empty()).collect();
    Some((distro.to_string(), format!("/{}", tail.join("/"))))
}

/// The shell script that canonicalizes a folder inside the distro: `$1` is
/// an absolute path or one under `~`; prints the real path of an existing
/// directory, or fails with a message on stderr.
const REALPATH_SCRIPT: &str = r#"case $1 in
"~") p=$HOME ;;
"~/"*) p=$HOME/${1#"~/"} ;;
/*) p=$1 ;;
*) echo "Use a full path, like /home/you/project: $1" >&2; exit 2 ;;
esac
p=$(realpath -e -- "$p" 2>/dev/null) || { echo "Folder not found: $1" >&2; exit 1; }
[ -d "$p" ] || { echo "Not a folder: $1" >&2; exit 3; }
printf '%s' "$p""#;

/// A `wsl.exe` command for `distro` that runs `argv` directly (no shell
/// parsing of the arguments), with no console window and UTF-8 errors.
pub fn wsl_exec(distro: &str, argv: &[&str]) -> tokio::process::Command {
    let mut c = tokio::process::Command::new("wsl.exe");
    c.args(["-d", distro, "--exec"]).args(argv);
    c.env("WSL_UTF8", "1");
    c.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    c.creation_flags(crate::shell::platform::CREATE_NO_WINDOW);
    c
}

/// The installed WSL2 distros; empty off Windows or without WSL.
pub fn distros() -> Vec<String> {
    crate::shell::wsl_distros()
}

/// `name` as the distro list spells it (WSL matches names case-blind).
fn listed_distro(name: &str) -> Result<String, String> {
    if !valid_distro(name) {
        return Err(format!("Not a WSL distro name: {name}"));
    }
    distros()
        .into_iter()
        .find(|d| d.eq_ignore_ascii_case(name))
        .ok_or_else(|| format!("No WSL2 distro named {name}"))
}

/// The real path of the folder `path` inside `distro`. Accepts `~`.
pub async fn realpath_in(distro: &str, path: &str) -> Result<String, String> {
    let out = wsl_exec(distro, &["sh", "-c", REALPATH_SCRIPT, "sh", path])
        .output()
        .await
        .map_err(|e| format!("Couldn't run wsl.exe: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("Couldn't reach the {distro} distro")
        } else {
            err
        });
    }
    let p = String::from_utf8_lossy(&out.stdout).into_owned();
    if !p.starts_with('/') {
        return Err(format!("Unexpected answer from the {distro} distro: {p}"));
    }
    Ok(p)
}

/// Whether `path` is a folder inside `distro`. False when the distro can't
/// be reached either: the session shows its folder as missing.
pub async fn is_dir_in(distro: &str, path: &str) -> bool {
    if !valid_distro(distro) || !path.starts_with('/') {
        return false;
    }
    wsl_exec(distro, &["test", "-d", path])
        .status()
        .await
        .is_ok_and(|s| s.success())
}

/// The canonical location of the folder the user picked: `distro` from the
/// picker's dropdown (or `None`), `path` typed or browsed. On Windows a
/// share path (`\\wsl.localhost\Ubuntu\…`) names its own distro, and a
/// native folder is refused. Off Windows a distro is refused and the host
/// path is left for the caller to canonicalize.
pub async fn resolve_location(distro: Option<&str>, path: &str) -> Result<CodeLocation, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("Pick a folder".to_string());
    }
    if !cfg!(windows) {
        if distro.is_some() {
            return Err("WSL folders are only for Windows".to_string());
        }
        return Ok(CodeLocation {
            wsl_distro: None,
            root: path.to_string(),
        });
    }
    let (distro, linux) = match parse_wsl_unc(path) {
        Some((d, p)) => (d, p),
        None if path.starts_with('/') || path.starts_with('~') => match distro {
            Some(d) => (d.to_string(), path.to_string()),
            None => return Err("Pick the WSL distro this folder is in".to_string()),
        },
        None => return Err(NATIVE_WINDOWS_REFUSED.to_string()),
    };
    let distro = listed_distro(&distro)?;
    let root = realpath_in(&distro, &linux).await?;
    Ok(CodeLocation {
        wsl_distro: Some(distro),
        root,
    })
}

/// Whether a session's folder is still there.
pub async fn folder_exists(distro: Option<&str>, path: &str) -> bool {
    match distro {
        Some(d) => is_dir_in(d, path).await,
        None => {
            let path = path.to_string();
            tokio::task::spawn_blocking(move || std::path::Path::new(&path).is_dir())
                .await
                .unwrap_or(false)
        }
    }
}

/// The installed WSL2 distros, for the folder picker and the tab gate.
#[tauri::command]
pub async fn code_wsl_distros() -> Vec<String> {
    tokio::task::spawn_blocking(distros)
        .await
        .unwrap_or_default()
}

/// Resolve a picked folder without creating anything (see
/// [`resolve_location`]); the picker shows the canonical form or the error.
#[tauri::command]
pub async fn code_resolve_folder(
    wsl_distro: Option<String>,
    path: String,
) -> Result<CodeLocation, String> {
    resolve_location(wsl_distro.as_deref(), &path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unc(p: &str) -> Option<(String, String)> {
        parse_wsl_unc(p)
    }

    fn some(d: &str, p: &str) -> Option<(String, String)> {
        Some((d.to_string(), p.to_string()))
    }

    #[test]
    fn every_share_spelling_splits_into_distro_and_linux_path() {
        let want = some("Ubuntu", "/home/tim/proj");
        assert_eq!(unc(r"\\wsl.localhost\Ubuntu\home\tim\proj"), want);
        assert_eq!(unc(r"\\wsl$\Ubuntu\home\tim\proj"), want);
        assert_eq!(unc(r"\\?\UNC\wsl.localhost\Ubuntu\home\tim\proj"), want);
        assert_eq!(unc(r"\\WSL.LOCALHOST\Ubuntu\home\tim\proj\"), want);
        assert_eq!(unc("//wsl.localhost/Ubuntu/home/tim/proj"), want);
        assert_eq!(unc(r"\\wsl$\Ubuntu-24.04"), some("Ubuntu-24.04", "/"));
        assert_eq!(unc(r"\\wsl$\Ubuntu\"), some("Ubuntu", "/"));
    }

    #[test]
    fn other_paths_are_not_shares() {
        assert_eq!(unc(r"C:\Users\tim"), None);
        assert_eq!(unc(r"\\?\C:\Users\tim"), None);
        assert_eq!(unc(r"\\server\share\x"), None);
        assert_eq!(unc(r"\\?\UNC\server\share"), None);
        assert_eq!(unc("/home/tim"), None);
        assert_eq!(unc(r"\\wsl$"), None);
        assert_eq!(unc(r"\\wsl$\..\x"), None);
        assert_eq!(unc(r"\\wsl$\-d\x"), None);
    }

    #[test]
    fn distro_names_are_checked() {
        assert!(valid_distro("Ubuntu-24.04"));
        assert!(valid_distro("my_distro"));
        assert!(!valid_distro(""));
        assert!(!valid_distro("-d"));
        assert!(!valid_distro(".."));
        assert!(!valid_distro("a b"));
        assert!(!valid_distro("a\\b"));
        assert!(!valid_distro("a;b"));
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn off_windows_a_distro_is_refused_and_a_host_path_passes_through() {
        assert!(resolve_location(Some("Ubuntu"), "/tmp").await.is_err());
        assert_eq!(
            resolve_location(None, " /tmp ").await.unwrap(),
            CodeLocation {
                wsl_distro: None,
                root: "/tmp".to_string()
            }
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_native_windows_folder_is_refused() {
        let err = resolve_location(None, r"C:\temp").await.unwrap_err();
        assert!(err.contains("#396"), "{err}");
        let err = resolve_location(Some("Ubuntu"), r"C:\temp")
            .await
            .unwrap_err();
        assert!(err.contains("#396"), "{err}");
        assert!(resolve_location(None, "/home/x").await.is_err());
    }

    /// Needs a WSL2 distro: run on the Windows box with `--ignored`.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn wsl_spellings_of_one_folder_resolve_alike() {
        let distro = distros().into_iter().next().expect("a WSL2 distro");
        let home = resolve_location(Some(&distro), "~").await.unwrap();
        assert_eq!(home.wsl_distro.as_deref(), Some(distro.as_str()));
        assert!(home.root.starts_with('/'), "{home:?}");
        let share = format!(
            r"\\wsl$\{}{}\.",
            distro.to_lowercase(),
            home.root.replace('/', "\\")
        );
        assert_eq!(resolve_location(None, &share).await.unwrap(), home);
        assert!(folder_exists(Some(&distro), &home.root).await);
        assert!(!folder_exists(Some(&distro), "/no/such/folder").await);
        let err = resolve_location(Some(&distro), "/no/such/folder")
            .await
            .unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }
}
