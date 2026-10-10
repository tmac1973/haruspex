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

// --- Commands in a distro ---------------------------------------------------
//
// Killing `wsl.exe` only ends the Windows relay; the Linux processes it
// started keep running. So every command runs as the leader of a new session
// (`setsid -w`, which waits for it and passes on its exit code), reports its
// process group on stderr before anything else, and is stopped by signalling
// that group from inside the distro.

/// What the wrapper writes on stderr first: this, the group id, a newline.
const PGID_MARK: &[u8] = b"\x1eharuspex-pgid ";

/// Runs `$1` with bash in the folder `$2`. `cd` here rather than
/// `wsl.exe --cd`, which runs the command in `/` when the folder is gone.
const GROUP_WRAPPER: &str = r#"printf '\036haruspex-pgid %s\n' "$$" >&2
cd -- "$2" 2>/dev/null || { echo "Working directory does not exist: $2" >&2; exit 126; }
exec bash -c "$1""#;

/// `command`, run by bash in `cwd` inside `distro`, in a process group of its
/// own whose id comes first on stderr (see [`PgidReader`]).
pub fn group_command(distro: &str, cwd: &str, command: &str) -> tokio::process::Command {
    wsl_exec(
        distro,
        &[
            "setsid",
            "-w",
            "bash",
            "-c",
            GROUP_WRAPPER,
            "haruspex",
            command,
            cwd,
        ],
    )
}

/// Takes the wrapper's group id off the front of a command's stderr, passing
/// everything else through. Output that doesn't start with the mark (an
/// error from `wsl.exe` itself) passes through whole.
#[derive(Default)]
pub struct PgidReader {
    head: Vec<u8>,
    done: bool,
}

impl PgidReader {
    /// Feed the next chunk of stderr. Returns the group id when this chunk
    /// completes the wrapper's line, and the bytes that are the command's own.
    pub fn feed(&mut self, chunk: &[u8]) -> (Option<u32>, Vec<u8>) {
        if self.done {
            return (None, chunk.to_vec());
        }
        self.head.extend_from_slice(chunk);
        let n = self.head.len().min(PGID_MARK.len());
        if self.head[..n] != PGID_MARK[..n] {
            self.done = true;
            return (None, std::mem::take(&mut self.head));
        }
        let Some(nl) = self.head.iter().position(|&b| b == b'\n') else {
            return (None, Vec::new());
        };
        self.done = true;
        let pgid = std::str::from_utf8(&self.head[PGID_MARK.len()..nl])
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .filter(|&g| g > 1);
        let rest = self.head.split_off(nl + 1);
        self.head.clear();
        (pgid, rest)
    }

    /// What is held back at the end of the stream (a mark never finished).
    pub fn finish(&mut self) -> Vec<u8> {
        self.done = true;
        std::mem::take(&mut self.head)
    }
}

/// A command running in a distro, as the host stops it: its process group
/// once the wrapper reports it, and whether it has been stopped.
///
/// The `wsl.exe` relay is never killed. Terminating one while the distro
/// boots, with another `wsl.exe` starting beside it, has left the WSL service
/// failing every call (`Wsl/Service/E_UNEXPECTED`) until `wsl --shutdown`;
/// the relay ends on its own once its Linux side has gone. So a command
/// stopped before its group is known is marked, and whoever reads the group
/// signals it on arrival (see [`GroupState::reported`]).
#[derive(Debug, Default)]
pub struct GroupState {
    pgid: std::sync::atomic::AtomicU32,
    stopped: std::sync::atomic::AtomicBool,
}

