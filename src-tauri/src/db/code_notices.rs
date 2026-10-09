//! Storage for Code sessions' changed-file notices (`code_file_notices`).
//!
//! The rules (who hears of what, and when a notice is done with) are
//! `code_tools/folders.rs`'s; this only reads and writes rows, so the notices
//! survive a restart.

use super::*;
use rusqlite::params;

/// One stored notice: `session_id`'s turn changed `files` in `folder`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredNotice {
    pub id: i64,
    pub folder: String,
    pub session_id: String,
    pub title: String,
    pub files: Vec<String>,
    pub at: i64,
}

/// How far a saved session has heard: its folder, and the notice time it
/// has been told up to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeenMark {
    pub id: String,
    pub root: String,
    pub seen: i64,
}

impl Database {
    pub fn insert_code_notice(
        &self,
        folder: &str,
        session_id: &str,
        title: &str,
        files: &[String],
        at: i64,
    ) -> Result<(), String> {
        let files = serde_json::to_string(files).map_err(|e| e.to_string())?;
        self.conn()
            .execute(
                "INSERT INTO code_file_notices (folder, session_id, title, files, at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![folder, session_id, title, files, at],
            )
            .map_err(|e| format!("Saving a file notice failed: {e}"))?;
        Ok(())
    }

    /// Every stored notice, oldest first. There are never many (see the cap
    /// in `code_tools/folders.rs`).
    pub fn code_notices(&self) -> Result<Vec<StoredNotice>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, folder, session_id, title, files, at
                 FROM code_file_notices ORDER BY at, id",
            )
            .map_err(|e| format!("Reading file notices failed: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let files: String = row.get(4)?;
                Ok(StoredNotice {
                    id: row.get(0)?,
                    folder: row.get(1)?,
                    session_id: row.get(2)?,
                    title: row.get(3)?,
                    // A row that no longer parses names no files rather than
                    // failing every read.
                    files: serde_json::from_str(&files).unwrap_or_default(),
                    at: row.get(5)?,
                })
            })
            .map_err(|e| format!("Reading file notices failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Reading file notices failed: {e}"))
    }

    pub fn delete_code_notices(&self, ids: &[i64]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn();
        let mut stmt = conn
            .prepare("DELETE FROM code_file_notices WHERE id = ?1")
            .map_err(|e| format!("Dropping file notices failed: {e}"))?;
        for id in ids {
            stmt.execute(params![id])
                .map_err(|e| format!("Dropping file notices failed: {e}"))?;
        }
        Ok(())
    }

    /// Each saved session's folder and how far it has heard (its
    /// `notices_seen_at`, or its last saved turn before that was kept).
    pub fn code_session_seen_marks(&self) -> Result<Vec<SeenMark>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT id, root, COALESCE(notices_seen_at, updated_at) FROM code_sessions")
            .map_err(|e| format!("Reading sessions failed: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SeenMark {
                    id: row.get(0)?,
                    root: row.get(1)?,
                    seen: row.get(2)?,
                })
            })
            .map_err(|e| format!("Reading sessions failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Reading sessions failed: {e}"))
    }

    /// A bare session row at `root` that has heard notices up to `seen`,
    /// for other modules' tests (their roots needn't exist).
    #[cfg(test)]
    pub fn insert_test_code_session(&self, id: &str, root: &str, seen: i64) {
        self.conn()
            .execute(
                "INSERT INTO code_sessions
                    (id, title, root, thread, created_at, updated_at, notices_seen_at)
                 VALUES (?1, '', ?2, '{}', 0, 0, ?3)",
                params![id, root, seen],
            )
            .unwrap();
    }
}
