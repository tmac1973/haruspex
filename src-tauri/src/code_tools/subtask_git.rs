//! Git for writing subtasks: each child agent works in a worktree of its own,
//! made from a snapshot of the session's folder as it is now (uncommitted and
//! untracked files included), and its changes come back as a patch applied
//! to the folder.
//!
//! The snapshot is built in a temporary index (`GIT_INDEX_FILE`) and committed
//! with `commit-tree`, so the user's index, stash, branches and HEAD are never
//! read or written. The commit is unreferenced; `git gc` collects it once the
//! worktree is gone. Worktrees are detached (no branch is made) and live in
//! `<repo>-worktrees/.subtasks/<session_id>-<n>`.
//!
//! Ignored dependency folders (`node_modules`, `.venv`, …) are linked into the
//! worktree rather than reinstalled, and every tree built here drops the
//! links after `add -A`, so they are never recorded as a change.
//!
//! Applying tries the patch as is first; when the folder has changed since,
//! a three-way merge runs in a scratch worktree, and only its result is
//! applied. The folder is only ever written by a `git apply` that has just
//! passed `--check`, so a conflict leaves it untouched.
//!
//! Every git command runs at the repository top of the checkout it acts on,
//! and every path is relative to that top.

use super::git::{
    locate, remove_empty_worktrees_dir, run, run_ok, run_raw, worktrees_dir, Place, GIT_TIMEOUT,
    WORKTREE_TIMEOUT,
};
use serde::Serialize;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

/// The ignored folders a worktree borrows from the folder it was made from.
const DEPENDENCY_DIRS: [&str; 4] = ["node_modules", ".venv", "venv", "vendor"];
/// The folder under `<repo>-worktrees` that holds subtask worktrees.
const SUBTASKS_DIR: &str = ".subtasks";
/// The name the scratch worktrees of a three-way apply start with.
const SCRATCH_PREFIX: &str = "apply";

/// A subtask's worktree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SubtaskWorktree {
    /// The worktree's top folder.
    pub path: String,
    /// Where the child works: the session's folder, at the same place inside
    /// the worktree (the top when that subfolder isn't there).
    pub root: String,
    /// The snapshot commit the worktree starts from; diffs are against it.
    pub base: String,
    /// The dependency folders linked in, by name.
    pub linked: Vec<String>,
}

/// A subtask's changes against its base.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SubtaskPatch {
    /// `git diff --binary` output, paths relative to the repository top.
    /// Empty when nothing changed.
    pub patch: String,
    /// The files the patch touches, relative to the repository top.
    pub files: Vec<String>,
}

/// What applying a subtask's patch to the folder did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SubtaskApply {
    /// The folder now has the changes.
    Applied { files: Vec<String> },
    /// Nothing was written; `files` are the ones that clash, and `message`
    /// is git's account of it.
    Conflict { files: Vec<String>, message: String },
}

/// A session id names folders: letters, digits, `-` and `_` only.
fn check_session_id(session_id: &str) -> Result<(), String> {
    let ok = !session_id.is_empty()
        && session_id != SCRATCH_PREFIX
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("\"{session_id}\" is not a valid session id."))
    }
}

/// A commit id, so it can't be read as an option.
fn check_commit(base: &str) -> Result<(), String> {
    if (4..=64).contains(&base.len()) && base.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("\"{base}\" is not a commit id."))
    }
}

async fn require_git(place: &Place) -> Result<(), String> {
    if place.available().await {
        Ok(())
    } else {
        Err("git is not installed.".to_string())
    }
}

/// `(top, common git dir, git dir)` for `dir`, or the sentence saying it
/// isn't in a repository.
async fn locate_repo(place: &Place, dir: &str) -> Result<(String, String, String), String> {
    locate(place, dir)
        .await?
        .ok_or_else(|| format!("{dir} is not in a git repository."))
}

// --- links -------------------------------------------------------------------

/// Is `path` a symlink (or a junction)? Never follows it.
async fn is_link(place: &Place, path: &str) -> bool {
    match place {
        Place::Host => std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()),
        Place::Wsl(distro) => super::wsl::wsl_exec(distro, &["test", "-L", path])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|s| s.success()),
    }
}

/// Link the folder `link` to `target`: a symlink, or a junction on a
/// Windows host (which needs no special privilege).
async fn make_link(place: &Place, target: &str, link: &str) -> Result<(), String> {
    match place {
        Place::Host => host_link(target, link),
        Place::Wsl(distro) => {
            let out = super::wsl::wsl_exec(distro, &["ln", "-s", "--", target, link])
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
            }
        }
    }
}

