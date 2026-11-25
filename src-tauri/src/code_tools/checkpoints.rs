//! File checkpoints for a Code session's turns, so **Rewind to here** can
//! put back what the agent's write and edit tools changed.
//!
//! Before a write tool runs, the files it names are saved as they are, once
//! per turn (`code_checkpoint_before`): the bytes, or that there was no file.
//! After it runs, what each file now holds is noted (`code_checkpoint_after`),
//! as a sha256 or `absent`. A file the turn left as it found it has nothing to
//! put back, so its row is dropped.
//!
//! Rewinding to message `at` takes every turn that began there or later. Each
//! file goes back to what the earliest of those turns found, but only while
//! it still holds what the latest of them left: a file you, another session
//! or a command changed since is not overwritten unless asked by name
//! (`overwrite`). Commands' own changes are never recorded, so they are not
//! undone. Folders, and files over [`MAX_KEPT`], are not kept.
//!
//! The rows live in the database (`code_checkpoints`), so they survive a
//! restart and go when the session is deleted.

use crate::db::{CheckpointBefore, CheckpointRow, Database};
use crate::fs_tools::path::resolve_in_workdir;
use crate::hash_util::hex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Files larger than this are not kept: a model, a video, a build output.
pub const MAX_KEPT: u64 = 16 * 1024 * 1024;

/// What `state_of` says of a missing file.
const ABSENT: &str = "absent";
/// And of a folder.
const FOLDER: &str = "folder";

/// What is at `path` now: the sha256 of a file's bytes, [`ABSENT`] or
/// [`FOLDER`].
pub fn state_of(path: &Path) -> std::io::Result<String> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ABSENT.into()),
        Err(e) => return Err(e),
    };
    if meta.is_dir() {
        return Ok(FOLDER.into());
    }
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn bytes_state(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// The state a saved `before` stands for, when it was kept.
fn before_state(before: &CheckpointBefore) -> Option<String> {
    match before {
        CheckpointBefore::File(bytes) => Some(bytes_state(bytes)),
        CheckpointBefore::Absent => Some(ABSENT.into()),
        _ => None,
    }
}

fn read_before(path: &Path) -> std::io::Result<CheckpointBefore> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(CheckpointBefore::Absent),
        Err(e) => return Err(e),
    };
    if meta.is_dir() {
        return Ok(CheckpointBefore::Folder);
    }
    if meta.len() > MAX_KEPT {
        return Ok(CheckpointBefore::Large);
    }
    Ok(CheckpointBefore::File(std::fs::read(path)?))
}

/// `rel` in `workdir`, as the file tools resolve it. None when it escapes.
fn resolve(workdir: &str, rel: &str) -> Option<PathBuf> {
    resolve_in_workdir(Path::new(workdir), rel.trim()).ok()
}

/// Save the files a write may change, as they are now, unless this turn
/// already has them. A path that can't be resolved or read is skipped: a
/// checkpoint must never stop a write.
pub fn save_before(db: &Database, session: &str, turn_at: i64, workdir: &str, paths: &[String]) {
    for rel in paths {
        let Some(path) = resolve(workdir, rel) else {
            continue;
        };
        let key = path.to_string_lossy();
        if matches!(db.code_checkpoint(session, turn_at, &key), Ok(Some(_))) {
            continue;
        }
        let before = match read_before(&path) {
            Ok(b) => b,
            Err(e) => {
                log::warn!("code checkpoint: could not read {key}: {e}");
                continue;
            }
        };
        if let Err(e) = db.insert_code_checkpoint(session, turn_at, &key, &before, None) {
            log::warn!("code checkpoint: {e}");
        }
    }
}

/// Note what the files hold after a write. A file the turn has no `before`
/// for (a tool that named it only once it had written it) is marked as not
/// kept; one the turn has left as it found it is dropped.
pub fn record_after(db: &Database, session: &str, turn_at: i64, workdir: &str, paths: &[String]) {
    for rel in paths {
        let Some(path) = resolve(workdir, rel) else {
            continue;
        };
        let key = path.to_string_lossy();
        let now = match state_of(&path) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("code checkpoint: could not read {key}: {e}");
                continue;
            }
        };
        let done = match db.code_checkpoint(session, turn_at, &key) {
            Ok(Some(row)) if before_state(&row.before).as_deref() == Some(now.as_str()) => {
                db.delete_code_checkpoint(session, turn_at, &key)
            }
            Ok(Some(_)) => db.set_code_checkpoint_after(session, turn_at, &key, &now),
            Ok(None) => db.insert_code_checkpoint(
                session,
                turn_at,
                &key,
                &CheckpointBefore::Unknown,
                Some(&now),
            ),
            Err(e) => Err(e),
        };
        if let Err(e) = done {
            log::warn!("code checkpoint: {e}");
        }
    }
}

