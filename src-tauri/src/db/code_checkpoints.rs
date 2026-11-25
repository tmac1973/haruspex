//! Storage for Code sessions' file checkpoints (`code_checkpoints`).
//!
//! What a file held before a turn's write or edit first touched it, and what
//! the turn's last write left there. The rules (what is saved, when a file
//! may be put back) are `code_tools/checkpoints.rs`'s; this only reads and
//! writes rows. Rows go with their session (`ON DELETE CASCADE`).

use super::*;
use rusqlite::{params, OptionalExtension};

/// What a file was before the turn touched it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckpointBefore {
    /// Its bytes.
    File(Vec<u8>),
    /// There was no file there.
    Absent,
    /// A folder: not kept.
    Folder,
    /// Too large to keep.
    Large,
    /// Not seen before the write (a tool that names no path up front).
    Unknown,
}

impl CheckpointBefore {
    fn kind(&self) -> &'static str {
        match self {
            CheckpointBefore::File(_) => "file",
            CheckpointBefore::Absent => "absent",
            CheckpointBefore::Folder => "folder",
            CheckpointBefore::Large => "large",
            CheckpointBefore::Unknown => "unknown",
        }
    }

    fn from_row(kind: &str, content: Option<Vec<u8>>) -> Self {
        match (kind, content) {
            ("file", Some(bytes)) => CheckpointBefore::File(bytes),
            ("absent", _) => CheckpointBefore::Absent,
            ("folder", _) => CheckpointBefore::Folder,
            ("large", _) => CheckpointBefore::Large,
            _ => CheckpointBefore::Unknown,
        }
    }
}

/// One file in one turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointRow {
    /// How many messages the thread held when the turn began.
    pub turn_at: i64,
    /// Absolute.
    pub path: String,
    pub before: CheckpointBefore,
    /// What the turn's last write left (`code_tools::checkpoints::state_of`);
    /// None until a write has finished.
    pub after: Option<String>,
}

impl Database {
    /// Save `before` for the turn's file, unless the turn already has it:
    /// the first write of a turn is the one that counts.
    pub fn insert_code_checkpoint(
        &self,
        session_id: &str,
        turn_at: i64,
        path: &str,
        before: &CheckpointBefore,
        after: Option<&str>,
    ) -> Result<(), String> {
        let content = match before {
            CheckpointBefore::File(bytes) => Some(bytes.as_slice()),
            _ => None,
        };
        self.conn()
            .execute(
                "INSERT OR IGNORE INTO code_checkpoints
                     (session_id, turn_at, path, before_kind, before, after)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![session_id, turn_at, path, before.kind(), content, after],
            )
            .map_err(|e| format!("Saving a file checkpoint failed: {e}"))?;
        Ok(())
    }

    /// The turn's row for `path`, if it has one.
    pub fn code_checkpoint(
        &self,
        session_id: &str,
        turn_at: i64,
        path: &str,
    ) -> Result<Option<CheckpointRow>, String> {
        self.conn()
            .query_row(
                "SELECT turn_at, path, before_kind, before, after FROM code_checkpoints
                 WHERE session_id = ?1 AND turn_at = ?2 AND path = ?3",
                params![session_id, turn_at, path],
                read_row,
            )
            .optional()
            .map_err(|e| format!("Reading file checkpoints failed: {e}"))
    }

    pub fn set_code_checkpoint_after(
        &self,
        session_id: &str,
        turn_at: i64,
        path: &str,
        after: &str,
    ) -> Result<(), String> {
        self.conn()
            .execute(
                "UPDATE code_checkpoints SET after = ?4
                 WHERE session_id = ?1 AND turn_at = ?2 AND path = ?3",
                params![session_id, turn_at, path, after],
            )
            .map_err(|e| format!("Saving a file checkpoint failed: {e}"))?;
        Ok(())
    }

    pub fn delete_code_checkpoint(
        &self,
        session_id: &str,
        turn_at: i64,
        path: &str,
    ) -> Result<(), String> {
        self.conn()
            .execute(
                "DELETE FROM code_checkpoints
                 WHERE session_id = ?1 AND turn_at = ?2 AND path = ?3",
                params![session_id, turn_at, path],
            )
            .map_err(|e| format!("Dropping a file checkpoint failed: {e}"))?;
        Ok(())
    }

    /// The session's checkpoints from turns that began at message `at` or
    /// later, oldest turn first.
    pub fn code_checkpoints_from(
        &self,
        session_id: &str,
        at: i64,
    ) -> Result<Vec<CheckpointRow>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT turn_at, path, before_kind, before, after FROM code_checkpoints
                 WHERE session_id = ?1 AND turn_at >= ?2 ORDER BY turn_at, path",
            )
            .map_err(|e| format!("Reading file checkpoints failed: {e}"))?;
        let rows = stmt
            .query_map(params![session_id, at], read_row)
            .map_err(|e| format!("Reading file checkpoints failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Reading file checkpoints failed: {e}"))
    }

    /// Forget the checkpoints of turns from message `at` on.
    pub fn delete_code_checkpoints_from(&self, session_id: &str, at: i64) -> Result<(), String> {
        self.conn()
            .execute(
                "DELETE FROM code_checkpoints WHERE session_id = ?1 AND turn_at >= ?2",
                params![session_id, at],
            )
            .map_err(|e| format!("Dropping file checkpoints failed: {e}"))?;
        Ok(())
    }
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CheckpointRow> {
    let kind: String = row.get(2)?;
    Ok(CheckpointRow {
        turn_at: row.get(0)?,
        path: row.get(1)?,
        before: CheckpointBefore::from_row(&kind, row.get(3)?),
        after: row.get(4)?,
    })
}