#[cfg(unix)]
fn host_link(target: &str, link: &str) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn host_link(target: &str, link: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // `cmd` parses its own line; Windows paths can't hold a `"`.
    let mut c = std::process::Command::new("cmd");
    c.raw_arg(format!("/C mklink /J \"{link}\" \"{target}\""))
        .stdin(Stdio::null());
    crate::shell::platform::apply_no_window(&mut c);
    let out = c.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Remove `path` if it is a link; the folder it points at is never entered.
async fn remove_link(place: &Place, path: &str) {
    if !is_link(place, path).await {
        return;
    }
    match place {
        // A junction or a directory symlink on Windows is removed as a folder.
        Place::Host => {
            if std::fs::remove_file(path).is_err() {
                let _ = std::fs::remove_dir(path);
            }
        }
        Place::Wsl(distro) => {
            let _ = super::wsl::wsl_exec(distro, &["rm", "-f", "--", path])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
    }
}

/// Link each ignored dependency folder at `source_top` into `worktree_top`.
/// A link that can't be made is skipped: the child can still install.
async fn link_dependencies(place: &Place, source_top: &str, worktree_top: &str) -> Vec<String> {
    let mut linked = Vec::new();
    for name in DEPENDENCY_DIRS {
        let source = place.join(source_top, name);
        let link = place.join(worktree_top, name);
        if !place.is_dir(&source) || place.exists(&link) || is_link(place, &link).await {
            continue;
        }
        let ignored = run(
            place,
            source_top,
            &["check-ignore", "-q", "--", name],
            GIT_TIMEOUT,
            false,
        )
        .await
        .is_ok_and(|o| o.ok);
        if !ignored {
            continue;
        }
        match make_link(place, &source, &link).await {
            Ok(()) => linked.push(name.to_string()),
            Err(e) => log::warn!("subtask: couldn't link {name}: {e}"),
        }
    }
    linked
}

/// The dependency links at `top`, by name.
async fn links_at(place: &Place, top: &str) -> Vec<&'static str> {
    let mut out = Vec::new();
    for name in DEPENDENCY_DIRS {
        if is_link(place, &place.join(top, name)).await {
            out.push(name);
        }
    }
    out
}

// --- trees -------------------------------------------------------------------

/// A temporary index file in a git dir, removed when dropped.
struct TempIndex {
    place: Place,
    path: String,
}

impl TempIndex {
    fn new(place: &Place, git_dir: &str) -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let name = format!(
            "haruspex-subtask-index-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        );
        TempIndex {
            place: place.clone(),
            path: place.join(git_dir, &name),
        }
    }

    fn env(&self) -> Vec<String> {
        vec![format!("GIT_INDEX_FILE={}", self.path)]
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.place.host_path(&self.path));
        let _ = std::fs::remove_file(self.place.host_path(&format!("{}.lock", self.path)));
    }
}

