//! A card's earlier states. Every change records the state *before* it, so
//! History can put any of them back. Changes by the same source within two
//! minutes share one revision (the state before the first of them), and a
//! card keeps its newest 50.

use super::notebook_search::index_card;
use super::notebooks::{
    bump_card, card_required, insert_row, now, rows_of, touch_notebook, NotebookCard, NotebookRow,
};
use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

/// Revisions kept per card.
pub const KEEP: i64 = 50;
/// Changes by one source this close together share a revision.
pub const GROUP_MS: i64 = 2 * 60 * 1000;

/// One entry in a card's History.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CardHistoryEntry {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub created_at: i64,
    pub source: String,
}

/// What a revision holds: enough to put the card back as it was.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct CardSnapshot {
    pub kind: String,
    pub title: String,
    pub body: String,
    pub meta: String,
    pub rows: Vec<NotebookRow>,
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum RevisionMode {
    /// Fold into the newest revision when it is the same source's, recent.
    Grouped,
    /// Always a revision of its own (a rollback).
    Always,
}

fn source_key(source: &str) -> (String, String) {
    let v: serde_json::Value = serde_json::from_str(source).unwrap_or_default();
    let field = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    (field("kind"), field("ref"))
}

/// Record `card` (as it is now, before a change by `source`).
pub(super) fn record_revision(
    conn: &Connection,
    card: &NotebookCard,
    source: &str,
    mode: RevisionMode,
) -> Result<(), String> {
    if mode == RevisionMode::Grouped {
        let newest: Option<(i64, String)> = conn
            .query_row(
                "SELECT created_at, source FROM notebook_revisions WHERE card_id = ?1
                 ORDER BY id DESC LIMIT 1",
                params![card.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("Revision read failed: {e}"))?;
        // The card's own last change must be that same source too, or an
        // edit by someone else in between would be folded away.
        if let Some((at, src)) = newest {
            if now() - at < GROUP_MS
                && source_key(&src) == source_key(source)
                && source_key(&card.source) == source_key(source)
            {
                return Ok(());
            }
        }
    }
    let rows = if card.kind == "table" || card.kind == "checklist" {
        rows_of(conn, &card.id, 0, i64::MAX)?
    } else {
        Vec::new()
    };
    let snap = CardSnapshot {
        kind: card.kind.clone(),
        title: card.title.clone(),
        body: card.body.clone(),
        meta: card.meta.clone(),
        rows,
    };
    let json = serde_json::to_string(&snap).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO notebook_revisions (card_id, created_at, source, snapshot)
         VALUES (?1, ?2, ?3, ?4)",
        params![card.id, now(), source, json],
    )
    .map_err(|e| format!("Revision insert failed: {e}"))?;
    conn.execute(
        "DELETE FROM notebook_revisions WHERE card_id = ?1 AND id NOT IN
         (SELECT id FROM notebook_revisions WHERE card_id = ?1 ORDER BY id DESC LIMIT ?2)",
        params![card.id, KEEP],
    )
    .map_err(|e| format!("Revision prune failed: {e}"))?;
    Ok(())
}