/// One file a rewind would put back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RewindFile {
    /// Absolute: what `overwrite` names.
    pub path: String,
    /// Relative to the session's folder when inside it.
    pub shown: String,
    /// `ready`: will be put back. `changed`: someone changed it after the
    /// agent's last write; put back only when named in `overwrite`. `same`:
    /// already as it was. `cannot`: not kept (`reason` says why).
    pub status: String,
    /// For `cannot`: `folder`, `large`, `unknown` or `outside`; or an error.
    pub reason: Option<String>,
    /// There was no file before: putting it back deletes it.
    pub created: bool,
}

/// A file a rewind left alone, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RewindSkip {
    pub shown: String,
    /// `changed`, `folder`, `large`, `unknown`, `outside`, or an error.
    pub reason: String,
}

/// What `code_checkpoint_rewind` did to the files.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RewindReport {
    pub restored: Vec<String>,
    pub skipped: Vec<RewindSkip>,
}

fn shown(workdir: &str, path: &str) -> String {
    let base = Path::new(workdir)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(workdir));
    Path::new(path)
        .strip_prefix(&base)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string())
}

struct Planned {
    file: RewindFile,
    before: CheckpointBefore,
}

fn plan_rows(rows: Vec<CheckpointRow>, workdir: &str) -> Vec<Planned> {
    // Per path, in the order first touched: the earliest turn's before, the
    // latest turn's after.
    let mut order: Vec<String> = Vec::new();
    let mut first: std::collections::HashMap<String, CheckpointBefore> = Default::default();
    let mut last: std::collections::HashMap<String, Option<String>> = Default::default();
    for row in rows {
        if !first.contains_key(&row.path) {
            order.push(row.path.clone());
            first.insert(row.path.clone(), row.before);
        }
        last.insert(row.path, row.after);
    }
    order
        .into_iter()
        .map(|path| {
            let before = first.remove(&path).unwrap_or(CheckpointBefore::Unknown);
            let expected = last.remove(&path).flatten();
            let (status, reason) = judge(&path, &before, expected.as_deref(), workdir);
            Planned {
                file: RewindFile {
                    shown: shown(workdir, &path),
                    created: before == CheckpointBefore::Absent,
                    path,
                    status: status.into(),
                    reason,
                },
                before,
            }
        })
        .collect()
}

fn judge(
    path: &str,
    before: &CheckpointBefore,
    expected: Option<&str>,
    workdir: &str,
) -> (&'static str, Option<String>) {
    let cannot = |why: &str| ("cannot", Some(why.to_string()));
    let Some(was) = before_state(before) else {
        return cannot(match before {
            CheckpointBefore::Folder => "folder",
            CheckpointBefore::Large => "large",
            _ => "unknown",
        });
    };
    // The session may have been moved to another folder since.
    if resolve(workdir, path).as_deref() != Some(Path::new(path)) {
        return cannot("outside");
    }
    let now = match state_of(Path::new(path)) {
        Ok(s) => s,
        Err(e) => return cannot(&e.to_string()),
    };
    if now == was {
        ("same", None)
    } else if now == FOLDER || expected != Some(now.as_str()) {
        ("changed", None)
    } else {
        ("ready", None)
    }
}

/// What rewinding `session` to message `at` would do to its files.
pub fn plan(
    db: &Database,
    session: &str,
    at: i64,
    workdir: &str,
) -> Result<Vec<RewindFile>, String> {
    let rows = db.code_checkpoints_from(session, at)?;
    Ok(plan_rows(rows, workdir)
        .into_iter()
        .map(|p| p.file)
        .collect())
}

fn put_back(path: &Path, before: &CheckpointBefore) -> std::io::Result<()> {
    match before {
        CheckpointBefore::File(bytes) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, bytes)
        }
        CheckpointBefore::Absent => match std::fs::remove_file(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            r => r,
        },
        _ => Ok(()),
    }
}

/// Rewind `session` to message `at`: with `restore`, put back each file
/// that is `ready`, and each `changed` one named in `overwrite`; then forget
/// the checkpoints of the turns cut.
pub fn rewind(
    db: &Database,
    session: &str,
    at: i64,
    workdir: &str,
    restore: bool,
    overwrite: &[String],
) -> Result<RewindReport, String> {
    let mut report = RewindReport::default();
    if restore {
        let rows = db.code_checkpoints_from(session, at)?;
        for Planned { file, before } in plan_rows(rows, workdir) {
            let go = match file.status.as_str() {
                "ready" => true,
                "changed" => overwrite.contains(&file.path) || overwrite.contains(&file.shown),
                _ => false,
            };
            if go {
                match put_back(Path::new(&file.path), &before) {
                    Ok(()) => report.restored.push(file.shown),
                    Err(e) => report.skipped.push(RewindSkip {
                        shown: file.shown,
                        reason: e.to_string(),
                    }),
                }
            } else if file.status != "same" {
                report.skipped.push(RewindSkip {
                    shown: file.shown,
                    reason: file.reason.unwrap_or_else(|| file.status.clone()),
                });
            }
        }
    }
    db.delete_code_checkpoints_from(session, at)?;
    Ok(report)
}