impl GroupState {
    /// The group, or 0 before the wrapper has reported it.
    pub fn pgid(&self) -> u32 {
        self.pgid.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The wrapper reported `pgid`. True when the command was stopped first:
    /// the caller signals the group now.
    pub fn reported(&self, pgid: u32) -> bool {
        self.pgid.store(pgid, std::sync::atomic::Ordering::SeqCst);
        self.stopped.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Stop the command: the group to signal now, or None when it hasn't
    /// been reported yet (then [`Self::reported`] says so on arrival).
    pub fn stop(&self) -> Option<u32> {
        self.stopped
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Some(self.pgid()).filter(|&g| g > 1)
    }
}

/// Signals every group in `$@` (after the tick count `$1`): TERM, then up to
/// `$1` tenths of a second for them to go, then KILL for what is left.
/// A tick count of 0 is KILL straight away. Run by bash: dash's `kill` can't
/// signal a group (`kill -- -<pgid>` is "Illegal number").
const STOP_SCRIPT: &str = r#"n=$1; shift
if [ "$n" -gt 0 ]; then
  for g; do kill -TERM -- "-$g" 2>/dev/null; done
  i=0
  while [ "$i" -lt "$n" ]; do
    alive=
    for g; do kill -0 -- "-$g" 2>/dev/null && alive=1; done
    [ -z "$alive" ] && exit 0
    sleep 0.1; i=$((i + 1))
  done
fi
for g; do kill -KILL -- "-$g" 2>/dev/null; done
exit 0"#;

/// Stop process groups inside `distro`: TERM with `grace` to exit, then
/// KILL; `Duration::ZERO` kills at once. One `wsl.exe` for all of them.
pub async fn stop_groups(distro: &str, pgids: &[u32], grace: std::time::Duration) {
    let pgids: Vec<String> = pgids
        .iter()
        .filter(|&&g| g > 1)
        .map(u32::to_string)
        .collect();
    if pgids.is_empty() || !valid_distro(distro) {
        return;
    }
    let ticks = (grace.as_millis() / 100).to_string();
    let mut argv = vec!["bash", "-c", STOP_SCRIPT, "bash", ticks.as_str()];
    argv.extend(pgids.iter().map(String::as_str));
    if let Err(e) = wsl_exec(distro, &argv).output().await {
        log::warn!("Couldn't stop processes in WSL {distro}: {e}");
    }
}

/// Whether any process is left in the group `pgid` inside `distro`.
#[cfg(all(test, windows))]
pub async fn group_alive(distro: &str, pgid: u32) -> bool {
    pgid > 1
        && wsl_exec(
            distro,
            &[
                "bash",
                "-c",
                r#"kill -0 -- "-$1""#,
                "bash",
                &pgid.to_string(),
            ],
        )
        .status()
        .await
        .is_ok_and(|s| s.success())
}

/// Kills, in `distro`, each group in `$@` (pairs of group id and marker)
/// whose processes' command lines still carry the marker: a group left by a
/// crash, not an unrelated one that took the id since. Run by bash, as
/// [`STOP_SCRIPT`] is.
const SWEEP_SCRIPT: &str = r#"while [ "$#" -ge 2 ]; do
  g=$1; m=$2; shift 2
  ps -eo pgid=,args= | awk -v g="$g" '$1 == g' | grep -qF -- "$m" && kill -KILL -- "-$g" 2>/dev/null
done
exit 0"#;

/// The launch-time sweep for one distro: `groups` are (group id, marker).
/// Blocking: call off the async runtime.
pub fn sweep_groups(distro: &str, groups: &[(u32, String)]) {
    if groups.is_empty() || !valid_distro(distro) {
        return;
    }
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-d", distro, "--exec", "bash", "-c", SWEEP_SCRIPT, "bash"]);
    for (g, m) in groups {
        cmd.arg(g.to_string()).arg(m);
    }
    cmd.env("WSL_UTF8", "1").stdin(std::process::Stdio::null());
    crate::shell::platform::apply_no_window(&mut cmd);
    if let Err(e) = cmd.output() {
        log::warn!("Couldn't sweep processes in WSL {distro}: {e}");
    }
}

// --- Files in a distro ------------------------------------------------------
//
// The file tools reach a WSL session's files through the distro's share,
// `\\wsl.localhost\<distro>\…`: the session hands its root to them in that
// form (see `fs_tools::path::resolve_in_workdir`), and paths are checked
// here as the Linux paths they are. Windows does not follow a Linux symlink
// on the share (it can't be read, listed or canonicalized through), so a
// path is passed to the distro's `realpath` only when a symlink is in the way.

/// The share path of `linux` in `distro`: `\\wsl.localhost\Ubuntu\home\tim`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn share_path(distro: &str, linux: &str) -> std::path::PathBuf {
    let tail = linux.trim_start_matches('/').replace('/', "\\");
    std::path::PathBuf::from(format!(r"\\wsl.localhost\{distro}\{tail}"))
}

/// `path` is `dir` or inside it, comparing Linux paths by component.
pub fn linux_within(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches('/');
    dir.is_empty() || path == dir || path.strip_prefix(dir).is_some_and(|r| r.starts_with('/'))
}

/// `path` without `.` components or doubled slashes. `..` is refused before this.
#[cfg_attr(not(windows), allow(dead_code))]
fn tidy_linux(path: &str) -> String {
    let parts: Vec<&str> = path
        .split('/')
        .filter(|c| !c.is_empty() && *c != ".")
        .collect();
    format!("/{}", parts.join("/"))
}

#[cfg_attr(not(windows), allow(dead_code))]
const ESCAPES: &str = "path escapes working directory";

/// Resolve a file tool's path inside a WSL session's `root` (a canonical
/// Linux path in `distro`) to the share path to read or write. `rel` may be
/// relative to the root, an absolute Linux path inside it, or a share path
/// of the same distro; `..`, a Windows path and anything outside the root
/// are refused. A path through a symlink is resolved inside the distro and
/// must still land inside the root.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn resolve_in_share(distro: &str, root: &str, rel: &str) -> Result<std::path::PathBuf, String> {
    if rel.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(ESCAPES.to_string());
    }
    let linux = if rel.is_empty() || rel == "." {
        root.to_string()
    } else if let Some((d, p)) = parse_wsl_unc(rel) {
        if !d.eq_ignore_ascii_case(distro) {
            return Err(ESCAPES.to_string());
        }
        p
    } else if (rel.len() >= 2 && rel.as_bytes()[1] == b':') || rel.starts_with(r"\\") {
        // C:\…, or another share: not in this distro.
        return Err(ESCAPES.to_string());
    } else {
        let rel = rel.replace('\\', "/");
        if rel.starts_with('/') {
            rel
        } else {
            format!("{root}/{rel}")
        }
    };
    let linux = tidy_linux(&linux);
    if !linux_within(&linux, root) {
        return Err(ESCAPES.to_string());
    }
    let share = share_path(distro, &linux);
    match std::fs::symlink_metadata(&share) {
        Ok(m) if !m.file_type().is_symlink() => return Ok(share),
        // "File not found" (not "path not found"): its folder is a real one,
        // so no symlink is in the way; a new file to write.
        Err(e) if e.raw_os_error() == Some(2) => return Ok(share),
        _ => {}
    }
    // A symlink, or a folder on the way that is one (or is missing).
    let real = realpath_lenient(distro, &linux)?;
    if !linux_within(&real, root) {
        return Err(ESCAPES.to_string());
    }
    Ok(share_path(distro, &real))
}

