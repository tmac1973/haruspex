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

struct Notice {
    folder: PathBuf,
    session: String,
    title: String,
    files: Vec<String>,
    at: i64,
}

#[derive(Default)]
struct Inner {
    /// Session id → the lease it holds.
    leases: HashMap<String, Lease>,
    notices: Vec<Notice>,
    /// The last notice time handed out, so times strictly increase.
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
    pub fn record(&self, folder: &Path, session: &str, title: &str, files: Vec<String>, now: i64) {
        if files.is_empty() {
            return;
        }
        let mut inner = self.inner.lock_or_recover();
        let at = inner.tick(now);
        inner.notices.retain(|n| at - n.at < NOTICE_MAX_AGE_MS);
        inner.notices.push(Notice {
            folder: folder.to_path_buf(),
            session: session.to_string(),
            title: title.to_string(),
            files,
            at,
        });
        let excess = inner.notices.len().saturating_sub(NOTICE_CAP);
        inner.notices.drain(..excess);
    }

    /// Other sessions' changes in folders overlapping `folder` since `since`.
    pub fn take_notices(&self, folder: &Path, session: &str, since: i64, now: i64) -> FileNotices {
        let mut inner = self.inner.lock_or_recover();
        let notices = inner
            .notices
            .iter()
            .filter(|n| n.at > since && n.session != session && overlaps(&n.folder, folder))
            .map(|n| FileNotice {
                session_id: n.session.clone(),
                title: n.title.clone(),
                files: n.files.clone(),
                at: n.at,
            })
            .collect();
        // Past every notice recorded so far, so none is delivered twice; and
        // the clock moves with it, so the next one recorded is later still.
        inner.clock = now.max(inner.clock);
        FileNotices {
            notices,
            now: inner.clock,
        }
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
pub fn code_notice_record(
    state: tauri::State<'_, CodeFolders>,
    folder: String,
    session_id: String,
    title: String,
    files: Vec<String>,
) {
    state.record(
        &key(&folder),
        &session_id,
        &title,
        files,
        crate::time_util::now_ms(),
    );
}

/// Other sessions' changes in the folder since `since` (ms; 0 for all).
#[tauri::command]
pub fn code_notices_take(
    state: tauri::State<'_, CodeFolders>,
    folder: String,
    session_id: String,
    since: i64,
) -> FileNotices {
    state.take_notices(
        &key(&folder),
        &session_id,
        since,
        crate::time_util::now_ms(),
    )
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

    #[test]
    fn notices_reach_other_sessions_in_the_folder_once() {
        let f = CodeFolders::default();
        let start = f.take_notices(&p("/repo"), "b", 0, 1000).now;
        f.record(&p("/repo"), "a", "Alpha", vec!["/repo/a.ts".into()], 1000);
        f.record(
            &p("/elsewhere"),
            "c",
            "Gamma",
            vec!["/elsewhere/c.ts".into()],
            1001,
        );
        // Not to the session that made them.
        assert!(f
            .take_notices(&p("/repo"), "a", start, 1002)
            .notices
            .is_empty());
        let got = f.take_notices(&p("/repo/sub"), "b", start, 1002);
        assert_eq!(got.notices.len(), 1);
        assert_eq!(got.notices[0].title, "Alpha");
        assert_eq!(got.notices[0].files, vec!["/repo/a.ts".to_string()]);
        // Delivered: the next look, from `now`, finds nothing.
        assert!(f
            .take_notices(&p("/repo"), "b", got.now, 1003)
            .notices
            .is_empty());
    }

    #[test]
    fn a_notice_in_the_same_millisecond_is_not_lost() {
        let f = CodeFolders::default();
        f.record(&p("/repo"), "a", "", vec!["x".into()], 500);
        let first = f.take_notices(&p("/repo"), "b", 0, 500);
        assert_eq!(first.notices.len(), 1);
        // Recorded "at" the same wall time, after the look: still delivered.
        f.record(&p("/repo"), "a", "", vec!["y".into()], 500);
        let second = f.take_notices(&p("/repo"), "b", first.now, 500);
        assert_eq!(second.notices.len(), 1);
        assert_eq!(second.notices[0].files, vec!["y".to_string()]);
    }

    #[test]
    fn old_notices_are_dropped() {
        let f = CodeFolders::default();
        f.record(&p("/repo"), "a", "", vec!["x".into()], 0);
        f.record(
            &p("/repo"),
            "a",
            "",
            vec!["y".into()],
            NOTICE_MAX_AGE_MS + 1,
        );
        let got = f.take_notices(&p("/repo"), "b", -1, NOTICE_MAX_AGE_MS + 2);
        assert_eq!(got.notices.len(), 1);
    }
}
