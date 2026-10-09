//! Persistence for Code-tab sessions, keyed by id.
//!
//! A session is identified by its id, never by its folder: two sessions may
//! work in the same project, and a fork shares its source's root. `root` is
//! fixed at creation and is the session's boundary for its whole life.
//!
//! The thread is one JSON blob (a `CodeSessionSnapshot`, see
//! `src/lib/code/session.ts`) rewritten after every turn, for the same reason
//! as `shell_sessions.rs`: a snapshot cannot half-apply, and the write has to
//! happen per turn because a shutdown hook never runs when the power goes.
//! The snapshot's index-keyed sidecars (steps, stats, stops) have no home in
//! the `messages` table, and nothing queries inside a thread.
//!
//! Rust parses the snapshot in exactly one place, `fork_thread`, and only as
//! far as it needs to cut a prefix: the version, `messages`, and the four
//! index-keyed maps. Everything else is passed through untouched.

use super::*;
use rusqlite::{params, OptionalExtension};
use serde_json::{Map, Value};

/// Must match `CODE_SESSION_VERSION` in `src/lib/code/session.ts`. A fork of
/// a thread written under another version is refused rather than guessed at.
pub const CODE_SESSION_VERSION: u64 = 1;

/// The snapshot fields keyed by message index (as JSON object keys, so
/// stringified integers). A fork keeps only the entries below its cut.
const INDEX_KEYED_MAPS: [&str; 4] = [
    "messageSteps",
    "messageStats",
    "messageStops",
    "messageHistorySent",
];

/// One row of the session sidebar. Never carries the thread: the list is
/// read on every sidebar render and threads can be large.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodeSessionSummary {
    pub id: String,
    pub title: String,
    pub root: String,
    #[ts(type = "number")]
    pub updated_at: i64,
    pub forked_from: Option<String>,
    pub read_only: bool,
    /// The git worktree Haruspex made for this session (a fork), if any.
    pub worktree: Option<String>,
}

/// A full session row.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodeSessionRow {
    pub id: String,
    /// `''` until the first turn names the session.
    pub title: String,
    /// Canonical project folder, fixed for the session's life.
    pub root: String,
    /// JSON `BackendOverride`; `null` means the global backend.
    pub backend: Option<String>,
    /// `null` means the global reasoning effort.
    pub reasoning_effort: Option<String>,
    /// `CodeSessionSnapshot` JSON.
    pub thread: String,
    pub forked_from: Option<String>,
    /// Message index in the source the fork was cut at.
    #[ts(type = "number | null")]
    pub forked_at: Option<i64>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    /// May read and search, not write: a fork that shares its source's folder.
    pub read_only: bool,
    /// The top folder of the git worktree Haruspex made for this session (a
    /// worktree fork). Deleting the session offers to remove it.
    pub worktree: Option<String>,
}

/// A header edit. Each field is three-state: absent leaves the column alone,
/// `null` clears it (back to the global setting), a value sets it. `title`
/// cannot be null (the column is NOT NULL), so it is only two-state.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSessionMetaPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub backend: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub effort: Option<Option<String>>,
}

/// Marks a field that was present in the payload, `null` included, so
/// `#[serde(default)]` alone is what an absent field produces.
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

const ROW_COLUMNS: &str = "id, title, root, backend, reasoning_effort, thread, \
     forked_from, forked_at, created_at, updated_at, read_only, worktree";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CodeSessionRow> {
    Ok(CodeSessionRow {
        id: row.get(0)?,
        title: row.get(1)?,
        root: row.get(2)?,
        backend: row.get(3)?,
        reasoning_effort: row.get(4)?,
        thread: row.get(5)?,
        forked_from: row.get(6)?,
        forked_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        read_only: row.get(10)?,
        worktree: row.get(11)?,
    })
}

/// A random v4 UUID. `ring` is already ours (the secret store); not worth a
/// `uuid` dependency for sixteen bytes.
fn new_session_id() -> Result<String, String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut b = [0u8; 16];
    SystemRandom::new()
        .fill(&mut b)
        .map_err(|_| "Code session id: no randomness available".to_string())?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// The thread a new session starts with: a valid, empty snapshot, so a fork