/// `realpath -m` inside `distro`: symlinks resolved, missing components
/// allowed. Blocking.
#[cfg_attr(not(windows), allow(dead_code))]
fn realpath_lenient(distro: &str, linux: &str) -> Result<String, String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-d", distro, "--exec", "realpath", "-m", "--", linux])
        .env("WSL_UTF8", "1")
        .stdin(std::process::Stdio::null());
    crate::shell::platform::apply_no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("Couldn't run wsl.exe: {e}"))?;
    let real = String::from_utf8_lossy(&out.stdout)
        .trim_end_matches('\n')
        .to_string();
    if !out.status.success() || !real.starts_with('/') {
        return Err(format!(
            "Couldn't resolve {linux} in {distro}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(real)
}

/// `path` with a final symlink followed, when it is on a WSL distro's share:
/// Windows can't read through a Linux symlink there, so a repo whose
/// `CLAUDE.md` links to its `AGENTS.md`, or whose `.claude/skills` links to
/// `.agents/skills`, would look empty. Asks the distro's `realpath` only
/// for a symlink; anything else, or a path it can't resolve, comes back as
/// it is. Blocking.
pub fn follow_share_link(path: &std::path::Path) -> std::path::PathBuf {
    let is_link = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    if !is_link {
        return path.to_path_buf();
    }
    let Some((distro, linux)) = parse_wsl_unc(&path.to_string_lossy()) else {
        return path.to_path_buf();
    };
    match realpath_lenient(&distro, &linux) {
        Ok(real) => share_path(&distro, &real),
        Err(e) => {
            log::warn!("Couldn't follow {linux} in {distro}: {e}");
            path.to_path_buf()
        }
    }
}

/// A resolved share path as the model should see it: relative to the root,
/// with `/`. None when `resolved` isn't on the share of `workdir`.
pub fn share_display(workdir: &std::path::Path, resolved: &std::path::Path) -> Option<String> {
    let (d1, root) = parse_wsl_unc(&workdir.to_string_lossy())?;
    let (d2, path) = parse_wsl_unc(&resolved.to_string_lossy())?;
    if !d1.eq_ignore_ascii_case(&d2) || !linux_within(&path, &root) {
        return None;
    }
    let rel = path[root.trim_end_matches('/').len()..].trim_start_matches('/');
    Some(if rel.is_empty() {
        ".".to_string()
    } else {
        rel.to_string()
    })
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

    fn read_all(chunks: &[&[u8]]) -> (Option<u32>, Vec<u8>) {
        let mut r = PgidReader::default();
        let mut pgid = None;
        let mut out = Vec::new();
        for c in chunks {
            let (g, rest) = r.feed(c);
            pgid = pgid.or(g);
            out.extend(rest);
        }
        out.extend(r.finish());
        (pgid, out)
    }

    #[test]
    fn the_group_id_comes_off_the_front_of_stderr() {
        let all: &[u8] = b"\x1eharuspex-pgid 432\nerr\n";
        assert_eq!(read_all(&[all]), (Some(432), b"err\n".to_vec()));
        // Split anywhere, even inside the mark.
        for i in 1..all.len() {
            assert_eq!(
                read_all(&[&all[..i], &all[i..]]),
                (Some(432), b"err\n".to_vec()),
                "split at {i}"
            );
        }
        // wsl.exe's own error: passed through whole.
        assert_eq!(
            read_all(&[b"There is no distribution", b" with that name.\n"]),
            (None, b"There is no distribution with that name.\n".to_vec())
        );
        // A mark cut off by the end of the stream is given back.
        assert_eq!(
            read_all(&[b"\x1eharuspex-pg"]),
            (None, b"\x1eharuspex-pg".to_vec())
        );
        // Group 0 or 1 would signal everything: never reported.
        assert_eq!(read_all(&[b"\x1eharuspex-pgid 1\n"]).0, None);
        assert_eq!(read_all(&[b"", b"x"]), (None, b"x".to_vec()));
    }

    #[test]
    fn a_path_leaving_the_root_is_refused_before_any_file_is_touched() {
        let r = |rel: &str| resolve_in_share("Ubuntu", "/home/tim/proj", rel);
        for rel in [
            "../x",
            "src/../../x",
            r"src\..\..\x",
            "/home/tim/other/x",
            "/home/tim/projects/x",
            "/etc/passwd",
            r"C:\Users\tim\x",
            "c:/x",
            r"\\server\share\x",
            r"\\wsl.localhost\Debian\home\tim\proj\x",
            r"\\wsl$\Ubuntu\etc\passwd",
        ] {
            assert_eq!(r(rel), Err(ESCAPES.to_string()), "{rel}");
        }
    }

    #[test]
    fn share_paths_and_display_paths_map_both_ways() {
        assert_eq!(
            share_path("Ubuntu", "/home/tim/a b"),
            std::path::PathBuf::from(r"\\wsl.localhost\Ubuntu\home\tim\a b")
        );
        assert_eq!(tidy_linux("/home//tim/./proj/"), "/home/tim/proj");
        let root = std::path::Path::new(r"\\wsl.localhost\Ubuntu\home\tim\proj");
        let d = |p: &str| share_display(root, std::path::Path::new(p));
        assert_eq!(
            d(r"\\wsl.localhost\Ubuntu\home\tim\proj\src\a.ts").as_deref(),
            Some("src/a.ts")
        );
        assert_eq!(
            d(r"\\wsl.localhost\Ubuntu\home\tim\proj").as_deref(),
            Some(".")
        );
        assert_eq!(d(r"\\wsl.localhost\Ubuntu\home\tim\projx"), None);
        assert_eq!(d(r"\\wsl.localhost\Debian\home\tim\proj\a"), None);
        assert!(linux_within("/a/b", "/a"));
        assert!(linux_within("/a", "/a/"));
        assert!(!linux_within("/ab", "/a"));
        assert!(linux_within("/anything", "/"));
    }

    /// Needs a WSL2 distro: run on the Windows box with `--ignored`.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn files_resolve_through_the_share_and_symlinks_stay_inside() {
        let distro = distros().into_iter().next().expect("a WSL2 distro");
        let home = realpath_in(&distro, "~").await.unwrap();
        let base = format!("{home}/.haruspex-share-test-{}", std::process::id());
        let root = format!("{base}/proj");
        let setup = format!(
            "rm -rf '{base}' && mkdir -p '{root}/sub' && cd '{base}' && echo secret > outside.txt \
             && echo inner > proj/sub/a.txt && ln -s ../outside.txt proj/out \
             && ln -s /etc proj/etc && ln -s sub proj/in && ln -s sub/a.txt proj/a-link"
        );
        assert!(wsl_exec(&distro, &["bash", "-c", &setup])
            .status()
            .await
            .unwrap()
            .success());
        let r = |rel: &str| resolve_in_share(&distro, &root, rel);
        let read = |p: std::path::PathBuf| std::fs::read_to_string(p).map(|s| s.trim().to_string());

        // A plain file, relative or absolute.
        assert_eq!(read(r("sub/a.txt").unwrap()).unwrap(), "inner");
        assert_eq!(
            read(r(&format!("{root}/sub/a.txt")).unwrap()).unwrap(),
            "inner"
        );
        // A new file: its folder exists, so no distro call; one in a new folder too.
        assert_eq!(
            r("sub/new.txt").unwrap(),
            share_path(&distro, &format!("{root}/sub/new.txt"))
        );
        assert_eq!(
            r("new/deep/x.txt").unwrap(),
            share_path(&distro, &format!("{root}/new/deep/x.txt"))
        );
        // Symlinks inside the root are followed, through the distro.
        assert_eq!(read(r("in/a.txt").unwrap()).unwrap(), "inner");
        assert_eq!(read(r("a-link").unwrap()).unwrap(), "inner");
        assert!(r("in").unwrap().is_dir());
        // Symlinks out of it are refused.
        assert_eq!(r("out"), Err(ESCAPES.to_string()));
        assert_eq!(r("etc/hostname"), Err(ESCAPES.to_string()));
        assert_eq!(r("etc"), Err(ESCAPES.to_string()));

        // Search reports Linux-style paths relative to the root.
        let found = crate::code_tools::search::code_glob(
            root.clone(),
            "**/*.txt".into(),
            None,
            Some(distro.clone()),
        )
        .await
        .unwrap();
        assert_eq!(found.paths, vec!["sub/a.txt".to_string()]);
        let hits = crate::code_tools::search::code_grep(
            root.clone(),
            "inner".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(distro.clone()),
        )
        .await
        .unwrap();
        assert_eq!(hits.matches[0].path, "sub/a.txt");

        let _ = wsl_exec(&distro, &["rm", "-rf", &base]).status().await;
    }

    #[test]
    fn a_stop_before_the_group_is_known_is_carried_out_when_it_arrives() {
        // Stopped first: nothing to signal yet; the report says to.
        let early = GroupState::default();
        assert_eq!(early.stop(), None);
        assert!(early.reported(42));
        // Reported first: the stop signals it; the report didn't have to.
        let late = GroupState::default();
        assert!(!late.reported(42));
        assert_eq!(late.pgid(), 42);
        assert_eq!(late.stop(), Some(42));
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
