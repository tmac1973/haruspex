//! Git, for the Code tab: the branch in a session's header, switching and
//! creating branches, and the worktree a fork can take.
//!
//! Runs the user's own `git` as a child process rather than linking a git
//! library: it is the git they already use, with their config, hooks and
//! credential helpers, and its error text is what they would see in a
//! terminal — which is what the header shows when git refuses (a checkout
//! over uncommitted changes, a branch already checked out elsewhere).
//!
//! Every call runs with `-C <folder>`, a timeout, and `GIT_TERMINAL_PROMPT=0`
//! (nothing here may sit waiting for a password on a stdin nobody can see).
//! Read-only calls set `GIT_OPTIONAL_LOCKS=0`, so polling the status after
//! each turn never fights the user's own git for `index.lock`.
//!
//! A WSL session's git (Windows) runs inside its distro, on Linux paths
//! ([`Place::Wsl`]): the user's Linux git, config and credentials, and
//! worktrees whose `.git` files name Linux paths. Host git over the
//! `\\wsl.localhost` share would be slow, trip "dubious ownership", and
//! write Windows paths into `.git/worktrees/*/gitdir`, breaking the user's
//! own git inside the distro.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

/// Long enough for `status` in a big repo on a slow disk; a call that takes
/// longer than this is stuck, not slow.
const GIT_TIMEOUT: Duration = Duration::from_secs(20);
/// `worktree add` checks out a whole tree.
const WORKTREE_TIMEOUT: Duration = Duration::from_secs(120);

/// One folder's git state, for the header.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct GitStatus {
    /// The worktree's top folder (`--show-toplevel`).
    pub repo_root: String,
    /// The branch checked out; `None` on a detached HEAD.
    pub branch: Option<String>,
    /// HEAD's short hash; `None` before the first commit.
    pub head: Option<String>,
    /// Tracked files with changes, staged or not. Switching branch waits
    /// until this is zero.
    #[ts(type = "number")]
    pub changed: u32,
    /// Untracked files (not ignored ones).
    #[ts(type = "number")]
    pub untracked: u32,
    /// The folder is a linked worktree, not the repository's main one.
    pub linked_worktree: bool,
    /// The repository's main line: the local branch `origin/HEAD` names,
    /// else `main`, else `master`; `None` when none of them exists here.
    pub default_branch: Option<String>,
}

/// What a worktree removal did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorktreeRemoval {
    Removed,
    /// Left in place; `reason` says why, in a sentence.
    Kept {
        reason: String,
    },
}

/// Where git runs, and how its paths are spelled.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Place {
    /// The host's git; paths are the host's.
    #[default]
    Host,
    /// The git inside a WSL distro; paths are Linux paths.
    Wsl(String),
}

impl Place {
    pub fn new(wsl_distro: Option<String>) -> Self {
        wsl_distro.map_or(Place::Host, Place::Wsl)
    }

