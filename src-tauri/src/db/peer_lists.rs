//! Each trusted computer's last-known session and chat lists, so its section
//! in the Code and Chat lists can still be drawn while it's offline
//! (plan/instance-sync). The frontend writes them as JSON arrays of a few
//! fields each; nothing here looks inside.

use super::*;
use rusqlite::{params, OptionalExtension};

/// Most entries one list may hold, and most bytes both may take together.
const MAX_ENTRIES: usize = 2_000;
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PeerLists {
    #[ts(type = "unknown[]")]
    pub sessions: serde_json::Value,
    #[ts(type = "unknown[]")]
    pub chats: serde_json::Value,
    #[ts(type = "number")]
    pub updated_at: i64,
}

impl Database {
    pub fn get_peer_lists(&self, peer_id: &str) -> Result<Option<PeerLists>, String> {
        let row = self
            .conn()
            .query_row(
                "SELECT sessions, chats, updated_at FROM peer_lists WHERE peer_id = ?1",
                params![peer_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| format!("Peer lists query failed: {e}"))?;
        let Some((sessions, chats, updated_at)) = row else {
            return Ok(None);
        };
        let parse =
            |t: &str| serde_json::from_str(t).unwrap_or(serde_json::Value::Array(Vec::new()));
        Ok(Some(PeerLists {
            sessions: parse(&sessions),
            chats: parse(&chats),
            updated_at,
        }))
    }

    /// Keep a peer's lists, replacing what was there. Refused unless both are
    /// arrays within the limits.
    pub fn save_peer_lists(
        &self,
        peer_id: &str,
        sessions: &serde_json::Value,
        chats: &serde_json::Value,
        now: i64,
    ) -> Result<(), String> {
        let text = |v: &serde_json::Value| -> Result<String, String> {
            match v.as_array() {
                Some(a) if a.len() <= MAX_ENTRIES => Ok(v.to_string()),
                Some(_) => Err(format!("a peer list holds at most {MAX_ENTRIES} entries")),
                None => Err("a peer list must be an array".into()),
            }
        };
        let (sessions, chats) = (text(sessions)?, text(chats)?);
        if sessions.len() + chats.len() > MAX_BYTES {
            return Err("a peer's lists are too large to keep".into());
        }
        self.conn()
            .execute(
                "INSERT INTO peer_lists (peer_id, sessions, chats, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(peer_id) DO UPDATE SET
                     sessions = excluded.sessions,
                     chats = excluded.chats,
                     updated_at = excluded.updated_at",
                params![peer_id, sessions, chats, now],
            )
            .map_err(|e| format!("Peer lists save failed: {e}"))?;
        Ok(())
    }

    /// Drop the lists of every peer not in `peer_ids`: a computer the owner
    /// removed takes its titles with it.
    pub fn retain_peer_lists(&self, peer_ids: &[String]) -> Result<(), String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT peer_id FROM peer_lists")
            .map_err(|e| format!("Peer lists query failed: {e}"))?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("Peer lists query failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Peer lists query failed: {e}"))?;
        for id in ids.iter().filter(|id| !peer_ids.contains(id)) {
            conn.execute("DELETE FROM peer_lists WHERE peer_id = ?1", params![id])
                .map_err(|e| format!("Peer lists delete failed: {e}"))?;
        }
        Ok(())
    }
}