/// or a load of a session that never ran a turn still parses.
fn empty_thread(now: i64) -> String {
    serde_json::json!({
        "version": CODE_SESSION_VERSION,
        "savedAt": now,
        "messages": [],
        "messageSteps": {},
        "messageStats": {},
        "messageStops": {},
        "messageHistorySent": {}
    })
    .to_string()
}

/// Cut a snapshot to messages `[0, at)`, keeping only the sidecar entries for
/// those indices. Errors on a snapshot of another version, a malformed one,
/// or `at` past the end — a fork the caller asked for at a message that does
/// not exist is a bug upstream, not something to round down silently.
pub fn fork_thread(thread: &str, at: usize) -> Result<String, String> {
    let mut snap: Map<String, Value> = serde_json::from_str(thread)
        .map_err(|e| format!("Code session thread is not a JSON object: {e}"))?;
    match snap.get("version").and_then(Value::as_u64) {
        Some(CODE_SESSION_VERSION) => {}
        other => {
            return Err(format!(
                "Code session thread version {} is not {CODE_SESSION_VERSION}",
                other.map_or_else(|| "missing".to_string(), |v| v.to_string())
            ))
        }
    }
    let messages = snap
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .ok_or("Code session thread has no messages array")?;
    if at > messages.len() {
        return Err(format!(
            "Fork point {at} is past the end of a {}-message thread",
            messages.len()
        ));
    }
    messages.truncate(at);

    for key in INDEX_KEYED_MAPS {
        let kept = match snap.get(key) {
            Some(Value::Object(map)) => map
                .iter()
                .filter(|(k, _)| k.parse::<usize>().is_ok_and(|i| i < at))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            // Absent or null: decode treats both as empty; write it explicitly.
            _ => Map::new(),
        };
        snap.insert(key.to_string(), Value::Object(kept));
    }
    Ok(Value::Object(snap).to_string())
}

/// `"<title> (fork)"`, without a leading space for a session not yet named.
pub fn fork_title(title: &str) -> String {
    if title.is_empty() {
        "(fork)".to_string()
    } else {
        format!("{title} (fork)")
    }
}