/// Run git with `env`, returning stdout or git's error text.
async fn run_env(
    place: &Place,
    dir: &str,
    args: &[&str],
    env: &[String],
    timeout: std::time::Duration,
) -> Result<String, String> {
    let out = run_raw(place, dir, args, timeout, true, env, None).await?;
    if out.ok {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else if out.stderr.is_empty() {
        Err(format!("git {} failed.", args[0]))
    } else {
        Err(out.stderr)
    }
}

/// The tree of everything at `top` (tracked, changed and untracked files,
/// not ignored ones nor the links), built in a temp index that starts from
/// `start` (a commit, or the empty tree when `None`).
async fn worktree_tree(
    place: &Place,
    top: &str,
    git_dir: &str,
    start: Option<&str>,
) -> Result<String, String> {
    let index = TempIndex::new(place, git_dir);
    let env = index.env();
    match start {
        Some(c) => run_env(place, top, &["read-tree", c], &env, GIT_TIMEOUT).await?,
        None => run_env(place, top, &["read-tree", "--empty"], &env, GIT_TIMEOUT).await?,
    };
    run_env(
        place,
        top,
        &["add", "-A", "--", ":/"],
        &env,
        WORKTREE_TIMEOUT,
    )
    .await?;
    // Then take the links back out. Not an `:(exclude)` pathspec on the add:
    // git refuses one that names an ignored path, which is every link whose
    // folder `.gitignore` matches without a trailing slash (`node_modules`).
    // A pattern with one (`node_modules/`) doesn't match a link, so add -A
    // staged it; either way it is gone from the tree.
    let links = links_at(place, top).await;
    if !links.is_empty() {
        let mut rm = vec!["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"];
        rm.extend(links.iter().copied());
        run_env(place, top, &rm, &env, GIT_TIMEOUT).await?;
    }
    run_env(place, top, &["write-tree"], &env, GIT_TIMEOUT).await
}

/// Commit the checkout at `top` as it is now, uncommitted and untracked files
/// included, with HEAD as the parent. Returns the commit id; nothing refers
/// to it. The user's index is never read or written.
async fn snapshot_commit(place: &Place, top: &str, git_dir: &str) -> Result<String, String> {
    let head = run(
        place,
        top,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        GIT_TIMEOUT,
        false,
    )
    .await?;
    let head = head.ok.then(|| head.stdout.trim().to_string());
    let tree = worktree_tree(place, top, git_dir, head.as_deref()).await?;
    let mut args = vec!["commit-tree", "--no-gpg-sign", &tree];
    if let Some(head) = &head {
        args.extend(["-p", head]);
    }
    args.extend(["-m", "haruspex subtask base"]);
    // Not the user's commit, and their identity may not be set.
    let env: Vec<String> = [
        "GIT_AUTHOR_NAME=Haruspex",
        "GIT_AUTHOR_EMAIL=haruspex@localhost",
        "GIT_COMMITTER_NAME=Haruspex",
        "GIT_COMMITTER_EMAIL=haruspex@localhost",
    ]
    .map(String::from)
    .to_vec();
    run_env(place, top, &args, &env, GIT_TIMEOUT).await
}

/// `git diff --binary base tree` and the files it touches. Plumbing, so the
/// user's diff settings (no prefix, an external diff, colour) don't apply.
async fn patch_between(
    place: &Place,
    top: &str,
    git_dir: &str,
    base: &str,
    tree: &str,
) -> Result<SubtaskPatch, String> {
    let diff = [
        "diff-tree",
        "-r",
        "-p",
        "--binary",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        base,
        tree,
    ];
    let out = run_raw(place, top, &diff, WORKTREE_TIMEOUT, false, &[], None).await?;
    if !out.ok {
        return Err(out.stderr);
    }
    let patch = match String::from_utf8(out.stdout) {
        Ok(p) => p,
        // Text that isn't UTF-8: diff every file as binary instead, which
        // is plain ASCII and applies the same.
        Err(_) => {
            let attrs = place.join(git_dir, "haruspex-subtask-attributes");
            std::fs::write(place.host_path(&attrs), "* binary\n")
                .map_err(|e| format!("Couldn't write {attrs}: {e}"))?;
            let set = format!("core.attributesFile={attrs}");
            let mut args = vec!["-c", &set];
            args.extend(diff);
            let out = run_raw(place, top, &args, WORKTREE_TIMEOUT, false, &[], None).await;
            let _ = std::fs::remove_file(place.host_path(&attrs));
            let out = out?;
            if !out.ok {
                return Err(out.stderr);
            }
            String::from_utf8(out.stdout)
                .map_err(|_| "The changes include text that isn't UTF-8.".to_string())?
        }
    };
    let names = run_ok(
        place,
        top,
        &[
            "diff-tree",
            "-r",
            "--name-only",
            "-z",
            "--no-renames",
            base,
            tree,
        ],
        GIT_TIMEOUT,
        false,
    )
    .await?;
    Ok(SubtaskPatch {
        patch,
        files: names
            .split('\0')
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .collect(),
    })
}

// --- worktrees ---------------------------------------------------------------

/// Make a fresh empty folder `<dir>/<prefix>-<n>`, `n` counting up from 1
/// past any that exist. Making it is the reservation, so subtasks started
/// together never pick the same one.
fn reserve(place: &Place, dir: &str, prefix: &str) -> Result<String, String> {
    place
        .create_dir_all(dir)
        .map_err(|e| format!("Couldn't create {dir}: {e}"))?;
    for n in 1.. {
        let path = place.join(dir, &format!("{prefix}-{n}"));
        match std::fs::create_dir(place.host_path(&path)) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Couldn't create {path}: {e}")),
        }
    }
    unreachable!()
}

/// `.subtasks` under the repository's `<repo>-worktrees`.
fn subtasks_dir(place: &Place, top: &str, common: &str) -> Result<String, String> {
    Ok(place.join(&worktrees_dir(place, top, common)?, SUBTASKS_DIR))
}

/// A detached worktree of the repository at `top`, at `commit`, in the
/// empty folder `path`. On failure the folder is removed again.
async fn add_detached(place: &Place, top: &str, path: &str, commit: &str) -> Result<(), String> {
    let made = run_ok(
        place,
        top,
        &["worktree", "add", "--detach", "--quiet", path, commit],
        WORKTREE_TIMEOUT,
        true,
    )
    .await;
    if made.is_err() {
        place.remove_empty_dir(path);
        if let Some(parent) = place.parent(path) {
            remove_empty_subtasks_dir(place, &parent);
        }
    }
    made.map(|_| ())
}

/// The `.subtasks` folder once it is empty, and `<repo>-worktrees` after it.
fn remove_empty_subtasks_dir(place: &Place, subtasks: &str) {
    place.remove_empty_dir(subtasks);
    remove_empty_worktrees_dir(place, subtasks);
}

/// [`code_subtask_worktree_create`] in `place`.
pub async fn create_in(
    place: &Place,
    folder: &str,
    session_id: &str,
) -> Result<SubtaskWorktree, String> {
    check_session_id(session_id)?;
    require_git(place).await?;
    let (top, common, git_dir) = locate_repo(place, folder).await?;
    let base = snapshot_commit(place, &top, &git_dir).await?;
    let subtasks = subtasks_dir(place, &top, &common)?;
    let path = reserve(place, &subtasks, session_id)?;
    add_detached(place, &top, &path, &base).await?;
    let path = place.canonical(&path);
    let linked = link_dependencies(place, &top, &path).await;

    // The same subfolder in the new tree, as a fork's worktree does.
    let rel = place
        .relative(&place.canonical(folder), &place.canonical(&top))
        .unwrap_or_default();
    let nested = place.join(&path, &rel);
    let root = if place.is_dir(&nested) {
        place.canonical(&nested)
    } else {
        path.clone()
    };
    Ok(SubtaskWorktree {
        path,
        root,
        base,
        linked,
    })
}