async fn on_db<T: Send + 'static>(
    app: tauri::AppHandle,
    f: impl FnOnce(&Database) -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<Database>()))
        .await
        .map_err(|e| format!("checkpoint task panicked: {e}"))
}

/// Save the files a write may change, before it runs (see [`save_before`]).
#[tauri::command]
pub async fn code_checkpoint_before(
    app: tauri::AppHandle,
    session_id: String,
    turn_at: i64,
    workdir: String,
    paths: Vec<String>,
) -> Result<(), String> {
    on_db(app, move |db| {
        save_before(db, &session_id, turn_at, &workdir, &paths)
    })
    .await
}

/// Note what the files hold after a write (see [`record_after`]).
#[tauri::command]
pub async fn code_checkpoint_after(
    app: tauri::AppHandle,
    session_id: String,
    turn_at: i64,
    workdir: String,
    paths: Vec<String>,
) -> Result<(), String> {
    on_db(app, move |db| {
        record_after(db, &session_id, turn_at, &workdir, &paths)
    })
    .await
}

/// What rewinding to message `at` would do to the files (see [`plan`]).
#[tauri::command]
pub async fn code_checkpoint_plan(
    app: tauri::AppHandle,
    session_id: String,
    at: i64,
    workdir: String,
) -> Result<Vec<RewindFile>, String> {
    on_db(app, move |db| plan(db, &session_id, at, &workdir)).await?
}