    /// Is git installed where it runs? Checked once per place; installing it
    /// means restarting the app.
    async fn available(&self) -> bool {
        let Place::Wsl(distro) = self else {
            return git_available();
        };
        static IN_DISTRO: OnceLock<std::sync::Mutex<std::collections::HashMap<String, bool>>> =
            OnceLock::new();
        let cache = IN_DISTRO.get_or_init(Default::default);
        if let Some(&known) = cache.lock().unwrap().get(distro) {
            return known;
        }
        let ok = super::wsl::wsl_exec(distro, &["git", "--version"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|s| s.success());
        cache.lock().unwrap().insert(distro.clone(), ok);
        ok
    }

    /// `git -C dir args…` here, with the environment every call gets.
    fn command(&self, dir: &str, args: &[&str], write: bool) -> tokio::process::Command {
        let mut env = vec!["GIT_TERMINAL_PROMPT=0", "LC_ALL=C"];
        if !write {
            env.push("GIT_OPTIONAL_LOCKS=0");
        }
        let mut cmd = match self {
            Place::Host => {
                let mut c = tokio::process::Command::new("git");
                for kv in &env {
                    let (k, v) = kv.split_once('=').expect("KEY=value");
                    c.env(k, v);
                }
                c.arg("-C").arg(dir).args(args);
                super::hide_window(&mut c);
                c
            }
            // `env` sets them inside the distro; the host's don't cross.
            Place::Wsl(distro) => {
                let mut argv: Vec<&str> = vec!["env"];
                argv.extend(&env);
                argv.extend(["git", "-C", dir]);
                argv.extend(args);
                super::wsl::wsl_exec(distro, &argv)
            }
        };
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd
    }

    /// The host path to stat `path` through: itself, or its distro share.
    fn host_path(&self, path: &str) -> PathBuf {
        match self {
            Place::Host => PathBuf::from(path),
            Place::Wsl(distro) => super::wsl::share_path(distro, path),
        }
    }

    fn exists(&self, path: &str) -> bool {
        self.host_path(path).exists()
    }

    fn is_dir(&self, path: &str) -> bool {
        self.host_path(path).is_dir()
    }

    fn create_dir_all(&self, path: &str) -> std::io::Result<()> {
        std::fs::create_dir_all(self.host_path(path))
    }

    /// `path` with symlinks resolved, for comparing. Git's own answers inside
    /// a distro are absolute and resolved already, so those are kept as is.
    fn canonical(&self, path: &str) -> String {
        match self {
            Place::Host => canonical(Path::new(path)).to_string_lossy().into_owned(),
            Place::Wsl(_) => path.trim_end_matches('/').to_string(),
        }
    }

    /// A path git printed, as the platform spells it: git for Windows says
    /// `C:/Users/tim/proj`, which the branch control shows and which should
    /// match the session's `C:\Users\tim\proj`.
    fn native(&self, path: String) -> String {
        match self {
            Place::Host if cfg!(windows) => path.replace('/', "\\"),
            _ => path,
        }
    }

    fn join(&self, dir: &str, name: &str) -> String {
        match self {
            Place::Host => Path::new(dir).join(name).to_string_lossy().into_owned(),
            Place::Wsl(_) if name.is_empty() => dir.to_string(),
            Place::Wsl(_) => format!("{}/{name}", dir.trim_end_matches('/')),
        }
    }

    fn parent(&self, path: &str) -> Option<String> {
        match self {
            Place::Host => Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().into_owned()),
            Place::Wsl(_) => {
                let path = path.trim_end_matches('/');
                let (parent, _) = path.rsplit_once('/')?;
                Some(if parent.is_empty() { "/" } else { parent }.to_string())
            }
        }
    }

    fn file_name(&self, path: &str) -> Option<String> {
        match self {
            Place::Host => Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned()),
            Place::Wsl(_) => path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .filter(|n| !n.is_empty())
                .map(str::to_string),
        }
    }

    /// `path` relative to `base`, `""` for `base` itself; None outside it.
    fn relative(&self, path: &str, base: &str) -> Option<String> {
        match self {
            Place::Host => Path::new(path)
                .strip_prefix(base)
                .ok()
                .map(|p| p.to_string_lossy().into_owned()),
            Place::Wsl(_) => {
                let base = base.trim_end_matches('/');
                let rest = path.trim_end_matches('/').strip_prefix(base)?;
                if rest.is_empty() {
                    Some(String::new())
                } else {
                    rest.strip_prefix('/').map(str::to_string)
                }
            }
        }
    }

    /// Two folders git named are the same one.
    fn same(&self, a: &str, b: &str) -> bool {
        self.canonical(a) == self.canonical(b)
    }
}

/// A worktree made for a fork, in its place's spelling.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorktreeMade {
    pub place: Place,
    /// The worktree's top folder.
    pub path: String,
    /// Where the fork's session is rooted (see [`ForkWorktree::root`]).
    pub root: String,
    pub branch: String,
}

/// A worktree made for a fork, in host paths (the tests' view of [`WorktreeMade`]).
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForkWorktree {
    /// The worktree's top folder.
    pub path: PathBuf,
    /// Where the fork's session is rooted: the source's folder, at the same
    /// place inside the new worktree.
    pub root: PathBuf,
    pub branch: String,
}

/// Is `git` on `PATH`? Checked once; installing git means restarting the app.
pub fn git_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::shell::platform::apply_no_window(&mut cmd);
        cmd.status().is_ok_and(|s| s.success())
    })
}

/// Git's answer, or its error text.
struct Output {
    ok: bool,
    stdout: String,
    stderr: String,
}