/// [`code_subtask_worktree_diff`] in `place`.
pub async fn diff_in(place: &Place, path: &str, base: &str) -> Result<SubtaskPatch, String> {
    check_commit(base)?;
    require_git(place).await?;
    let (top, _, git_dir) = locate_repo(place, path).await?;
    let tree = worktree_tree(place, &top, &git_dir, Some(base)).await?;
    patch_between(place, &top, &git_dir, base, &tree).await
}

/// The files a patch touches, as `git apply --numstat` reads them.
async fn patch_files(place: &Place, top: &str, patch: &str) -> Vec<String> {
    let Ok(out) = run_raw(
        place,
        top,
        &["apply", "--numstat", "-z"],
        GIT_TIMEOUT,
        false,
        &[],
        Some(patch.as_bytes()),
    )
    .await
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter_map(|rec| rec.splitn(3, '\t').nth(2))
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

/// `git apply` of `patch` at `top`, working tree only: `--check` first, and
/// the real thing only when that passes. `Err(message)` when it doesn't.
async fn checked_apply(
    place: &Place,
    top: &str,
    patch: &str,
) -> Result<Result<(), String>, String> {
    let base = ["apply", "--binary", "--whitespace=nowarn"];
    let mut check = base.to_vec();
    check.push("--check");
    let out = run_raw(
        place,
        top,
        &check,
        GIT_TIMEOUT,
        false,
        &[],
        Some(patch.as_bytes()),
    )
    .await?;
    if !out.ok {
        return Ok(Err(out.stderr));
    }
    let out = run_raw(
        place,
        top,
        &base,
        WORKTREE_TIMEOUT,
        true,
        &[],
        Some(patch.as_bytes()),
    )
    .await?;
    Ok(if out.ok { Ok(()) } else { Err(out.stderr) })
}

/// [`code_subtask_apply`] in `place`.
pub async fn apply_in(place: &Place, folder: &str, patch: &str) -> Result<SubtaskApply, String> {
    // Two subtasks finishing together apply one after the other.
    static APPLYING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _turn = APPLYING.lock().await;
    require_git(place).await?;
    let (top, common, git_dir) = locate_repo(place, folder).await?;
    if patch.trim().is_empty() {
        return Ok(SubtaskApply::Applied { files: Vec::new() });
    }
    let files = patch_files(place, &top, patch).await;
    if checked_apply(place, &top, patch).await?.is_ok() {
        return Ok(SubtaskApply::Applied { files });
    }

    // The folder changed since the snapshot: merge in a scratch worktree of
    // the folder as it is now.
    let snap = snapshot_commit(place, &top, &git_dir).await?;
    let subtasks = subtasks_dir(place, &top, &common)?;
    let scratch = reserve(place, &subtasks, SCRATCH_PREFIX)?;
    add_detached(place, &top, &scratch, &snap).await?;
    let merged = three_way(place, &scratch, &snap, patch, &files).await;
    let _ = run(
        place,
        &top,
        &["worktree", "remove", "--force", &scratch],
        WORKTREE_TIMEOUT,
        true,
    )
    .await;
    place.remove_empty_dir(&scratch);
    remove_empty_subtasks_dir(place, &subtasks);

    let merged = match merged? {
        Ok(merged) => merged,
        Err(conflict) => return Ok(conflict),
    };
    match checked_apply(place, &top, &merged.patch).await? {
        Ok(()) => Ok(SubtaskApply::Applied {
            files: merged.files,
        }),
        Err(message) => Ok(SubtaskApply::Conflict {
            files: merged.files,
            message: if message.is_empty() {
                "The folder changed while the changes were being merged.".to_string()
            } else {
                message
            },
        }),
    }
}

/// `git apply --3way` of `patch` in the scratch worktree at `scratch`
/// (checked out at `snap`): the merged changes as a patch against `snap`,
/// or the conflict.
async fn three_way(
    place: &Place,
    scratch: &str,
    snap: &str,
    patch: &str,
    files: &[String],
) -> Result<Result<SubtaskPatch, SubtaskApply>, String> {
    let (top, _, git_dir) = locate_repo(place, scratch).await?;
    let out = run_raw(
        place,
        &top,
        &["apply", "--3way", "--binary", "--whitespace=nowarn"],
        WORKTREE_TIMEOUT,
        true,
        &[],
        Some(patch.as_bytes()),
    )
    .await?;
    let unmerged = run_ok(place, &top, &["ls-files", "-u", "-z"], GIT_TIMEOUT, false).await?;
    let mut clashing: Vec<String> = Vec::new();
    for rec in unmerged.split('\0') {
        if let Some((_, path)) = rec.split_once('\t') {
            if !clashing.iter().any(|p| p == path) {
                clashing.push(path.to_string());
            }
        }
    }
    let check = run(place, &top, &["diff", "--check", snap], GIT_TIMEOUT, false).await?;
    let markers = check.stdout.contains("leftover conflict marker");
    if out.ok && clashing.is_empty() && !markers {
        let tree = worktree_tree(place, &top, &git_dir, Some(snap)).await?;
        return Ok(Ok(patch_between(place, &top, &git_dir, snap, &tree).await?));
    }
    let message = if out.stderr.is_empty() {
        "The changes conflict with the folder's.".to_string()
    } else {
        out.stderr
    };
    Ok(Err(SubtaskApply::Conflict {
        files: if clashing.is_empty() {
            files.to_vec()
        } else {
            clashing
        },
        message,
    }))
}

/// [`code_subtask_worktree_discard`] in `place`.
pub async fn discard_in(place: &Place, path: &str) -> Result<(), String> {
    let subtasks = place
        .parent(path)
        .filter(|p| place.file_name(p).as_deref() == Some(SUBTASKS_DIR))
        .ok_or_else(|| format!("{path} is not a subtask worktree."))?;
    if !place.exists(path) {
        remove_empty_subtasks_dir(place, &subtasks);
        return Ok(());
    }
    require_git(place).await?;
    // The links first, so nothing below can follow one into the real folder.
    for name in DEPENDENCY_DIRS {
        remove_link(place, &place.join(path, name)).await;
    }
    match locate(place, path).await? {
        Some((top, common, _)) if place.same(&top, path) => {
            // Run from the main repository: a worktree can't remove itself.
            let main = place.parent(&common).unwrap_or(common);
            run_ok(
                place,
                &main,
                &["worktree", "remove", "--force", path],
                WORKTREE_TIMEOUT,
                true,
            )
            .await?;
        }
        // A folder reserved for a worktree that was never made.
        _ => {
            place.remove_empty_dir(path);
            if place.exists(path) {
                return Err(format!("{path} is not a git worktree."));
            }
        }
    }
    remove_empty_subtasks_dir(place, &subtasks);
    Ok(())
}

/// [`code_subtask_worktrees_discard_session`] in `place`.
pub async fn discard_session_in(
    place: &Place,
    folder: &str,
    session_id: &str,
) -> Result<(), String> {
    check_session_id(session_id)?;
    require_git(place).await?;
    let (top, common, _) = locate_repo(place, folder).await?;
    let subtasks = subtasks_dir(place, &top, &common)?;
    let Ok(entries) = std::fs::read_dir(place.host_path(&subtasks)) else {
        return Ok(());
    };
    let prefix = format!("{session_id}-");
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| {
            n.strip_prefix(&prefix)
                .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
        })
        .collect();
    names.sort();
    let mut first_err = None;
    for name in names {
        if let Err(e) = discard_in(place, &place.join(&subtasks, &name)).await {
            first_err.get_or_insert(e);
        }
    }
    first_err.map_or(Ok(()), Err)
}