/// Put the files back and forget the cut turns' checkpoints (see [`rewind`]).
#[tauri::command]
pub async fn code_checkpoint_rewind(
    app: tauri::AppHandle,
    session_id: String,
    at: i64,
    workdir: String,
    restore: bool,
    overwrite: Vec<String>,
) -> Result<RewindReport, String> {
    on_db(app, move |db| {
        rewind(db, &session_id, at, &workdir, restore, &overwrite)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        db: Database,
        dir: tempfile::TempDir,
        id: String,
    }

    impl Fixture {
        fn new() -> Self {
            let db = Database::open_in_memory();
            let dir = tempfile::tempdir().unwrap();
            let id = db
                .create_code_session(&dir.path().to_string_lossy(), None, None)
                .unwrap()
                .id;
            Fixture { db, dir, id }
        }
        fn workdir(&self) -> String {
            self.dir.path().to_string_lossy().into_owned()
        }
        fn path(&self, rel: &str) -> PathBuf {
            self.dir.path().join(rel)
        }
        fn write(&self, rel: &str, text: &str) {
            std::fs::write(self.path(rel), text).unwrap();
        }
        fn read(&self, rel: &str) -> Option<String> {
            std::fs::read_to_string(self.path(rel)).ok()
        }
        /// One agent write in turn `turn`: before, the change, after.
        fn agent_write(&self, turn: i64, rel: &str, text: Option<&str>) {
            let paths = vec![rel.to_string()];
            save_before(&self.db, &self.id, turn, &self.workdir(), &paths);
            match text {
                Some(t) => self.write(rel, t),
                None => std::fs::remove_file(self.path(rel)).unwrap(),
            }
            record_after(&self.db, &self.id, turn, &self.workdir(), &paths);
        }
        fn plan(&self, at: i64) -> Vec<(String, String)> {
            plan(&self.db, &self.id, at, &self.workdir())
                .unwrap()
                .into_iter()
                .map(|f| (f.shown, f.status))
                .collect()
        }
        fn rewind(&self, at: i64, overwrite: &[&str]) -> RewindReport {
            let o: Vec<String> = overwrite.iter().map(|s| s.to_string()).collect();
            rewind(&self.db, &self.id, at, &self.workdir(), true, &o).unwrap()
        }
    }

    fn pair(a: &str, b: &str) -> (String, String) {
        (a.into(), b.into())
    }

    #[test]
    fn rewind_puts_back_edits_and_deletes_new_files() {
        let f = Fixture::new();
        f.write("a.txt", "one");
        f.agent_write(0, "a.txt", Some("two"));
        f.agent_write(0, "new.txt", Some("made"));
        assert_eq!(
            f.plan(0),
            vec![pair("a.txt", "ready"), pair("new.txt", "ready")]
        );
        let r = f.rewind(0, &[]);
        assert_eq!(r.restored, vec!["a.txt", "new.txt"]);
        assert!(r.skipped.is_empty());
        assert_eq!(f.read("a.txt").as_deref(), Some("one"));
        assert_eq!(f.read("new.txt"), None);
        assert!(f.plan(0).is_empty(), "the cut turns' checkpoints are gone");
    }

    #[test]
    fn the_first_write_of_a_turn_is_what_comes_back() {
        let f = Fixture::new();
        f.write("a.txt", "one");
        f.agent_write(2, "a.txt", Some("two"));
        f.agent_write(2, "a.txt", Some("three"));
        f.rewind(2, &[]);
        assert_eq!(f.read("a.txt").as_deref(), Some("one"));
    }

    #[test]
    fn only_turns_from_the_cut_on_are_undone() {
        let f = Fixture::new();
        f.write("a.txt", "one");
        f.agent_write(0, "a.txt", Some("two"));
        f.agent_write(4, "a.txt", Some("three"));
        f.agent_write(8, "a.txt", Some("four"));
        let r = f.rewind(4, &[]);
        assert_eq!(r.restored, vec!["a.txt"]);
        assert_eq!(f.read("a.txt").as_deref(), Some("two"));
        // Turn 0 is still there to rewind to.
        assert_eq!(f.plan(0), vec![pair("a.txt", "ready")]);
    }

    #[test]
    fn a_file_changed_after_the_agent_wrote_it_is_left_unless_named() {
        let f = Fixture::new();
        f.write("a.txt", "one");
        f.agent_write(0, "a.txt", Some("two"));
        f.write("a.txt", "yours");
        assert_eq!(f.plan(0), vec![pair("a.txt", "changed")]);
        let r = f.rewind(0, &[]);
        assert!(r.restored.is_empty());
        assert_eq!(
            r.skipped,
            vec![RewindSkip {
                shown: "a.txt".into(),
                reason: "changed".into()
            }]
        );
        assert_eq!(f.read("a.txt").as_deref(), Some("yours"));

        // Asked by name, it goes back.
        f.agent_write(0, "a.txt", Some("again"));
        f.write("a.txt", "yours again");
        let r = f.rewind(0, &["a.txt"]);
        assert_eq!(r.restored, vec!["a.txt"]);
        assert_eq!(f.read("a.txt").as_deref(), Some("yours"));
    }

    #[test]
    fn a_deleted_file_comes_back_and_an_unchanged_one_is_not_listed() {
        let f = Fixture::new();
        f.write("gone.txt", "keep me");
        f.write("same.txt", "x");
        f.agent_write(0, "gone.txt", None);
        f.agent_write(0, "same.txt", Some("x"));
        assert_eq!(f.plan(0), vec![pair("gone.txt", "ready")]);
        f.rewind(0, &[]);
        assert_eq!(f.read("gone.txt").as_deref(), Some("keep me"));
    }

    #[test]
    fn a_file_already_back_as_it_was_is_same() {
        let f = Fixture::new();
        f.write("a.txt", "one");
        f.agent_write(0, "a.txt", Some("two"));
        f.write("a.txt", "one");
        assert_eq!(f.plan(0), vec![pair("a.txt", "same")]);
        assert_eq!(f.rewind(0, &[]), RewindReport::default());
    }

    #[test]
    fn a_write_not_seen_beforehand_cannot_be_put_back() {
        let f = Fixture::new();
        f.write("a.txt", "two");
        record_after(&f.db, &f.id, 0, &f.workdir(), &["a.txt".to_string()]);
        let p = plan(&f.db, &f.id, 0, &f.workdir()).unwrap();
        assert_eq!(p[0].status, "cannot");
        assert_eq!(p[0].reason.as_deref(), Some("unknown"));
        let r = f.rewind(0, &["a.txt"]);
        assert_eq!(r.skipped[0].reason, "unknown");
        assert_eq!(f.read("a.txt").as_deref(), Some("two"));
    }

    #[test]
    fn without_restore_the_files_stay_and_the_checkpoints_go() {
        let f = Fixture::new();
        f.agent_write(0, "new.txt", Some("made"));
        let r = rewind(&f.db, &f.id, 0, &f.workdir(), false, &[]).unwrap();
        assert_eq!(r, RewindReport::default());
        assert_eq!(f.read("new.txt").as_deref(), Some("made"));
        assert!(f.plan(0).is_empty());
    }

    #[test]
    fn checkpoints_go_with_their_session() {
        let f = Fixture::new();
        f.agent_write(0, "new.txt", Some("made"));
        f.db.delete_code_session(&f.id).unwrap();
        assert!(f.db.code_checkpoints_from(&f.id, 0).unwrap().is_empty());
    }

    #[test]
    fn a_path_outside_the_folder_is_not_saved() {
        let f = Fixture::new();
        save_before(
            &f.db,
            &f.id,
            0,
            &f.workdir(),
            &["../escape.txt".to_string()],
        );
        assert!(f.db.code_checkpoints_from(&f.id, 0).unwrap().is_empty());
    }
}