/// Run `git -C dir args…` in `place`. Errs only when git couldn't be run or
/// timed out; a git failure comes back as `ok: false` with its stderr. (The
/// messages are shown as they are and matched in tests: `LC_ALL=C`.)
async fn run(
    place: &Place,
    dir: &str,
    args: &[&str],
    timeout: Duration,
    write: bool,
) -> Result<Output, String> {
    let mut cmd = place.command(dir, args, write);
    cmd.stdin(Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("Couldn't run git: {e}"))?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("git {} took too long and was stopped.", args[0]))?
        .map_err(|e| format!("git {}: {e}", args[0]))?;
    Ok(Output {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

/// Run git and return its stdout, or its error text as the error.
async fn run_ok(
    place: &Place,
    dir: &str,
    args: &[&str],
    timeout: Duration,
    write: bool,
) -> Result<String, String> {
    let out = run(place, dir, args, timeout, write).await?;
    if out.ok {
        Ok(out.stdout)
    } else if out.stderr.is_empty() {
        Err(format!("git {} failed.", args[0]))
    } else {
        Err(out.stderr)
    }
}

/// The worktree top and the shared `.git` folder for `dir`, or `None` when
/// `dir` is not in a git repository.
async fn locate(place: &Place, dir: &str) -> Result<Option<(String, String, String)>, String> {
    let out = run(
        place,
        dir,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-common-dir",
            "--git-dir",
        ],
        GIT_TIMEOUT,
        false,
    )
    .await?;
    if !out.ok {
        // "not a git repository", or a bare repo / .git folder (no toplevel):
        // neither has a branch to show.
        return Ok(None);
    }
    let mut lines = out.stdout.lines();
    match (lines.next(), lines.next(), lines.next()) {
        (Some(top), Some(common), Some(git_dir)) if !top.is_empty() => Ok(Some((
            top.to_string(),
            common.to_string(),
            git_dir.to_string(),
        ))),
        _ => Ok(None),
    }
}

/// `dir`'s git state, or `None` when git is missing or `dir` is not in a repo.
#[cfg(test)]
pub async fn status(dir: &Path) -> Result<Option<GitStatus>, String> {
    status_in(&Place::Host, &dir.to_string_lossy()).await
}

/// [`status`] in `place`. A WSL session's `repo_root` is a Linux path.
pub async fn status_in(place: &Place, dir: &str) -> Result<Option<GitStatus>, String> {
    if !place.available().await {
        return Ok(None);
    }
    let Some((top, common, git_dir)) = locate(place, dir).await? else {
        return Ok(None);
    };
    let out = run_ok(
        place,
        &top,
        &["status", "--porcelain=v2", "--branch", "-z"],
        GIT_TIMEOUT,
        false,
    )
    .await?;
    let mut st = parse_status(&out);
    st.linked_worktree = !place.same(&common, &git_dir);
    st.default_branch = default_branch(place, &top).await;
    st.repo_root = place.native(top);
    Ok(Some(st))
}

/// See [`GitStatus::default_branch`]. Only a branch that exists locally
/// counts, since a new branch is started from it.
async fn default_branch(place: &Place, dir: &str) -> Option<String> {
    let remote_head = run(
        place,
        dir,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        GIT_TIMEOUT,
        false,
    )
    .await
    .ok()
    .filter(|r| r.ok)
    .and_then(|r| r.stdout.trim().strip_prefix("origin/").map(str::to_string));
    for name in remote_head
        .into_iter()
        .chain(["main".into(), "master".into()])
    {
        if branch_exists(place, dir, &name).await.unwrap_or(false) {
            return Some(name);
        }
    }
    None
}

/// Without Windows' `\\?\` prefix: it can become a fork's root and its
/// worktree path, which people read.
fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p)
        .map(|c| crate::fs_tools::path::strip_verbatim(&c))
        .unwrap_or_else(|_| p.to_path_buf())
}

/// Parse `git status --porcelain=v2 --branch -z`. `repo_root` and
/// `linked_worktree` are left for the caller.
fn parse_status(out: &str) -> GitStatus {
    let mut st = GitStatus {
        repo_root: String::new(),
        branch: None,
        head: None,
        changed: 0,
        untracked: 0,
        linked_worktree: false,
        default_branch: None,
    };
    let mut entries = out.split('\0');
    while let Some(entry) = entries.next() {
        if let Some(oid) = entry.strip_prefix("# branch.oid ") {
            if oid != "(initial)" {
                st.head = Some(oid.chars().take(7).collect());
            }
        } else if let Some(head) = entry.strip_prefix("# branch.head ") {
            if head != "(detached)" {
                st.branch = Some(head.to_string());
            }
        } else if entry.starts_with("? ") {
            st.untracked += 1;
        } else if entry.starts_with("1 ") || entry.starts_with("u ") {
            st.changed += 1;
        } else if entry.starts_with("2 ") {
            // A rename or copy is followed by its original path as an entry
            // of its own; skip it so it isn't read as another record.
            st.changed += 1;
            entries.next();
        }
    }
    st
}