impl Database {
    /// Newest first, so the sidebar's most recent session leads its folder.
    pub fn list_code_sessions(&self) -> Result<Vec<CodeSessionSummary>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, root, updated_at, forked_from, read_only, worktree
                 FROM code_sessions ORDER BY updated_at DESC, id",
            )
            .map_err(|e| format!("Code session list failed: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(CodeSessionSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    root: row.get(2)?,
                    updated_at: row.get(3)?,
                    forked_from: row.get(4)?,
                    read_only: row.get(5)?,
                    worktree: row.get(6)?,
                })
            })
            .map_err(|e| format!("Code session list failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Code session list failed: {e}"))
    }

    /// Create an empty session at `root`, which must be an existing directory.
    /// The stored root is canonical, so two spellings of one folder group
    /// together in the sidebar.
    pub fn create_code_session(
        &self,
        root: &str,
        backend: Option<&str>,
        effort: Option<&str>,
    ) -> Result<CodeSessionRow, String> {
        let canonical =
            std::fs::canonicalize(root).map_err(|e| format!("Code session folder {root}: {e}"))?;
        if !canonical.is_dir() {
            return Err(format!("Code session folder {root} is not a directory"));
        }
        let root = canonical
            .to_str()
            .ok_or_else(|| format!("Code session folder {root} is not valid UTF-8"))?;
        let now = chrono_now();
        let row = CodeSessionRow {
            id: new_session_id()?,
            title: String::new(),
            root: root.to_string(),
            backend: backend.map(str::to_string),
            reasoning_effort: effort.map(str::to_string),
            thread: empty_thread(now),
            forked_from: None,
            forked_at: None,
            created_at: now,
            updated_at: now,
            read_only: false,
            worktree: None,
        };
        self.insert_code_session(&row)?;
        Ok(row)
    }

    fn insert_code_session(&self, row: &CodeSessionRow) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            &format!(
                "INSERT INTO code_sessions ({ROW_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
            ),
            params![
                row.id,
                row.title,
                row.root,
                row.backend,
                row.reasoning_effort,
                row.thread,
                row.forked_from,
                row.forked_at,
                row.created_at,
                row.updated_at,
                row.read_only,
                row.worktree
            ],
        )
        .map_err(|e| format!("Code session create failed: {e}"))?;
        Ok(())
    }

    pub fn load_code_session(&self, id: &str) -> Result<CodeSessionRow, String> {
        let conn = self.conn();
        conn.query_row(
            &format!("SELECT {ROW_COLUMNS} FROM code_sessions WHERE id = ?1"),
            params![id],
            read_row,
        )
        .optional()
        .map_err(|e| format!("Code session load failed: {e}"))?
        .ok_or_else(|| format!("Code session {id} not found"))
    }

    /// Write the thread after a turn, and the title when the turn named the
    /// session. Bumps `updated_at`.
    pub fn save_code_session(
        &self,
        id: &str,
        thread: &str,
        title: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn();
        let changed = conn
            .execute(
                "UPDATE code_sessions
                 SET thread = ?2, title = COALESCE(?3, title), updated_at = ?4
                 WHERE id = ?1",
                params![id, thread, title, chrono_now()],
            )
            .map_err(|e| format!("Code session save failed: {e}"))?;
        if changed == 0 {
            return Err(format!("Code session {id} not found"));
        }
        Ok(())
    }

    /// Header edits (rename, per-session model) without rewriting the thread.
    /// Does not bump `updated_at`: renaming an old session should not lift it
    /// to the top of its folder as if it had been worked on.
    pub fn update_code_session_meta(
        &self,
        id: &str,
        patch: &CodeSessionMetaPatch,
    ) -> Result<(), String> {
        let conn = self.conn();
        let changed = conn
            .execute(
                "UPDATE code_sessions SET
                    title = COALESCE(?2, title),
                    backend = CASE WHEN ?3 THEN ?4 ELSE backend END,
                    reasoning_effort = CASE WHEN ?5 THEN ?6 ELSE reasoning_effort END
                 WHERE id = ?1",
                params![
                    id,
                    patch.title,
                    patch.backend.is_some(),
                    patch.backend.clone().flatten(),
                    patch.effort.is_some(),
                    patch.effort.clone().flatten()
                ],
            )
            .map_err(|e| format!("Code session update failed: {e}"))?;
        if changed == 0 {
            return Err(format!("Code session {id} not found"));
        }
        Ok(())
    }

    /// Deleting a session that is already gone is not an error.
    pub fn delete_code_session(&self, id: &str) -> Result<(), String> {
        let conn = self.conn();
        conn.execute("DELETE FROM code_sessions WHERE id = ?1", params![id])
            .map_err(|e| format!("Code session delete failed: {e}"))?;
        Ok(())
    }

    /// A read-only session holding messages `[0, at)` of `id`, in the same
    /// folder, with the same backend and effort. `forked_from` is not a
    /// foreign key: the source may be deleted later and the fork stands on
    /// its own.
    pub fn fork_code_session(&self, id: &str, at: usize) -> Result<CodeSessionRow, String> {
        self.fork_code_session_into(id, at, None)
    }

    /// A fork, as [`Self::fork_code_session`]; with `into` = `(root,
    /// worktree)`, a writable one rooted in the worktree made for it.
    pub fn fork_code_session_into(
        &self,
        id: &str,
        at: usize,
        into: Option<(&str, &str)>,
    ) -> Result<CodeSessionRow, String> {
        let source = self.load_code_session(id)?;
        let now = chrono_now();
        let (root, read_only, worktree) = match into {
            Some((root, worktree)) => (root.to_string(), false, Some(worktree.to_string())),
            None => (source.root, true, None),
        };
        let row = CodeSessionRow {
            id: new_session_id()?,
            title: fork_title(&source.title),
            root,
            backend: source.backend,
            reasoning_effort: source.reasoning_effort,
            thread: fork_thread(&source.thread, at)?,
            forked_from: Some(source.id),
            forked_at: Some(at as i64),
            created_at: now,
            updated_at: now,
            read_only,
            worktree,
        };
        self.insert_code_session(&row)?;
        Ok(row)
    }
}