impl Database {
    /// A card's revisions, newest first. Each is the state before the
    /// change made by its `source`.
    pub fn notebook_card_history(&self, card_id: &str) -> Result<Vec<CardHistoryEntry>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, created_at, source FROM notebook_revisions WHERE card_id = ?1
                 ORDER BY id DESC",
            )
            .map_err(|e| format!("History query failed: {e}"))?;
        let list = stmt
            .query_map(params![card_id], |r| {
                Ok(CardHistoryEntry {
                    id: r.get(0)?,
                    created_at: r.get(1)?,
                    source: r.get(2)?,
                })
            })
            .map_err(|e| format!("History query failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("History read failed: {e}"));
        list
    }

    pub fn notebook_card_revision(&self, revision_id: i64) -> Result<CardSnapshot, String> {
        let json: String = self
            .conn()
            .query_row(
                "SELECT snapshot FROM notebook_revisions WHERE id = ?1",
                params![revision_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("Revision read failed: {e}"))?
            .ok_or_else(|| format!("No revision {revision_id}."))?;
        serde_json::from_str(&json).map_err(|e| format!("Revision is unreadable: {e}"))
    }

    /// Put a card back as revision `revision_id` had it. The state replaced
    /// becomes a revision itself, so this can be undone the same way.
    pub fn notebook_card_rollback(
        &self,
        card_id: &str,
        revision_id: i64,
        source: &str,
    ) -> Result<NotebookCard, String> {
        let snap = self.notebook_card_revision(revision_id)?;
        let mut conn = self.conn();
        let tx = conn
            .transaction()
            .map_err(|e| format!("Transaction failed: {e}"))?;
        let owner: String = tx
            .query_row(
                "SELECT card_id FROM notebook_revisions WHERE id = ?1",
                params![revision_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("Revision read failed: {e}"))?;
        if owner != card_id {
            return Err(format!("Revision {revision_id} is not card {card_id}'s."));
        }
        let card = card_required(&tx, card_id)?;
        record_revision(&tx, &card, source, RevisionMode::Always)?;
        tx.execute(
            "UPDATE notebook_cards SET title = ?2, body = ?3, meta = ?4 WHERE id = ?1",
            params![card_id, snap.title, snap.body, snap.meta],
        )
        .map_err(|e| format!("Rollback failed: {e}"))?;
        tx.execute(
            "DELETE FROM notebook_rows WHERE card_id = ?1",
            params![card_id],
        )
        .map_err(|e| format!("Rollback failed: {e}"))?;
        for row in &snap.rows {
            insert_row_with_id(&tx, card_id, row)?;
        }
        bump_card(&tx, card_id, source)?;
        index_card(&tx, card_id)?;
        touch_notebook(&tx, &card.notebook_id)?;
        let c = card_required(&tx, card_id)?;
        tx.commit().map_err(|e| format!("Commit failed: {e}"))?;
        Ok(c)
    }
}

/// Re-insert a row as a snapshot had it, keeping its id when free.
fn insert_row_with_id(conn: &Connection, card_id: &str, row: &NotebookRow) -> Result<(), String> {
    let n = conn
        .execute(
            "INSERT OR IGNORE INTO notebook_rows (id, card_id, position, cells)
             VALUES (?1, ?2, ?3, ?4)",
            params![row.id, card_id, row.position, row.cells],
        )
        .map_err(|e| format!("Row restore failed: {e}"))?;
    if n == 0 {
        insert_row(conn, card_id, row.position, &row.cells)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::notebooks::NewCard;
    use super::*;

    const USER: &str = r#"{"kind":"user"}"#;
    const CHAT: &str = r#"{"kind":"chat","ref":"c1","label":"Speakers"}"#;

    fn setup() -> (Database, NotebookCard) {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("N", &[]).unwrap();
        let c = db
            .notebook_card_add(
                &nb.id,
                None,
                &NewCard {
                    kind: "text".into(),
                    title: String::new(),
                    body: "v0".into(),
                    meta: "{}".into(),
                    rows: None,
                },
                USER,
            )
            .unwrap();
        (db, c)
    }

    fn edit(db: &Database, id: &str, body: &str, source: &str) -> NotebookCard {
        let v = {
            let conn = db.conn();
            card_required(&conn, id).unwrap().version
        };
        db.notebook_card_update(id, v, None, Some(body), None, source)
            .unwrap()
    }

    #[test]
    fn same_source_edits_group_and_others_split() {
        let (db, c) = setup();
        edit(&db, &c.id, "v1", USER);
        edit(&db, &c.id, "v2", USER);
        assert_eq!(db.notebook_card_history(&c.id).unwrap().len(), 1);
        edit(&db, &c.id, "v3", CHAT);
        assert_eq!(db.notebook_card_history(&c.id).unwrap().len(), 2);
        edit(&db, &c.id, "v4", CHAT);
        assert_eq!(db.notebook_card_history(&c.id).unwrap().len(), 2);
        edit(&db, &c.id, "v5", USER);
        assert_eq!(db.notebook_card_history(&c.id).unwrap().len(), 3);
    }

    #[test]
    fn keeps_the_newest_fifty() {
        let (db, c) = setup();
        for i in 0..60 {
            let src = if i % 2 == 0 { USER } else { CHAT };
            edit(&db, &c.id, &format!("v{i}"), src);
        }
        assert_eq!(
            db.notebook_card_history(&c.id).unwrap().len(),
            KEEP as usize
        );
    }

    #[test]
    fn rollback_restores_and_can_itself_be_undone() {
        let (db, c) = setup();
        edit(&db, &c.id, "v1", CHAT);
        let first = db.notebook_card_history(&c.id).unwrap()[0].id;
        let back = db.notebook_card_rollback(&c.id, first, USER).unwrap();
        assert_eq!(back.body, "v0");
        let undo = db.notebook_card_history(&c.id).unwrap()[0].id;
        let again = db.notebook_card_rollback(&c.id, undo, USER).unwrap();
        assert_eq!(again.body, "v1");
    }
}