/// Local branches, by name.
#[cfg(test)]
pub async fn branches(dir: &Path) -> Result<Vec<String>, String> {
    branches_in(&Place::Host, &dir.to_string_lossy()).await
}

pub async fn branches_in(place: &Place, dir: &str) -> Result<Vec<String>, String> {
    let out = run_ok(
        place,
        dir,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
        GIT_TIMEOUT,
        false,
    )
    .await?;
    Ok(out
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// A branch name git will take, or why not. Also keeps a name from being
/// read as an option.
async fn check_branch_name(place: &Place, dir: &str, name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') {
        return Err(format!("\"{name}\" is not a valid branch name."));
    }
    let out = run(
        place,
        dir,
        &["check-ref-format", "--branch", name],
        GIT_TIMEOUT,
        false,
    )
    .await?;
    if out.ok {
        Ok(())
    } else {
        Err(format!("\"{name}\" is not a valid branch name."))
    }
}

/// Check out `branch`. Git refuses when uncommitted changes would be lost,
/// and that refusal is the error; nothing is stashed.
#[cfg(test)]
pub async fn switch(dir: &Path, branch: &str) -> Result<(), String> {
    switch_in(&Place::Host, &dir.to_string_lossy(), branch).await
}

pub async fn switch_in(place: &Place, dir: &str, branch: &str) -> Result<(), String> {
    check_branch_name(place, dir, branch).await?;
    run_ok(
        place,
        dir,
        &["switch", "--no-guess", branch],
        GIT_TIMEOUT,
        true,
    )
    .await?;
    Ok(())
}

/// Create `branch` at HEAD and check it out.
/// Create `branch` and switch to it, starting at `from` (a local branch) or
/// at the current commit. Uncommitted changes come along when git allows it.
#[cfg(test)]
pub async fn create_branch(dir: &Path, branch: &str, from: Option<&str>) -> Result<(), String> {
    create_branch_in(&Place::Host, &dir.to_string_lossy(), branch, from).await
}

pub async fn create_branch_in(
    place: &Place,
    dir: &str,
    branch: &str,
    from: Option<&str>,
) -> Result<(), String> {
    check_branch_name(place, dir, branch).await?;
    let mut args = vec!["switch", "-c", branch];
    if let Some(from) = from {
        if !branch_exists(place, dir, from).await? {
            return Err(format!("There is no branch named {from} here."));
        }
        args.push(from);
    }
    run_ok(place, dir, &args, GIT_TIMEOUT, true).await?;
    Ok(())
}

async fn branch_exists(place: &Place, dir: &str, branch: &str) -> Result<bool, String> {
    let r = format!("refs/heads/{branch}");
    Ok(run(
        place,
        dir,
        &["rev-parse", "--verify", "--quiet", &r],
        GIT_TIMEOUT,
        false,
    )
    .await?
    .ok)
}

/// A branch name from a fork's title: lower-case letters, digits and dashes.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "fork".to_string()
    } else {
        out.to_string()
    }
}

/// Make a worktree for a fork of a session rooted at `source_root`: a new
/// branch named from `title` (de-duplicated against branches and folders),
/// at the source checkout's HEAD, in `<repo>-worktrees/<branch>` beside the
/// main repository. Errs (with git's text) when `source_root` is not in a
/// repository or git refuses.
#[cfg(test)]
pub async fn add_fork_worktree(source_root: &Path, title: &str) -> Result<ForkWorktree, String> {
    let made = add_fork_worktree_in(&Place::Host, &source_root.to_string_lossy(), title).await?;
    Ok(ForkWorktree {
        path: PathBuf::from(made.path),
        root: PathBuf::from(made.root),
        branch: made.branch,
    })
}