// --- commands ----------------------------------------------------------------

/// A worktree for a writing subtask of `session_id`, made from a snapshot of
/// `folder` as it is now, with the folder's ignored dependency folders linked
/// in. `wsl_distro`: the git inside that distro, on a Linux `folder`.
#[tauri::command]
pub async fn code_subtask_worktree_create(
    folder: String,
    session_id: String,
    wsl_distro: Option<String>,
) -> Result<SubtaskWorktree, String> {
    create_in(&Place::new(wsl_distro), &folder, &session_id).await
}

/// The changes in the subtask worktree at `path` since `base`.
#[tauri::command]
pub async fn code_subtask_worktree_diff(
    path: String,
    base: String,
    wsl_distro: Option<String>,
) -> Result<SubtaskPatch, String> {
    diff_in(&Place::new(wsl_distro), &path, &base).await
}

/// Apply a subtask's patch to `folder`'s working tree, merging three ways
/// when the folder changed meanwhile. A conflict writes nothing.
#[tauri::command]
pub async fn code_subtask_apply(
    folder: String,
    patch: String,
    wsl_distro: Option<String>,
) -> Result<SubtaskApply, String> {
    apply_in(&Place::new(wsl_distro), &folder, &patch).await
}

/// Remove a subtask worktree, its links first.
#[tauri::command]
pub async fn code_subtask_worktree_discard(
    path: String,
    wsl_distro: Option<String>,
) -> Result<(), String> {
    discard_in(&Place::new(wsl_distro), &path).await
}

