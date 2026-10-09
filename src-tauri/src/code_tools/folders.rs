//! Code sessions that share a folder: one writer at a time, and a note to the
//! others about what changed.
//!
//! Two sessions may work in one project (a read-only fork, a second session
//! the user opened there), and each may be in a different window — the main
//! window's Code tab or a detached `code-<id>` window, each with its own
//! webview and its own JS state. So both rules live here, where every window
//! can see them.
//!
//! **Writer lease.** A session takes its folder's lease when its turn first
//! writes (a file write or edit, or a command that may change files) and
//! gives it back when the turn ends. While one session holds it, another
//! session whose folder overlaps (the same folder, or one inside the other)
//! is refused. A lease held from a window that no longer exists is stale and
//! counts as free; closing a window drops its leases. Worktrees are separate
//! folders, so sessions in different worktrees never meet here.
//!
//! **Changed-file notices.** At the end of a turn that wrote files, the
//! session records which. Another session in an overlapping folder picks
//! them up at the start of its next turn (`since` is when it last looked),
//! so the model knows those files may not be what it last read. Command side
//! effects can't be known, so only the file tools' writes are recorded.
//! Notices are kept in the database (`code_file_notices`), so a restart
//! loses none: a session's `since` after a restart is the `notices_seen_at`
//! its last saved turn stored. A notice is dropped once every other saved
//! session in an overlapping folder has saved a turn past it, after a day,
//! or past the newest [`NOTICE_CAP`].

use crate::db::{Database, StoredNotice};
use crate::sync_util::LockExt;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

/// Notices older than this are dropped: a session idle for a day gets a
/// fresh look at the files anyway.
const NOTICE_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
/// And never more than this many are kept.
const NOTICE_CAP: usize = 200;

struct Lease {
    folder: PathBuf,
    title: String,
    window: String,
}

#[derive(Default)]
struct Inner {
    /// Session id → the lease it holds.
    leases: HashMap<String, Lease>,
    /// The last notice time handed out, so times strictly increase. Also
    /// kept past the stored notices, which may have been dropped.
    clock: i64,
}

/// Managed state for both rules.
#[derive(Default)]
pub struct CodeFolders {
    inner: Mutex<Inner>,
}

/// One session's changes, as another session hears of them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct FileNotice {
    pub session_id: String,
    pub title: String,
    /// Absolute paths.
    pub files: Vec<String>,
    #[ts(type = "number")]
    pub at: i64,
}

/// What `code_notices_take` returns: the notices, and the time to pass as
/// `since` next time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct FileNotices {
    pub notices: Vec<FileNotice>,
    #[ts(type = "number")]
    pub now: i64,
}

/// The same folder, or one inside the other.
fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

impl Inner {
    fn tick(&mut self, now: i64) -> i64 {
        self.clock = now.max(self.clock + 1);
        self.clock
    }
}

impl CodeFolders {
    /// Take `folder`'s lease for `session`. `Err` carries the title of the
    /// session that holds it (`""` when that one has no title yet).
    pub fn take(
        &self,
        folder: &Path,
        session: &str,
        title: &str,
        window: &str,
        alive: impl Fn(&str) -> bool,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock_or_recover();
        inner.leases.retain(|_, l| alive(&l.window));
        if let Some(holder) = inner
            .leases
            .iter()
            .find(|(id, l)| id.as_str() != session && overlaps(&l.folder, folder))
        {
            return Err(holder.1.title.clone());
        }
        inner.leases.insert(
            session.to_string(),
            Lease {
                folder: folder.to_path_buf(),
                title: title.to_string(),
                window: window.to_string(),
            },
        );
        Ok(())
    }

    /// Give back `session`'s lease, if it holds one.
    pub fn release(&self, session: &str) {
        self.inner.lock_or_recover().leases.remove(session);
    }

    /// Drop every lease a closed window held.
    pub fn release_window(&self, label: &str) {
        self.inner
            .lock_or_recover()
            .leases
            .retain(|_, l| l.window != label);
    }

    /// Record that `session`'s turn changed `files` in `folder`.
    pub fn record(
        &self,
        db: &Database,
        folder: &Path,
        session: &str,
        title: &str,
        files: Vec<String>,
        now: i64,
    ) -> Result<(), String> {
        if files.is_empty() {
            return Ok(());
        }
        // Held across the write, so a take can't slip between the time and
        // the row.
        let mut inner = self.inner.lock_or_recover();
        let stored = db.code_notices()?;
        // Later than any stored notice too: the clock starts again at zero
        // with the app.
        let floor = stored.iter().map(|n| n.at.saturating_add(1)).max();
        let at = inner.tick(floor.map_or(now, |f| now.max(f)));
        db.insert_code_notice(&folder.to_string_lossy(), session, title, &files, at)?;
        prune(db, now)
    }