/// [`add_fork_worktree`] in `place`: inside a WSL distro the worktree is made
/// by the distro's git, beside the repository there.
pub async fn add_fork_worktree_in(
    place: &Place,
    source_root: &str,
    title: &str,
) -> Result<WorktreeMade, String> {
    if !place.available().await {
        return Err("git is not installed.".to_string());
    }
    let (top, common, _) = locate(place, source_root)
        .await?
        .ok_or_else(|| format!("{source_root} is not in a git repository."))?;
    // The main worktree owns `.git`; every worktree goes beside it, so a fork
    // of a fork doesn't nest `a-worktrees/b-worktrees/…`.
    let main = match place.file_name(&common).as_deref() {
        Some(".git") => place.parent(&common).unwrap_or(top.clone()),
        _ => top.clone(),
    };
    let repo_name = place.file_name(&main).unwrap_or_else(|| "repo".to_string());
    let parent = place
        .parent(&main)
        .ok_or_else(|| format!("{main} has no parent folder for worktrees."))?;
    let base_dir = place.join(&parent, &format!("{repo_name}-worktrees"));

    let base = slug(title);
    let mut branch = base.clone();
    let mut n = 1;
    while branch_exists(place, &top, &branch).await?
        || place.exists(&place.join(&base_dir, &branch))
    {
        n += 1;
        branch = format!("{base}-{n}");
    }
    let path = place.join(&base_dir, &branch);
    place
        .create_dir_all(&base_dir)
        .map_err(|e| format!("Couldn't create {base_dir}: {e}"))?;
    run_ok(
        place,
        &top,
        &["worktree", "add", "-b", &branch, &path, "HEAD"],
        WORKTREE_TIMEOUT,
        true,
    )
    .await?;

    // The same subfolder in the new tree, when it exists there (it may be
    // ignored, or not yet committed).
    let rel = place
        .relative(&place.canonical(source_root), &place.canonical(&top))
        .unwrap_or_default();
    let path = place.canonical(&path);
    let nested = place.join(&path, &rel);
    let root = if place.is_dir(&nested) {
        place.canonical(&nested)
    } else {
        path.clone()
    };
    Ok(WorktreeMade {
        place: place.clone(),
        path,
        root,
        branch,
    })
}

/// Remove the linked worktree at `path`, but only when it has no
/// uncommitted or untracked files. The branch stays, so committed work is
/// never lost. A folder that is already gone counts as removed (and its
/// entry is pruned).
#[cfg(test)]
pub async fn remove_worktree(path: &Path) -> Result<WorktreeRemoval, String> {
    remove_worktree_in(&Place::Host, &path.to_string_lossy()).await
}

pub async fn remove_worktree_in(place: &Place, path: &str) -> Result<WorktreeRemoval, String> {
    if !place.available().await {
        return Ok(WorktreeRemoval::Kept {
            reason: "git is not installed.".to_string(),
        });
    }
    if !place.exists(path) {
        return Ok(WorktreeRemoval::Removed);
    }
    let Some(st) = status_in(place, path).await? else {
        return Ok(WorktreeRemoval::Kept {
            reason: "it is not a git worktree.".to_string(),
        });
    };
    if !st.linked_worktree || !place.same(&st.repo_root, path) {
        return Ok(WorktreeRemoval::Kept {
            reason: "it is not a linked worktree.".to_string(),
        });
    }
    if st.changed > 0 || st.untracked > 0 {
        return Ok(WorktreeRemoval::Kept {
            reason: "it has uncommitted changes.".to_string(),
        });
    }
    let Some((_, common, _)) = locate(place, path).await? else {
        return Ok(WorktreeRemoval::Kept {
            reason: "it is not a git worktree.".to_string(),
        });
    };
    // Run from the main repository: a worktree can't remove itself from inside.
    let main = place.parent(&common).unwrap_or(common);
    match run_ok(
        place,
        &main,
        &["worktree", "remove", path],
        GIT_TIMEOUT,
        true,
    )
    .await
    {
        Ok(_) => Ok(WorktreeRemoval::Removed),
        Err(e) => Ok(WorktreeRemoval::Kept { reason: e }),
    }
}

/// Undo a fork's worktree after a later step failed: remove it and delete
/// the branch it made. Best-effort.
#[cfg(test)]
pub async fn discard_fork_worktree(wt: &ForkWorktree) {
    let made = WorktreeMade {
        place: Place::Host,
        path: wt.path.to_string_lossy().into_owned(),
        root: wt.root.to_string_lossy().into_owned(),
        branch: wt.branch.clone(),
    };
    discard_worktree(&made).await;
}

/// [`discard_fork_worktree`] for a worktree in any place.
pub async fn discard_worktree(wt: &WorktreeMade) {
    let place = &wt.place;
    if let Ok(Some((_, common, _))) = locate(place, &wt.path).await {
        let main = place.parent(&common).unwrap_or(common);
        let _ = run(
            place,
            &main,
            &["worktree", "remove", "--force", &wt.path],
            GIT_TIMEOUT,
            true,
        )
        .await;
        let _ = run(
            place,
            &main,
            &["branch", "-D", &wt.branch],
            GIT_TIMEOUT,
            true,
        )
        .await;
    }
}

