//! Persistence for Code-mode shell threads, keyed by working directory.
//!
//! The shell tab is otherwise deliberately session-scoped (see the module doc
//! on `stores/shell.svelte.ts`): a PTY dies with the app, so a chat restored
//! without its shell would mislead. Code mode is the exception worth making.
//! A coding session's value is in the conversation — what was decided, what
//! was tried, what failed — and that survives losing the PTY. Losing it to a
//! power cut or a reboot is a real cost to the user.
//!
//! Keyed by cwd rather than by session id because shell ids are positional
//! (`shell-1`, `shell-2`, reset to 1 each launch) and say nothing about which
//! project a tab was working on. The directory is what the user actually means
//! by "my coding session".
//!
//! The whole thread is stored as one JSON blob and rewritten on each turn
//! rather than appended row-by-row. Turns are the unit that matters for
//! recovery, the thread is already length-bounded by `trimThreadIfNeeded`, and
//! a snapshot cannot half-apply the way an interrupted multi-row insert can.

use super::*;
use rusqlite::{params, OptionalExtension};

impl Database {
    /// Upsert the Code-mode thread for `cwd`. Called after every committed
    /// turn: the failure being defended against is a power cut, so anything
    /// that only writes on a clean shutdown would be useless.
    pub fn save_shell_code_session(&self, cwd: &str, thread: &str) -> Result<(), String> {
        let conn = self.conn();
        let now = chrono_now();
        conn.execute(
            "INSERT INTO shell_code_sessions (cwd, thread, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(cwd) DO UPDATE SET
                thread = excluded.thread,
                updated_at = excluded.updated_at",
            params![cwd, thread, now],
        )
        .map_err(|e| format!("Shell session save failed: {}", e))?;
        Ok(())
    }

    /// The stored thread for `cwd`, or `None` when that directory has none.
    pub fn load_shell_code_session(&self, cwd: &str) -> Result<Option<String>, String> {
        let conn = self.conn();
        conn.query_row(
            "SELECT thread FROM shell_code_sessions WHERE cwd = ?1",
            params![cwd],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Shell session load failed: {}", e))
    }

    /// Forget the thread for `cwd` — the "Start fresh" action. Deleting rather
    /// than blanking so a dismissed session does not linger as an empty row
    /// that later reads back as a restorable thread.
    pub fn delete_shell_code_session(&self, cwd: &str) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM shell_code_sessions WHERE cwd = ?1",
            params![cwd],
        )
        .map_err(|e| format!("Shell session delete failed: {}", e))?;
        Ok(())
    }
}