    /// Other sessions' changes in folders overlapping `folder` since `since`.
    pub fn take_notices(
        &self,
        db: &Database,
        folder: &Path,
        session: &str,
        since: i64,
        now: i64,
    ) -> Result<FileNotices, String> {
        let mut inner = self.inner.lock_or_recover();
        let stored = db.code_notices()?;
        let notices = stored
            .iter()
            .filter(|n| {
                n.at > since && n.session_id != session && overlaps(Path::new(&n.folder), folder)
            })
            .map(file_notice)
            .collect();
        // Past every notice recorded so far, so none is delivered twice; and
        // the clock moves with it, so the next one recorded is later still.
        let newest = stored.iter().map(|n| n.at).max().unwrap_or(i64::MIN);
        inner.clock = now.max(inner.clock).max(newest);
        let now_out = inner.clock;
        drop(inner);
        prune(db, now)?;
        Ok(FileNotices {
            notices,
            now: now_out,
        })
    }

    #[cfg(test)]
    fn holder(&self, session: &str) -> Option<String> {
        self.inner
            .lock_or_recover()
            .leases
            .get(session)
            .map(|l| l.folder.to_string_lossy().into_owned())
    }
}

fn file_notice(n: &StoredNotice) -> FileNotice {
    FileNotice {
        session_id: n.session_id.clone(),
        title: n.title.clone(),
        files: n.files.clone(),
        at: n.at,
    }
}

/// Drop the notices nobody needs any more: those every other saved session
/// in an overlapping folder has heard (its saved `notices_seen_at` is past
/// them; a deleted session no longer counts), those older than a day, and
/// all but the newest [`NOTICE_CAP`].
fn prune(db: &Database, now: i64) -> Result<(), String> {
    let stored = db.code_notices()?;
    if stored.is_empty() {
        return Ok(());
    }
    let marks = db.code_session_seen_marks()?;
    let keep_from = stored.len().saturating_sub(NOTICE_CAP);
    let done: Vec<i64> = stored
        .iter()
        .enumerate()
        .filter(|(i, n)| {
            let folder = Path::new(&n.folder);
            let heard = marks
                .iter()
                .filter(|m| m.id != n.session_id && overlaps(Path::new(&m.root), folder))
                .all(|m| m.seen >= n.at);
            *i < keep_from || now - n.at >= NOTICE_MAX_AGE_MS || heard
        })
        .map(|(_, n)| n.id)
        .collect();
    db.delete_code_notices(&done)
}

/// The folder as the lease map keys it: canonical when it exists.
fn key(folder: &str) -> PathBuf {
    std::fs::canonicalize(folder).unwrap_or_else(|_| PathBuf::from(folder))
}

/// Take the writer lease on `folder` for `session_id`. Returns `None` when
/// it is ours, else the title of the session that is writing there.
#[tauri::command]
pub fn code_lease_take(
    window: tauri::Window,
    state: tauri::State<'_, CodeFolders>,
    folder: String,
    session_id: String,
    title: String,
) -> Option<String> {
    let app = window.app_handle();
    state
        .take(
            &key(&folder),
            &session_id,
            &title,
            window.label(),
            |label| app.get_webview_window(label).is_some(),
        )
        .err()
}

#[tauri::command]
pub fn code_lease_release(state: tauri::State<'_, CodeFolders>, session_id: String) {
    state.release(&session_id);
}

/// Record the files a turn wrote, for other sessions in the folder.
#[tauri::command]
pub async fn code_notice_record(
    app: tauri::AppHandle,
    folder: String,
    session_id: String,
    title: String,
    files: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        app.state::<CodeFolders>().record(
            &db,
            &key(&folder),
            &session_id,
            &title,
            files,
            crate::time_util::now_ms(),
        )
    })
    .await
    .map_err(|e| format!("notice task panicked: {e}"))?
}

/// Other sessions' changes in the folder since `since` (ms; 0 for all).
#[tauri::command]
pub async fn code_notices_take(
    app: tauri::AppHandle,
    folder: String,
    session_id: String,
    since: i64,
) -> Result<FileNotices, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        app.state::<CodeFolders>().take_notices(
            &db,
            &key(&folder),
            &session_id,
            since,
            crate::time_util::now_ms(),
        )
    })
    .await
    .map_err(|e| format!("notice task panicked: {e}"))?
}