// --- commands ---------------------------------------------------------------

/// A Code session folder's git state; null without git or outside a repo.
/// `wsl_distro`: the git inside that distro, on a Linux `folder`.
#[tauri::command]
pub async fn code_git_status(
    folder: String,
    wsl_distro: Option<String>,
) -> Result<Option<GitStatus>, String> {
    status_in(&Place::new(wsl_distro), &folder).await
}

#[tauri::command]
pub async fn code_git_branches(
    folder: String,
    wsl_distro: Option<String>,
) -> Result<Vec<String>, String> {
    branches_in(&Place::new(wsl_distro), &folder).await
}

/// Check out a branch. Errs with git's own text when it refuses.
#[tauri::command]
pub async fn code_git_switch(
    folder: String,
    branch: String,
    wsl_distro: Option<String>,
) -> Result<(), String> {
    switch_in(&Place::new(wsl_distro), &folder, &branch).await
}

/// Create a branch at HEAD and check it out.
#[tauri::command]
pub async fn code_git_create_branch(
    folder: String,
    branch: String,
    from: Option<String>,
    wsl_distro: Option<String>,
) -> Result<(), String> {
    create_branch_in(&Place::new(wsl_distro), &folder, &branch, from.as_deref()).await
}

/// Remove a fork's worktree if it is clean; see [`remove_worktree`].
#[tauri::command]
pub async fn code_git_worktree_remove(
    path: String,
    wsl_distro: Option<String>,
) -> Result<WorktreeRemoval, String> {
    remove_worktree_in(&Place::new(wsl_distro), &path).await
}