/// Remove every subtask worktree `session_id` made in `folder`'s repository.
#[tauri::command]
pub async fn code_subtask_worktrees_discard_session(
    folder: String,
    session_id: String,
    wsl_distro: Option<String>,
) -> Result<(), String> {
    discard_session_in(&Place::new(wsl_distro), &folder, &session_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;
    use std::path::{Path, PathBuf};

    fn git_out(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
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
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn git(dir: &Path, args: &[&str]) {
        git_out(dir, args);
    }

    /// Ten numbered lines, `line 1`…`line 10`.
    fn lines() -> String {
        (1..=10).map(|i| format!("line {i}\n")).collect()
    }

    /// `proj` with one commit (`a.txt`, `sub/b.txt`, `lines.txt`, `bin.dat`),
    /// ignoring `node_modules/`, in a fresh temp folder.
    fn repo(name: &str) -> (crate::test_util::TestDir, PathBuf) {
        let base = temp_dir(name);
        let proj = base.join("proj");
        std::fs::create_dir_all(proj.join("sub")).unwrap();
        git(&proj, &["init", "-q", "-b", "main"]);
        git(&proj, &["config", "core.autocrlf", "false"]);
        std::fs::write(proj.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(proj.join("a.txt"), "one\n").unwrap();
        std::fs::write(proj.join("sub/b.txt"), "b\n").unwrap();
        std::fs::write(proj.join("lines.txt"), lines()).unwrap();
        std::fs::write(proj.join("bin.dat"), [0u8, 1, 2, 3, 255, 0, 7]).unwrap();
        git(&proj, &["add", "."]);
        git(&proj, &["commit", "-q", "-m", "init"]);
        (base, proj)
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    async fn create(dir: &Path, session: &str) -> SubtaskWorktree {
        create_in(&Place::Host, &s(dir), session).await.unwrap()
    }

    async fn diff(wt: &SubtaskWorktree) -> SubtaskPatch {
        diff_in(&Place::Host, &wt.path, &wt.base).await.unwrap()
    }

    async fn apply(dir: &Path, patch: &str) -> SubtaskApply {
        apply_in(&Place::Host, &s(dir), patch).await.unwrap()
    }

    fn worktree_count(proj: &Path) -> usize {
        git_out(proj, &["worktree", "list", "--porcelain"])
            .lines()
            .filter(|l| l.starts_with("worktree "))
            .count()
    }

    #[tokio::test]
    async fn a_snapshot_has_the_uncommitted_files_and_leaves_git_state_alone() {
        let (_base, proj) = repo("snap");
        std::fs::write(proj.join("a.txt"), "edited\n").unwrap();
        std::fs::write(proj.join("new.txt"), "untracked\n").unwrap();
        std::fs::write(proj.join("sub/b.txt"), "staged\n").unwrap();
        git(&proj, &["add", "sub/b.txt"]);
        let before = (
            git_out(&proj, &["status", "--porcelain"]),
            git_out(&proj, &["stash", "list"]),
            git_out(&proj, &["ls-files", "-s"]),
            git_out(&proj, &["rev-parse", "HEAD"]),
        );

        let (top, _, git_dir) = locate_repo(&Place::Host, &s(&proj)).await.unwrap();
        let commit = snapshot_commit(&Place::Host, &top, &git_dir).await.unwrap();

        assert_eq!(
            git_out(&proj, &["show", &format!("{commit}:a.txt")]),
            "edited\n"
        );
        assert_eq!(
            git_out(&proj, &["show", &format!("{commit}:new.txt")]),
            "untracked\n"
        );
        assert_eq!(
            git_out(&proj, &["rev-parse", &format!("{commit}^")]),
            before.3
        );
        let after = (
            git_out(&proj, &["status", "--porcelain"]),
            git_out(&proj, &["stash", "list"]),
            git_out(&proj, &["ls-files", "-s"]),
            git_out(&proj, &["rev-parse", "HEAD"]),
        );
        assert_eq!(before, after);
        // No temp index is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&git_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("haruspex-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[tokio::test]
    async fn a_repo_with_no_commits_snapshots_without_a_parent() {
        let base = temp_dir("snap_empty");
        let proj = base.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        git(&proj, &["init", "-q", "-b", "main"]);
        std::fs::write(proj.join("a.txt"), "one\n").unwrap();
        let (top, _, git_dir) = locate_repo(&Place::Host, &s(&proj)).await.unwrap();
        let commit = snapshot_commit(&Place::Host, &top, &git_dir).await.unwrap();
        assert_eq!(
            git_out(&proj, &["show", &format!("{commit}:a.txt")]),
            "one\n"
        );
        assert_eq!(
            git_out(&proj, &["rev-list", "--parents", "-n1", &commit]).trim(),
            commit
        );
    }

    #[tokio::test]
    async fn a_worktree_from_a_dirty_folder_has_the_edit_and_no_new_branch() {
        let (base, proj) = repo("create");
        std::fs::write(proj.join("a.txt"), "edited\n").unwrap();
        std::fs::write(proj.join("sub/new.txt"), "new\n").unwrap();
        let branches = git_out(&proj, &["branch"]);

        let wt = create(&proj.join("sub"), "s1").await;
        let path = PathBuf::from(&wt.path);
        assert_eq!(path, base.join("proj-worktrees/.subtasks/s1-1"));
        assert_eq!(PathBuf::from(&wt.root), path.join("sub"));
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "edited\n"
        );
        assert_eq!(
            std::fs::read_to_string(path.join("sub/new.txt")).unwrap(),
            "new\n"
        );
        assert_eq!(git_out(&proj, &["branch"]), branches);
        assert_eq!(git_out(&path, &["rev-parse", "HEAD"]).trim(), wt.base);

        let second = create(&proj, "s1").await;
        assert!(second.path.ends_with("s1-2"), "{}", second.path);
    }

    #[tokio::test]
    async fn ignored_dependencies_are_linked_and_left_out_of_the_diff() {
        let (_base, proj) = repo("links");
        std::fs::create_dir_all(proj.join("node_modules/pkg")).unwrap();
        std::fs::write(proj.join("node_modules/pkg/index.js"), "x\n").unwrap();
        // Not ignored: it's the user's to commit, so it is copied, not linked.
        std::fs::create_dir_all(proj.join("vendor")).unwrap();
        std::fs::write(proj.join("vendor/lib.txt"), "v\n").unwrap();

        let wt = create(&proj, "s1").await;
        assert_eq!(wt.linked, vec!["node_modules"]);
        let path = PathBuf::from(&wt.path);
        assert!(std::fs::symlink_metadata(path.join("node_modules"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!std::fs::symlink_metadata(path.join("vendor"))
            .unwrap()
            .file_type()
            .is_symlink());

        std::fs::write(path.join("node_modules/pkg/index.js"), "y\n").unwrap();
        std::fs::write(path.join("node_modules/pkg/more.js"), "z\n").unwrap();
        assert_eq!(diff(&wt).await.patch, "");
    }

    #[tokio::test]
    async fn links_ignored_without_a_trailing_slash_are_left_out_too() {
        let (_base, proj) = repo("links-noslash");
        std::fs::write(proj.join(".gitignore"), "node_modules\n").unwrap();
        git(&proj, &["commit", "-q", "-am", "ignore without a slash"]);
        std::fs::create_dir_all(proj.join("node_modules/pkg")).unwrap();
        std::fs::write(proj.join("node_modules/pkg/index.js"), "x\n").unwrap();

        let wt = create(&proj, "s1").await;
        assert_eq!(wt.linked, vec!["node_modules"]);
        let path = PathBuf::from(&wt.path);
        std::fs::write(path.join("a.txt"), "changed\n").unwrap();
        std::fs::write(path.join("node_modules/pkg/index.js"), "y\n").unwrap();
        let patch = diff(&wt).await;
        assert_eq!(patch.files, vec!["a.txt"]);
        assert!(!patch.patch.contains("node_modules"));
    }

    #[tokio::test]
    async fn changes_round_trip_through_diff_and_apply() {
        let (_base, proj) = repo("roundtrip");
        let wt = create(&proj, "s1").await;
        assert_eq!(
            diff(&wt).await,
            SubtaskPatch {
                patch: String::new(),
                files: vec![]
            }
        );

        let path = PathBuf::from(&wt.path);
        std::fs::write(path.join("a.txt"), "changed\n").unwrap();
        std::fs::write(path.join("added.txt"), "added\n").unwrap();
        std::fs::remove_file(path.join("sub/b.txt")).unwrap();
        std::fs::write(path.join("bin.dat"), [9u8, 0, 8, 0, 255, 254]).unwrap();
        std::fs::write(path.join("new.bin"), [0u8, 0, 1, 200]).unwrap();
        let p = diff(&wt).await;
        let mut files = p.files.clone();
        files.sort();
        assert_eq!(
            files,
            vec!["a.txt", "added.txt", "bin.dat", "new.bin", "sub/b.txt"]
        );

        let SubtaskApply::Applied { mut files } = apply(&proj, &p.patch).await else {
            panic!("expected Applied");
        };
        files.sort();
        assert_eq!(
            files,
            vec!["a.txt", "added.txt", "bin.dat", "new.bin", "sub/b.txt"]
        );
        for f in ["a.txt", "added.txt", "bin.dat", "new.bin"] {
            assert_eq!(
                std::fs::read(proj.join(f)).unwrap(),
                std::fs::read(path.join(f)).unwrap(),
                "{f}"
            );
        }
        assert!(!proj.join("sub/b.txt").exists());
        // Working tree only: nothing staged.
        assert_eq!(git_out(&proj, &["diff", "--cached", "--name-only"]), "");
    }

    #[tokio::test]
    async fn a_change_elsewhere_in_the_file_merges_three_ways() {
        let (_base, proj) = repo("threeway");
        let wt = create(&proj, "s1").await;
        let path = PathBuf::from(&wt.path);
        std::fs::write(
            path.join("lines.txt"),
            lines().replace("line 5\n", "child 5\n"),
        )
        .unwrap();
        let p = diff(&wt).await;

        let folder = lines().replace("line 3\n", "user 3\n");
        std::fs::write(proj.join("lines.txt"), &folder).unwrap();
        // Close enough that the patch's context no longer matches.
        let (top, _, _) = locate_repo(&Place::Host, &s(&proj)).await.unwrap();
        assert!(checked_apply_check_only(&top, &p.patch).await.is_err());

        assert_eq!(
            apply(&proj, &p.patch).await,
            SubtaskApply::Applied {
                files: vec!["lines.txt".into()]
            }
        );
        assert_eq!(
            std::fs::read_to_string(proj.join("lines.txt")).unwrap(),
            folder.replace("line 5\n", "child 5\n")
        );
        assert_eq!(worktree_count(&proj), 2);
        assert_eq!(git_out(&proj, &["diff", "--cached", "--name-only"]), "");
    }

    async fn checked_apply_check_only(top: &str, patch: &str) -> Result<(), String> {
        let out = run_raw(
            &Place::Host,
            top,
            &["apply", "--check", "--binary"],
            GIT_TIMEOUT,
            false,
            &[],
            Some(patch.as_bytes()),
        )
        .await
        .unwrap();
        if out.ok {
            Ok(())
        } else {
            Err(out.stderr)
        }
    }

    #[tokio::test]
    async fn the_same_lines_changed_conflict_and_the_folder_is_untouched() {
        let (_base, proj) = repo("conflict");
        let wt = create(&proj, "s1").await;
        let path = PathBuf::from(&wt.path);
        std::fs::write(
            path.join("lines.txt"),
            lines().replace("line 5\n", "child 5\n"),
        )
        .unwrap();
        let p = diff(&wt).await;

        std::fs::write(
            proj.join("lines.txt"),
            lines().replace("line 5\n", "user 5\n"),
        )
        .unwrap();
        std::fs::write(proj.join("untracked.txt"), "u\n").unwrap();
        let snapshot = |dir: &Path| {
            ["lines.txt", "a.txt", "untracked.txt", "bin.dat"]
                .map(|f| std::fs::read(dir.join(f)).unwrap())
        };
        let before = snapshot(&proj);
        let status = git_out(&proj, &["status", "--porcelain"]);
        let index = git_out(&proj, &["ls-files", "-s"]);

        let SubtaskApply::Conflict { files, message } = apply(&proj, &p.patch).await else {
            panic!("expected Conflict");
        };
        assert_eq!(files, vec!["lines.txt"]);
        assert!(!message.is_empty());
        assert_eq!(snapshot(&proj), before);
        assert_eq!(git_out(&proj, &["status", "--porcelain"]), status);
        assert_eq!(git_out(&proj, &["ls-files", "-s"]), index);
        // The scratch worktree is gone; only the subtask's remains.
        assert_eq!(worktree_count(&proj), 2);
    }

    #[tokio::test]
    async fn discard_removes_the_worktree_and_keeps_the_real_dependencies() {
        let (base, proj) = repo("discard");
        std::fs::create_dir_all(proj.join("node_modules/pkg")).unwrap();
        std::fs::write(proj.join("node_modules/pkg/index.js"), "x\n").unwrap();
        let wt = create(&proj, "s1").await;
        assert_eq!(wt.linked, vec!["node_modules"]);

        discard_in(&Place::Host, &wt.path).await.unwrap();
        assert!(!Path::new(&wt.path).exists());
        assert_eq!(
            std::fs::read_to_string(proj.join("node_modules/pkg/index.js")).unwrap(),
            "x\n"
        );
        assert_eq!(worktree_count(&proj), 1);
        assert!(!base.join("proj-worktrees").exists());

        // Already gone is fine; a folder that isn't a subtask's is refused.
        discard_in(&Place::Host, &wt.path).await.unwrap();
        assert!(discard_in(&Place::Host, &s(&proj)).await.is_err());
    }

    #[tokio::test]
    async fn discarding_a_session_removes_only_its_worktrees() {
        let (_base, proj) = repo("session");
        let a1 = create(&proj, "aaa").await;
        let a2 = create(&proj, "aaa").await;
        let b1 = create(&proj, "aaa-b").await;
        discard_session_in(&Place::Host, &s(&proj), "aaa")
            .await
            .unwrap();
        assert!(!Path::new(&a1.path).exists());
        assert!(!Path::new(&a2.path).exists());
        assert!(Path::new(&b1.path).exists());
        assert_eq!(worktree_count(&proj), 2);
    }

    #[tokio::test]
    async fn a_folder_outside_a_repo_is_refused() {
        let dir = temp_dir("subtask_norepo");
        let err = create_in(&Place::Host, &s(&dir), "s1").await.unwrap_err();
        assert_eq!(err, format!("{} is not in a git repository.", s(&dir)));
    }

    #[tokio::test]
    async fn bad_ids_are_refused() {
        let (_base, proj) = repo("ids");
        assert!(create_in(&Place::Host, &s(&proj), "../x").await.is_err());
        assert!(create_in(&Place::Host, &s(&proj), "apply").await.is_err());
        assert!(diff_in(&Place::Host, &s(&proj), "--output=x")
            .await
            .is_err());
    }
}