/// Whether a session's folder is still there (a folder, not a file).
#[tauri::command]
pub async fn code_folder_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || Path::new(&path).is_dir())
        .await
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alive(_: &str) -> bool {
        true
    }

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn one_writer_per_folder() {
        let f = CodeFolders::default();
        assert_eq!(f.take(&p("/repo"), "a", "Alpha", "main", alive), Ok(()));
        // Taking it again is fine; another session is told who has it.
        assert_eq!(f.take(&p("/repo"), "a", "Alpha", "main", alive), Ok(()));
        assert_eq!(
            f.take(&p("/repo"), "b", "Beta", "code-b", alive),
            Err("Alpha".to_string())
        );
        // A folder inside it, or around it, overlaps too.
        assert!(f.take(&p("/repo/sub"), "b", "Beta", "main", alive).is_err());
        assert!(f.take(&p("/"), "b", "Beta", "main", alive).is_err());
        // A sibling (a worktree beside the repo) does not.
        assert_eq!(
            f.take(&p("/repo-worktrees/x"), "b", "Beta", "main", alive),
            Ok(())
        );
        // A prefix that isn't a parent folder doesn't overlap either.
        assert_eq!(f.take(&p("/repository"), "c", "", "main", alive), Ok(()));
    }

    #[test]
    fn release_frees_the_folder() {
        let f = CodeFolders::default();
        f.take(&p("/repo"), "a", "Alpha", "main", alive).unwrap();
        f.release("a");
        assert_eq!(f.holder("a"), None);
        assert_eq!(f.take(&p("/repo"), "b", "Beta", "main", alive), Ok(()));
    }

    #[test]
    fn a_lease_whose_window_is_gone_is_stale() {
        let f = CodeFolders::default();
        f.take(&p("/repo"), "a", "Alpha", "code-a", alive).unwrap();
        assert_eq!(
            f.take(&p("/repo"), "b", "Beta", "main", |l| l != "code-a"),
            Ok(())
        );
        assert_eq!(f.holder("a"), None);
    }

    #[test]
    fn closing_a_window_drops_its_leases() {
        let f = CodeFolders::default();
        f.take(&p("/one"), "a", "", "code-a", alive).unwrap();
        f.take(&p("/two"), "b", "", "main", alive).unwrap();
        f.release_window("code-a");
        assert_eq!(f.holder("a"), None);
        assert!(f.holder("b").is_some());
    }

    /// A database holding sessions `(id, root)` that have heard nothing yet.
    fn db_with(sessions: &[(&str, &str)]) -> Database {
        let db = Database::open_in_memory();
        for (id, root) in sessions {
            db.insert_test_code_session(id, root, 0);
        }
        db
    }

    fn files(n: &FileNotices) -> Vec<Vec<String>> {
        n.notices.iter().map(|n| n.files.clone()).collect()
    }

    #[test]
    fn notices_reach_other_sessions_in_the_folder_once() {
        let f = CodeFolders::default();
        let db = db_with(&[("a", "/repo"), ("b", "/repo/sub"), ("c", "/elsewhere")]);
        let start = f.take_notices(&db, &p("/repo"), "b", 0, 1000).unwrap().now;
        f.record(
            &db,
            &p("/repo"),
            "a",
            "Alpha",
            vec!["/repo/a.ts".into()],
            1000,
        )
        .unwrap();
        f.record(
            &db,
            &p("/elsewhere"),
            "c",
            "Gamma",
            vec!["/elsewhere/c.ts".into()],
            1001,
        )
        .unwrap();
        // Not to the session that made them.
        assert!(f
            .take_notices(&db, &p("/repo"), "a", start, 1002)
            .unwrap()
            .notices
            .is_empty());
        let got = f
            .take_notices(&db, &p("/repo/sub"), "b", start, 1002)
            .unwrap();
        assert_eq!(got.notices.len(), 1);
        assert_eq!(got.notices[0].title, "Alpha");
        assert_eq!(got.notices[0].files, vec!["/repo/a.ts".to_string()]);
        // Delivered: the next look, from `now`, finds nothing.
        assert!(f
            .take_notices(&db, &p("/repo"), "b", got.now, 1003)
            .unwrap()
            .notices
            .is_empty());
    }

    #[test]
    fn a_notice_in_the_same_millisecond_is_not_lost() {
        let f = CodeFolders::default();
        let db = db_with(&[("a", "/repo"), ("b", "/repo")]);
        f.record(&db, &p("/repo"), "a", "", vec!["x".into()], 500)
            .unwrap();
        let first = f.take_notices(&db, &p("/repo"), "b", 0, 500).unwrap();
        assert_eq!(first.notices.len(), 1);
        // Recorded "at" the same wall time, after the look: still delivered.
        f.record(&db, &p("/repo"), "a", "", vec!["y".into()], 500)
            .unwrap();
        let second = f
            .take_notices(&db, &p("/repo"), "b", first.now, 500)
            .unwrap();
        assert_eq!(files(&second), vec![vec!["y".to_string()]]);
    }

    #[test]
    fn old_notices_are_dropped() {
        let f = CodeFolders::default();
        let db = db_with(&[("a", "/repo"), ("b", "/repo")]);
        f.record(&db, &p("/repo"), "a", "", vec!["x".into()], 0)
            .unwrap();
        f.record(
            &db,
            &p("/repo"),
            "a",
            "",
            vec!["y".into()],
            NOTICE_MAX_AGE_MS + 1,
        )
        .unwrap();
        let got = f
            .take_notices(&db, &p("/repo"), "b", -1, NOTICE_MAX_AGE_MS + 2)
            .unwrap();
        assert_eq!(files(&got), vec![vec!["y".to_string()]]);
    }

    #[test]
    fn notices_survive_a_restart() {
        let db = db_with(&[("a", "/repo"), ("b", "/repo")]);
        let before = CodeFolders::default();
        before
            .record(
                &db,
                &p("/repo"),
                "a",
                "Alpha",
                vec!["/repo/a.ts".into()],
                1000,
            )
            .unwrap();
        // A new app: the lease map and the clock start empty, the rows don't.
        let after = CodeFolders::default();
        let got = after.take_notices(&db, &p("/repo"), "b", 0, 10).unwrap();
        assert_eq!(files(&got), vec![vec!["/repo/a.ts".to_string()]]);
        // The clock picks up past the stored notice, even with the wall
        // clock behind it, so nothing taken is handed out again.
        assert!(got.now >= 1000);
        after
            .record(&db, &p("/repo"), "a", "", vec!["later".into()], 10)
            .unwrap();
        let next = after
            .take_notices(&db, &p("/repo"), "b", got.now, 11)
            .unwrap();
        assert_eq!(files(&next), vec![vec!["later".to_string()]]);
    }

    #[test]
    fn a_notice_is_dropped_once_every_session_it_is_news_to_has_heard_it() {
        let f = CodeFolders::default();
        let db = db_with(&[("a", "/repo"), ("b", "/repo"), ("c", "/repo/sub")]);
        f.record(&db, &p("/repo"), "a", "", vec!["x".into()], 1000)
            .unwrap();
        let stored = || db.code_notices().unwrap().len();
        assert_eq!(stored(), 1);
        // b takes it and saves its turn; c has not yet.
        let b = f.take_notices(&db, &p("/repo"), "b", 0, 1001).unwrap();
        db.set_code_session_seen("b", Some(b.now), None).unwrap();
        f.take_notices(&db, &p("/repo"), "b", b.now, 1002).unwrap();
        assert_eq!(stored(), 1);
        let c = f.take_notices(&db, &p("/repo/sub"), "c", 0, 1003).unwrap();
        assert_eq!(c.notices.len(), 1);
        db.set_code_session_seen("c", Some(c.now), None).unwrap();
        f.take_notices(&db, &p("/repo"), "b", b.now, 1004).unwrap();
        assert_eq!(stored(), 0);
    }

    #[test]
    fn a_notice_nobody_else_can_hear_is_not_kept() {
        let f = CodeFolders::default();
        let db = db_with(&[("a", "/repo"), ("z", "/other")]);
        f.record(&db, &p("/repo"), "a", "", vec!["x".into()], 1000)
            .unwrap();
        assert!(db.code_notices().unwrap().is_empty());
    }

    #[test]
    fn at_most_the_newest_notices_are_kept() {
        let f = CodeFolders::default();
        let db = db_with(&[("a", "/repo"), ("b", "/repo")]);
        for i in 0..(NOTICE_CAP as i64 + 5) {
            f.record(&db, &p("/repo"), "a", "", vec![format!("f{i}")], 1000 + i)
                .unwrap();
        }
        let stored = db.code_notices().unwrap();
        assert_eq!(stored.len(), NOTICE_CAP);
        assert_eq!(stored[0].files, vec!["f5".to_string()]);
    }
}
