//! Cached-audio persistence: the `audio` rows (content-addressed bytes plus
//! what they are) and the two link tables that decide when the bytes may go.
//!
//! SQL only, like `db/images.rs`; the files are `crate::audio_cache`'s job.
//!
//! Audio differs from images in what a link means. A generated song is the
//! user's work rather than a copy of something on the web, so linked audio is
//! never evicted to make room: only unlinked audio is (see
//! [`Database::audio_to_evict`]). A link comes from a chat
//! (`conversation_audio`) or a Code session (`code_session_audio`), and
//! deleting either cascades the link away, after which the sweep frees the
//! bytes.

use super::*;
use rusqlite::params;

const AUDIO_COLUMNS: &str =
    "hash, mime, bytes, duration_ms, title, source, created_at, last_used_at";

/// The `WHERE` clause that picks audio neither a chat nor a Code session
/// points at.
const UNLINKED: &str =
    "NOT EXISTS (SELECT 1 FROM conversation_audio ca WHERE ca.audio_hash = a.hash)
     AND NOT EXISTS (SELECT 1 FROM code_session_audio sa WHERE sa.audio_hash = a.hash)";

/// One cached audio file.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct AudioRow {
    pub hash: String,
    pub mime: String,
    #[ts(type = "number")]
    pub bytes: i64,
    #[ts(type = "number | null")]
    pub duration_ms: Option<i64>,
    pub title: Option<String>,
    pub source: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub last_used_at: i64,
}

fn read_audio(row: &rusqlite::Row<'_>) -> rusqlite::Result<AudioRow> {
    Ok(AudioRow {
        hash: row.get(0)?,
        mime: row.get(1)?,
        bytes: row.get(2)?,
        duration_ms: row.get(3)?,
        title: row.get(4)?,
        source: row.get(5)?,
        created_at: row.get(6)?,
        last_used_at: row.get(7)?,
    })
}

fn strings(
    stmt: &mut rusqlite::Statement<'_>,
    args: impl rusqlite::Params,
) -> Result<Vec<String>, String> {
    let rows = stmt
        .query_map(args, |r| r.get::<_, String>(0))
        .map_err(|e| format!("Failed to scan audio: {}", e))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("Failed to read audio row: {}", e))
}

impl Database {
    /// Insert an audio row. `OR IGNORE`: the same bytes again keep the first
    /// row, and the caller touches it instead.
    pub fn insert_audio(&self, audio: &AudioRow) -> Result<(), String> {
        let now = chrono_now();
        self.conn()
            .execute(
                "INSERT OR IGNORE INTO audio
                    (hash, mime, bytes, duration_ms, title, source, created_at, last_used_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    audio.hash,
                    audio.mime,
                    audio.bytes,
                    audio.duration_ms,
                    audio.title,
                    audio.source,
                    now,
                ],
            )
            .map_err(|e| format!("Failed to insert audio: {}", e))?;
        Ok(())
    }

    pub fn audio_by_hash(&self, hash: &str) -> Result<Option<AudioRow>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {AUDIO_COLUMNS} FROM audio WHERE hash = ?1"
            ))
            .map_err(|e| format!("Failed to prepare audio lookup: {}", e))?;
        let mut rows = stmt
            .query_map(params![hash], read_audio)
            .map_err(|e| format!("Failed to query audio: {}", e))?;
        match rows.next() {
            Some(row) => Ok(Some(
                row.map_err(|e| format!("Failed to read audio: {}", e))?,
            )),
            None => Ok(None),
        }
    }

    /// Record that a chat shows this audio. Idempotent.
    pub fn link_audio_to_conversation(
        &self,
        conversation_id: &str,
        hash: &str,
    ) -> Result<(), String> {
        self.conn()
            .execute(
                "INSERT OR IGNORE INTO conversation_audio (conversation_id, audio_hash)
                 VALUES (?1, ?2)",
                params![conversation_id, hash],
            )
            .map_err(|e| format!("Failed to link audio: {}", e))?;
        Ok(())
    }

    /// Record that a Code session made this audio. Idempotent.
    pub fn link_audio_to_code_session(&self, session_id: &str, hash: &str) -> Result<(), String> {
        self.conn()
            .execute(
                "INSERT OR IGNORE INTO code_session_audio (code_session_id, audio_hash)
                 VALUES (?1, ?2)",
                params![session_id, hash],
            )
            .map_err(|e| format!("Failed to link audio: {}", e))?;
        Ok(())
    }

    /// Mark audio as played now.
    pub fn touch_audio(&self, hash: &str) -> Result<(), String> {
        self.conn()
            .execute(
                "UPDATE audio SET last_used_at = ?1 WHERE hash = ?2",
                params![chrono_now(), hash],
            )
            .map_err(|e| format!("Failed to touch audio: {}", e))?;
        Ok(())
    }

    /// Total bytes held by cached audio, linked or not.
    pub fn audio_total_bytes(&self) -> Result<i64, String> {
        self.conn()
            .query_row("SELECT COALESCE(SUM(bytes), 0) FROM audio", [], |r| {
                r.get(0)
            })
            .map_err(|e| format!("Failed to sum audio bytes: {}", e))
    }

    /// Unlinked hashes to evict, least recently played first, until the cache
    /// fits within `cap_bytes` or nothing unlinked is left. Linked audio is
    /// never chosen, so the total may stay over the cap.
    pub fn audio_to_evict(&self, cap_bytes: i64) -> Result<Vec<String>, String> {
        let total = self.audio_total_bytes()?;
        if total <= cap_bytes {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT a.hash, a.bytes FROM audio a WHERE {UNLINKED} ORDER BY a.last_used_at ASC"
            ))
            .map_err(|e| format!("Failed to prepare audio eviction scan: {}", e))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| format!("Failed to scan audio for eviction: {}", e))?;
        let mut freed = 0i64;
        let mut doomed = Vec::new();
        for row in rows {
            let (hash, bytes) = row.map_err(|e| format!("Failed to read eviction row: {}", e))?;
            doomed.push(hash);
            freed += bytes;
            if total - freed <= cap_bytes {
                break;
            }
        }
        Ok(doomed)
    }

    /// Unlinked audio created before `before_ms`.
    pub fn unlinked_audio_before(&self, before_ms: i64) -> Result<Vec<String>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT a.hash FROM audio a WHERE a.created_at < ?1 AND {UNLINKED}"
            ))
            .map_err(|e| format!("Failed to prepare audio orphan scan: {}", e))?;
        strings(&mut stmt, params![before_ms])
    }

    pub fn all_audio_hashes(&self) -> Result<Vec<String>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT hash FROM audio")
            .map_err(|e| format!("Failed to prepare audio hash list: {}", e))?;
        strings(&mut stmt, [])
    }

    /// Drop audio rows. The caller deletes the files first, as for images.
    pub fn delete_audio(&self, hashes: &[String]) -> Result<(), String> {
        if hashes.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn();
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to open audio delete transaction: {}", e))?;
        {
            let mut stmt = tx
                .prepare("DELETE FROM audio WHERE hash = ?1")
                .map_err(|e| format!("Failed to prepare audio delete: {}", e))?;
            for hash in hashes {
                stmt.execute(params![hash])
                    .map_err(|e| format!("Failed to delete audio: {}", e))?;
            }
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit audio delete: {}", e))
    }
}