/// The fork kinds `code_session_fork` makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum CodeForkMode {
    /// Same folder; may read, not write.
    ReadOnly,
    /// A new worktree on a new branch, writable.
    Worktree,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("haruspex_git_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::fs_tools::path::strip_verbatim(&dir.canonicalize().unwrap())
    }

    fn git(dir: &Path, args: &[&str]) {
        let st = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .unwrap();
        assert!(
            st.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&st.stderr)
        );
    }

    /// A repo `proj` with one commit on `main`, inside a fresh temp folder.
    fn repo(name: &str) -> (PathBuf, PathBuf) {
        let base = temp_dir(name);
        let proj = base.join("proj");
        std::fs::create_dir_all(proj.join("sub")).unwrap();
        git(&proj, &["init", "-q", "-b", "main"]);
        // A Windows git set to `autocrlf` would check files out as `one\r\n`.
        git(&proj, &["config", "core.autocrlf", "false"]);
        std::fs::write(proj.join("a.txt"), "one\n").unwrap();
        std::fs::write(proj.join("sub/b.txt"), "b\n").unwrap();
        git(&proj, &["add", "."]);
        git(&proj, &["commit", "-q", "-m", "init"]);
        (base, proj)
    }

    #[test]
    fn git_is_detected() {
        assert!(git_available());
    }

    #[test]
    fn linux_paths_are_handled_as_text() {
        let wsl = Place::Wsl("Ubuntu".into());
        assert_eq!(wsl.join("/home/t/p/", "x"), "/home/t/p/x");
        assert_eq!(wsl.join("/home/t/p", ""), "/home/t/p");
        assert_eq!(wsl.parent("/home/t/p/.git").as_deref(), Some("/home/t/p"));
        assert_eq!(wsl.parent("/p").as_deref(), Some("/"));
        assert_eq!(wsl.file_name("/home/t/p/").as_deref(), Some("p"));
        assert_eq!(
            wsl.relative("/home/t/p/sub", "/home/t/p").as_deref(),
            Some("sub")
        );
        assert_eq!(wsl.relative("/home/t/p", "/home/t/p/").as_deref(), Some(""));
        assert_eq!(wsl.relative("/home/t/px", "/home/t/p"), None);
        assert!(wsl.same("/home/t/p/", "/home/t/p"));
    }

    /// Needs a WSL2 distro with git: run on the Windows box with `--ignored`.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn git_runs_inside_the_distro_and_its_worktrees_name_linux_paths() {
        use crate::code_tools::wsl;
        let distro = wsl::distros().into_iter().next().expect("a WSL2 distro");
        let home = wsl::realpath_in(&distro, "~").await.unwrap();
        let base = format!("{home}/.haruspex-git-test-{}", std::process::id());
        let proj = format!("{base}/proj");
        let setup = format!(
            "set -e; rm -rf '{base}'; mkdir -p '{proj}/sub'; cd '{proj}'; git init -q -b main; \
             git config user.name t; git config user.email t@example.com; \
             git config commit.gpgsign false; echo one > a.txt; echo b > sub/b.txt; \
             git add .; git commit -q -m init"
        );
        let ok = wsl::wsl_exec(&distro, &["bash", "-c", &setup])
            .status()
            .await
            .unwrap();
        assert!(ok.success());
        let place = Place::Wsl(distro.clone());
        let sub = format!("{proj}/sub");

        let st = status_in(&place, &sub).await.unwrap().unwrap();
        assert_eq!(st.repo_root, proj);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert!(!st.linked_worktree);
        assert_eq!(st.default_branch.as_deref(), Some("main"));

        create_branch_in(&place, &proj, "feature", None)
            .await
            .unwrap();
        assert_eq!(
            branches_in(&place, &proj).await.unwrap(),
            vec!["feature", "main"]
        );
        switch_in(&place, &proj, "main").await.unwrap();

        let wt = add_fork_worktree_in(&place, &sub, "Fix it (fork)")
            .await
            .unwrap();
        assert_eq!(wt.branch, "fix-it-fork");
        assert_eq!(wt.path, format!("{base}/proj-worktrees/fix-it-fork"));
        assert_eq!(wt.root, format!("{}/sub", wt.path));
        let st = status_in(&place, &wt.root).await.unwrap().unwrap();
        assert!(st.linked_worktree);
        assert_eq!(st.branch.as_deref(), Some("fix-it-fork"));
        // The worktree's links are Linux paths, so the user's own git agrees.
        let dot_git =
            std::fs::read_to_string(wsl::share_path(&distro, &format!("{}/.git", wt.path)))
                .unwrap();
        assert!(
            dot_git.contains(&format!("gitdir: {proj}/.git/worktrees/")),
            "{dot_git}"
        );
        let list = wsl::wsl_exec(
            &distro,
            &["git", "-C", &proj, "worktree", "list", "--porcelain"],
        )
        .output()
        .await
        .unwrap();
        let list = String::from_utf8_lossy(&list.stdout);
        assert!(list.contains(&format!("worktree {}", wt.path)), "{list}");
        assert!(!list.contains("prunable"), "{list}");

        assert_eq!(
            remove_worktree_in(&place, &wt.path).await.unwrap(),
            WorktreeRemoval::Removed
        );
        assert!(!place.exists(&wt.path));
        let _ = wsl::wsl_exec(&distro, &["rm", "-rf", &base]).status().await;
    }

    #[tokio::test]
    async fn a_folder_outside_a_repo_has_no_status() {
        let dir = temp_dir("norepo");
        assert_eq!(status(&dir).await.unwrap(), None);
    }

    #[tokio::test]
    async fn status_reports_the_branch_and_changes() {
        let (_base, proj) = repo("status");
        let st = status(&proj.join("sub")).await.unwrap().unwrap();
        // git prints `C:/…` on Windows; the test dir is `\\?\C:\…`.
        assert_eq!(canonical(Path::new(&st.repo_root)), proj);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.head.as_ref().map(String::len), Some(7));
        assert_eq!((st.changed, st.untracked), (0, 0));
        assert!(!st.linked_worktree);

        std::fs::write(proj.join("a.txt"), "two\n").unwrap();
        std::fs::write(proj.join("new.txt"), "n\n").unwrap();
        let st = status(&proj).await.unwrap().unwrap();
        assert_eq!((st.changed, st.untracked), (1, 1));
    }

    #[tokio::test]
    async fn a_detached_head_has_no_branch() {
        let (_base, proj) = repo("detached");
        git(&proj, &["switch", "-q", "--detach", "HEAD"]);
        let st = status(&proj).await.unwrap().unwrap();
        assert_eq!(st.branch, None);
        assert!(st.head.is_some());
    }

    #[tokio::test]
    async fn branches_are_listed_created_and_switched() {
        let (_base, proj) = repo("branches");
        create_branch(&proj, "feature", None).await.unwrap();
        assert_eq!(
            status(&proj).await.unwrap().unwrap().branch.as_deref(),
            Some("feature")
        );
        assert_eq!(branches(&proj).await.unwrap(), vec!["feature", "main"]);
        switch(&proj, "main").await.unwrap();
        assert_eq!(
            status(&proj).await.unwrap().unwrap().branch.as_deref(),
            Some("main")
        );
        assert!(switch(&proj, "--orphan").await.is_err());
        assert!(create_branch(&proj, "bad name", None).await.is_err());
        assert!(switch(&proj, "nope").await.is_err());
    }

    #[tokio::test]
    async fn a_branch_can_start_from_the_default_branch() {
        let (_base, proj) = repo("from-main");
        create_branch(&proj, "feature", None).await.unwrap();
        std::fs::write(proj.join("a.txt"), "feature\n").unwrap();
        git(&proj, &["commit", "-qam", "feature work"]);
        let st = status(&proj).await.unwrap().unwrap();
        assert_eq!(st.default_branch.as_deref(), Some("main"));
        // From main: the feature commit is not on the new branch.
        create_branch(&proj, "fix", Some("main")).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(proj.join("a.txt")).unwrap(),
            "one\n"
        );
        assert!(create_branch(&proj, "x", Some("nope")).await.is_err());
    }

    #[tokio::test]
    async fn switching_over_uncommitted_changes_returns_gits_refusal() {
        let (_base, proj) = repo("dirty");
        create_branch(&proj, "other", None).await.unwrap();
        std::fs::write(proj.join("a.txt"), "other\n").unwrap();
        git(&proj, &["commit", "-qam", "other"]);
        switch(&proj, "main").await.unwrap();
        std::fs::write(proj.join("a.txt"), "local edit\n").unwrap();
        let err = switch(&proj, "other").await.unwrap_err();
        assert!(err.contains("would be overwritten"), "{err}");
        // Nothing was stashed or lost.
        assert_eq!(
            std::fs::read_to_string(proj.join("a.txt")).unwrap(),
            "local edit\n"
        );
    }

    #[test]
    fn slugs_are_branch_safe() {
        assert_eq!(slug("Fix the login (fork)"), "fix-the-login-fork");
        assert_eq!(slug("(fork)"), "fork");
        assert_eq!(slug("¡Olé!"), "ol");
        assert_eq!(slug("…"), "fork");
    }

    #[tokio::test]
    async fn a_fork_worktree_goes_beside_the_repo_and_removes_when_clean() {
        let (base, proj) = repo("worktree");
        let wt = add_fork_worktree(&proj.join("sub"), "Fix it (fork)")
            .await
            .unwrap();
        assert_eq!(wt.branch, "fix-it-fork");
        assert_eq!(wt.path, base.join("proj-worktrees/fix-it-fork"));
        assert_eq!(wt.root, wt.path.join("sub"));
        let st = status(&wt.root).await.unwrap().unwrap();
        assert!(st.linked_worktree);
        assert_eq!(st.branch.as_deref(), Some("fix-it-fork"));

        // The same title again takes the next free name, and a fork of the
        // worktree goes beside the main repo, not inside the worktrees folder.
        let again = add_fork_worktree(&wt.root, "Fix it (fork)").await.unwrap();
        assert_eq!(again.branch, "fix-it-fork-2");
        assert_eq!(again.path, base.join("proj-worktrees/fix-it-fork-2"));

        // Dirty: kept.
        std::fs::write(wt.path.join("scratch.txt"), "x").unwrap();
        assert!(matches!(
            remove_worktree(&wt.path).await.unwrap(),
            WorktreeRemoval::Kept { .. }
        ));
        assert!(wt.path.exists());
        std::fs::remove_file(wt.path.join("scratch.txt")).unwrap();
        assert_eq!(
            remove_worktree(&wt.path).await.unwrap(),
            WorktreeRemoval::Removed
        );
        assert!(!wt.path.exists());
        // The branch stays.
        assert!(branches(&proj)
            .await
            .unwrap()
            .contains(&"fix-it-fork".to_string()));

        // The main worktree is never removed.
        assert!(matches!(
            remove_worktree(&proj).await.unwrap(),
            WorktreeRemoval::Kept { .. }
        ));

        discard_fork_worktree(&again).await;
        assert!(!again.path.exists());
        assert!(!branches(&proj)
            .await
            .unwrap()
            .contains(&"fix-it-fork-2".to_string()));
    }

    #[tokio::test]
    async fn a_fork_worktree_outside_a_repo_is_refused() {
        let dir = temp_dir("wt_norepo");
        assert!(add_fork_worktree(&dir, "x").await.is_err());
    }
}
