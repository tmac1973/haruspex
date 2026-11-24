//! Notebooks: titled, tagged lists of cards (text, table, checklist, python,
//! attachment, image). Rows of tables and checklists live in
//! `notebook_rows` (see `notebook_rows`), earlier states of a card in
//! `notebook_revisions`, and keyword search in `notebooks_fts`
//! (`notebook_search`), which every write here keeps current.
//!
//! Deleting a notebook or card only sets `deleted_at` (Trash);
//! `purge_notebook_trash` removes what has been there 30 days.

use super::notebook_revisions::{record_revision, RevisionMode};
use super::notebook_search::{index_card, index_notebook_title, unindex_card};
use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

/// The card kinds the schema accepts.
pub const CARD_KINDS: [&str; 6] = [
    "text",
    "table",
    "checklist",
    "python",
    "attachment",
    "image",
];

/// How many rows `notebook_get` sends per table or checklist card; the rest
/// come through `notebook_rows_get`.
pub const ROWS_INLINE: i64 = 200;

/// Trash keeps things this long.
pub const TRASH_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// One notebook as the list shows it.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct NotebookSummary {
    pub id: String,
    pub title: String,
    pub pinned: bool,
    pub tags: Vec<String>,
    #[ts(type = "number")]
    pub card_count: i64,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "number | null")]
    pub deleted_at: Option<i64>,
    #[ts(type = "number | null")]
    pub links_checked_at: Option<i64>,
}

/// One row of a table or checklist card. `cells` is JSON keyed by column id.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct NotebookRow {
    pub id: String,
    pub position: f64,
    pub cells: String,
}

/// One card. `meta` and `source` are JSON text; `rows` holds the first
/// `ROWS_INLINE` rows of a table or checklist and `row_count` all of them.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct NotebookCard {
    pub id: String,
    pub notebook_id: String,
    pub position: f64,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub meta: String,
    #[ts(type = "number")]
    pub version: i64,
    pub source: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "number | null")]
    pub deleted_at: Option<i64>,
    #[ts(type = "number")]
    pub row_count: i64,
    pub rows: Vec<NotebookRow>,
}

/// A notebook with its live cards, in order.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct NotebookDetail {
    pub notebook: NotebookSummary,
    pub cards: Vec<NotebookCard>,
}

/// A card for `notebook_card_add`. `rows` are cells JSON, in order.
#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct NewCard {
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default = "empty_object")]
    pub meta: String,
    #[serde(default)]
    pub rows: Option<Vec<String>>,
}

fn empty_object() -> String {
    "{}".into()
}

/// A deleted card whose notebook is not deleted, for the Trash view.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TrashedCard {
    pub card: NotebookCard,
    pub notebook_title: String,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct NotebookTrash {
    pub notebooks: Vec<NotebookSummary>,
    pub cards: Vec<TrashedCard>,
}

pub(super) fn now() -> i64 {
    chrono_now()
}

/// A fresh id for `table`: 8 random hex characters, retried on the rare
/// clash. Short so a model can quote it back.
pub(super) fn new_id(conn: &Connection, table: &str) -> Result<String, String> {
    for _ in 0..8 {
        let id = crate::hash_util::random_hex(4)?;
        let taken: bool = conn
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
                params![id],
                |r| r.get(0),
            )
            .map_err(|e| format!("Id check failed: {e}"))?;
        if !taken {
            return Ok(id);
        }
    }
    Err("Could not pick a free id.".into())
}

/// `text` must be a JSON value; `what` names it in the error.
pub(super) fn check_json(text: &str, what: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(text)
        .map(|_| ())
        .map_err(|e| format!("{what} is not valid JSON: {e}"))
}

fn check_kind(kind: &str) -> Result<(), String> {
    if CARD_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!(
            "Unknown card kind '{kind}'. Use one of: {}.",
            CARD_KINDS.join(", ")
        ))
    }
}

fn db_err(what: &str) -> impl Fn(rusqlite::Error) -> String + '_ {
    move |e| format!("{what} failed: {e}")
}

const NOTEBOOK_COLS: &str = "n.id, n.title, n.pinned, n.created_at, n.updated_at, n.deleted_at,
     n.links_checked_at,
     (SELECT COUNT(*) FROM notebook_cards c WHERE c.notebook_id = n.id AND c.deleted_at IS NULL)";

fn summary_from_row(row: &rusqlite::Row) -> rusqlite::Result<NotebookSummary> {
    Ok(NotebookSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        pinned: row.get::<_, i64>(2)? != 0,
        tags: Vec::new(),
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        deleted_at: row.get(5)?,
        links_checked_at: row.get(6)?,
        card_count: row.get(7)?,
    })
}

fn tags_of(conn: &Connection, notebook_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT tag FROM notebook_tags WHERE notebook_id = ?1 ORDER BY tag")
        .map_err(db_err("Tag query"))?;
    let tags = stmt
        .query_map(params![notebook_id], |r| r.get(0))
        .map_err(db_err("Tag query"))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(db_err("Tag read"));
    tags
}

pub(super) fn summary(conn: &Connection, id: &str) -> Result<Option<NotebookSummary>, String> {
    let found = conn
        .query_row(
            &format!("SELECT {NOTEBOOK_COLS} FROM notebooks n WHERE n.id = ?1"),
            params![id],
            summary_from_row,
        )
        .optional()
        .map_err(db_err("Notebook read"))?;
    match found {
        Some(mut nb) => {
            nb.tags = tags_of(conn, id)?;
            Ok(Some(nb))
        }
        None => Ok(None),
    }
}

const CARD_COLS: &str = "id, notebook_id, position, kind, title, body, meta, version, source,
     created_at, updated_at, deleted_at,
     (SELECT COUNT(*) FROM notebook_rows r WHERE r.card_id = notebook_cards.id)";

fn card_from_row(row: &rusqlite::Row) -> rusqlite::Result<NotebookCard> {
    Ok(NotebookCard {
        id: row.get(0)?,
        notebook_id: row.get(1)?,
        position: row.get(2)?,
        kind: row.get(3)?,
        title: row.get(4)?,
        body: row.get(5)?,
        meta: row.get(6)?,
        version: row.get(7)?,
        source: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        deleted_at: row.get(11)?,
        row_count: row.get(12)?,
        rows: Vec::new(),
    })
}

/// Rows `offset..offset+limit` of a card, in order.
pub(super) fn rows_of(
    conn: &Connection,
    card_id: &str,
    offset: i64,
    limit: i64,
) -> Result<Vec<NotebookRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, position, cells FROM notebook_rows WHERE card_id = ?1
             ORDER BY position, id LIMIT ?2 OFFSET ?3",
        )
        .map_err(db_err("Row query"))?;
    let rows = stmt
        .query_map(params![card_id, limit, offset], |r| {
            Ok(NotebookRow {
                id: r.get(0)?,
                position: r.get(1)?,
                cells: r.get(2)?,
            })
        })
        .map_err(db_err("Row query"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err("Row read"));
    rows
}

/// A card with its first `ROWS_INLINE` rows, deleted or not.
pub(super) fn card(conn: &Connection, card_id: &str) -> Result<Option<NotebookCard>, String> {
    let found = conn
        .query_row(
            &format!("SELECT {CARD_COLS} FROM notebook_cards WHERE id = ?1"),
            params![card_id],
            card_from_row,
        )
        .optional()
        .map_err(db_err("Card read"))?;
    match found {
        Some(mut c) => {
            if c.kind == "table" || c.kind == "checklist" {
                c.rows = rows_of(conn, &c.id, 0, ROWS_INLINE)?;
            }
            Ok(Some(c))
        }
        None => Ok(None),
    }
}

/// A card that must exist; the error says it doesn't.
pub(super) fn card_required(conn: &Connection, card_id: &str) -> Result<NotebookCard, String> {
    card(conn, card_id)?.ok_or_else(|| format!("No card {card_id}."))
}

/// `expected` must be the card's current version: someone else's edit in
/// between makes this `"conflict"`, which callers re-read and retry on.
pub(super) fn check_version(card: &NotebookCard, expected: i64) -> Result<(), String> {
    if card.version == expected {
        Ok(())
    } else {
        Err("conflict".into())
    }
}

pub(super) fn touch_notebook(conn: &Connection, notebook_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE notebooks SET updated_at = ?2 WHERE id = ?1",
        params![notebook_id, now()],
    )
    .map_err(db_err("Notebook touch"))?;
    Ok(())
}

/// Bump a card's version and stamp its source and time.
pub(super) fn bump_card(conn: &Connection, card_id: &str, source: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE notebook_cards SET version = version + 1, source = ?2, updated_at = ?3
         WHERE id = ?1",
        params![card_id, source, now()],
    )
    .map_err(db_err("Card stamp"))?;
    Ok(())
}

/// The position for something placed right after `after` in an ordered
/// `table` scoped by `scope_col = scope`. `after` None: the end when
/// `at_end`, otherwise the start. Renumbers when the gap gets too small.
pub(super) fn position_after(
    conn: &Connection,
    table: &str,
    scope_col: &str,
    scope: &str,
    after: Option<&str>,
    at_end: bool,
    moving: Option<&str>,
) -> Result<f64, String> {
    let ids_positions = |conn: &Connection| -> Result<Vec<(String, f64)>, String> {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, position FROM {table} WHERE {scope_col} = ?1 AND id != ?2
                 ORDER BY position, id"
            ))
            .map_err(db_err("Order query"))?;
        let list = stmt
            .query_map(params![scope, moving.unwrap_or("")], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(db_err("Order query"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err("Order read"));
        list
    };
    let mut list = ids_positions(conn)?;
    for attempt in 0..2 {
        let (lo, hi) = match after {
            Some(a) => {
                let i = list
                    .iter()
                    .position(|(id, _)| id == a)
                    .ok_or_else(|| format!("No {a} to place after."))?;
                (Some(list[i].1), list.get(i + 1).map(|x| x.1))
            }
            None if at_end => (list.last().map(|x| x.1), None),
            None => (None, list.first().map(|x| x.1)),
        };
        let pos = match (lo, hi) {
            (None, None) => 1.0,
            (Some(l), None) => l + 1.0,
            (None, Some(h)) => h - 1.0,
            (Some(l), Some(h)) => {
                if h - l > 1e-6 || attempt == 1 {
                    (l + h) / 2.0
                } else {
                    // Renumber 1, 2, 3… and try again.
                    for (n, (id, _)) in list.iter().enumerate() {
                        conn.execute(
                            &format!("UPDATE {table} SET position = ?2 WHERE id = ?1"),
                            params![id, (n + 1) as f64],
                        )
                        .map_err(db_err("Renumber"))?;
                    }
                    list = ids_positions(conn)?;
                    continue;
                }
            }
        };
        return Ok(pos);
    }
    unreachable!("the second attempt always returns")
}

fn set_tags(conn: &Connection, notebook_id: &str, tags: &[String]) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notebook_tags WHERE notebook_id = ?1",
        params![notebook_id],
    )
    .map_err(db_err("Tag clear"))?;
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO notebook_tags (notebook_id, tag) VALUES (?1, ?2)",
            params![notebook_id, tag],
        )
        .map_err(db_err("Tag insert"))?;
    }
    Ok(())
}

/// Insert one row at `position`.
pub(super) fn insert_row(
    conn: &Connection,
    card_id: &str,
    position: f64,
    cells: &str,
) -> Result<String, String> {
    check_json(cells, "A row's cells")?;
    let id = new_id(conn, "notebook_rows")?;
    conn.execute(
        "INSERT INTO notebook_rows (id, card_id, position, cells) VALUES (?1, ?2, ?3, ?4)",
        params![id, card_id, position, cells],
    )
    .map_err(db_err("Row insert"))?;
    Ok(id)
}

/// Remove FTS rows and embeddings of cards and notebooks being purged.
fn forget_cards(conn: &Connection, card_ids: &[String]) -> Result<(), String> {
    for id in card_ids {
        unindex_card(conn, id)?;
    }
    Ok(())
}

impl Database {
    /// Every notebook, pinned first then by last edit. `include_deleted`
    /// adds those in Trash.
    pub fn notebook_list(&self, include_deleted: bool) -> Result<Vec<NotebookSummary>, String> {
        let conn = self.conn();
        let filter = if include_deleted {
            ""
        } else {
            "WHERE n.deleted_at IS NULL"
        };
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {NOTEBOOK_COLS} FROM notebooks n {filter}
                 ORDER BY n.pinned DESC, n.updated_at DESC"
            ))
            .map_err(db_err("Notebook list"))?;
        let mut list = stmt
            .query_map([], summary_from_row)
            .map_err(db_err("Notebook list"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err("Notebook read"))?;
        for nb in &mut list {
            nb.tags = tags_of(&conn, &nb.id)?;
        }
        Ok(list)
    }

    /// A notebook and its live cards.
    pub fn notebook_get(&self, id: &str) -> Result<NotebookDetail, String> {
        let conn = self.conn();
        let notebook = summary(&conn, id)?.ok_or_else(|| format!("No notebook {id}."))?;
        let ids: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM notebook_cards WHERE notebook_id = ?1 AND deleted_at IS NULL
                     ORDER BY position, id",
                )
                .map_err(db_err("Card list"))?;
            let ids = stmt
                .query_map(params![id], |r| r.get(0))
                .map_err(db_err("Card list"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err("Card read"))?;
            ids
        };
        let mut cards = Vec::with_capacity(ids.len());
        for cid in ids {
            if let Some(c) = card(&conn, &cid)? {
                cards.push(c);
            }
        }
        Ok(NotebookDetail { notebook, cards })
    }

    pub fn notebook_card_get(&self, card_id: &str) -> Result<NotebookCard, String> {
        card_required(&self.conn(), card_id)
    }

    pub fn notebook_create(&self, title: &str, tags: &[String]) -> Result<NotebookSummary, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("A notebook needs a title.".into());
        }
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err("Transaction"))?;
        let id = new_id(&tx, "notebooks")?;
        let t = now();
        tx.execute(
            "INSERT INTO notebooks (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, title, t],
        )
        .map_err(db_err("Notebook insert"))?;
        set_tags(&tx, &id, tags)?;
        index_notebook_title(&tx, &id, title)?;
        let nb = summary(&tx, &id)?.ok_or("Notebook vanished")?;
        tx.commit().map_err(db_err("Commit"))?;
        Ok(nb)
    }

    pub fn notebook_update(
        &self,
        id: &str,
        title: Option<&str>,
        pinned: Option<bool>,
        tags: Option<&[String]>,
    ) -> Result<NotebookSummary, String> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err("Transaction"))?;
        summary(&tx, id)?.ok_or_else(|| format!("No notebook {id}."))?;
        if let Some(title) = title {
            let title = title.trim();
            if title.is_empty() {
                return Err("A notebook needs a title.".into());
            }
            tx.execute(
                "UPDATE notebooks SET title = ?2 WHERE id = ?1",
                params![id, title],
            )
            .map_err(db_err("Notebook rename"))?;
            index_notebook_title(&tx, id, title)?;
        }
        if let Some(p) = pinned {
            tx.execute(
                "UPDATE notebooks SET pinned = ?2 WHERE id = ?1",
                params![id, p as i64],
            )
            .map_err(db_err("Notebook pin"))?;
        }
        if let Some(tags) = tags {
            set_tags(&tx, id, tags)?;
        }
        // Pinning isn't an edit; renaming and tagging are.
        if title.is_some() || tags.is_some() {
            touch_notebook(&tx, id)?;
        }
        let nb = summary(&tx, id)?.ok_or("Notebook vanished")?;
        tx.commit().map_err(db_err("Commit"))?;
        Ok(nb)
    }

    /// Move a notebook to Trash, or back with `deleted` false.
    pub fn notebook_set_deleted(&self, id: &str, deleted: bool) -> Result<(), String> {
        let n = self
            .conn()
            .execute(
                "UPDATE notebooks SET deleted_at = ?2 WHERE id = ?1",
                params![id, deleted.then(now)],
            )
            .map_err(db_err("Notebook delete"))?;
        if n == 0 {
            return Err(format!("No notebook {id}."));
        }
        Ok(())
    }

    /// Delete a notebook for good, with its cards.
    pub fn notebook_purge(&self, id: &str) -> Result<(), String> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err("Transaction"))?;
        purge_notebook(&tx, id)?;
        tx.commit().map_err(db_err("Commit"))
    }

    pub fn notebook_card_add(
        &self,
        notebook_id: &str,
        after_card_id: Option<&str>,
        new: &NewCard,
        source: &str,
    ) -> Result<NotebookCard, String> {
        check_kind(&new.kind)?;
        check_json(&new.meta, "The card's meta")?;
        check_json(source, "The source")?;
        let rows = new.rows.as_deref().unwrap_or(&[]);
        if rows.len() as i64 > super::notebook_rows::MAX_ROWS {
            return Err(format!(
                "A table holds at most {} rows.",
                super::notebook_rows::MAX_ROWS
            ));
        }
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err("Transaction"))?;
        let nb = summary(&tx, notebook_id)?.ok_or_else(|| format!("No notebook {notebook_id}."))?;
        if nb.deleted_at.is_some() {
            return Err(format!("Notebook {notebook_id} is in Trash."));
        }
        let pos = position_after(
            &tx,
            "notebook_cards",
            "notebook_id",
            notebook_id,
            after_card_id,
            true,
            None,
        )?;
        let id = new_id(&tx, "notebook_cards")?;
        let t = now();
        tx.execute(
            "INSERT INTO notebook_cards
             (id, notebook_id, position, kind, title, body, meta, source, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                id,
                notebook_id,
                pos,
                new.kind,
                new.title.trim(),
                new.body,
                new.meta,
                source,
                t
            ],
        )
        .map_err(db_err("Card insert"))?;
        for (i, cells) in rows.iter().enumerate() {
            insert_row(&tx, &id, (i + 1) as f64, cells)?;
        }
        index_card(&tx, &id)?;
        touch_notebook(&tx, notebook_id)?;
        let c = card_required(&tx, &id)?;
        tx.commit().map_err(db_err("Commit"))?;
        Ok(c)
    }

    /// Change a card's title, body or meta. `expected_version` guards
    /// against overwriting an edit made in between (`"conflict"`).
    pub fn notebook_card_update(
        &self,
        card_id: &str,
        expected_version: i64,
        title: Option<&str>,
        body: Option<&str>,
        meta: Option<&str>,
        source: &str,
    ) -> Result<NotebookCard, String> {
        check_json(source, "The source")?;
        if let Some(m) = meta {
            check_json(m, "The card's meta")?;
        }
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err("Transaction"))?;
        let c = card_required(&tx, card_id)?;
        check_version(&c, expected_version)?;
        record_revision(&tx, &c, source, RevisionMode::Grouped)?;
        tx.execute(
            "UPDATE notebook_cards SET
                 title = COALESCE(?2, title), body = COALESCE(?3, body),
                 meta = COALESCE(?4, meta)
             WHERE id = ?1",
            params![card_id, title.map(str::trim), body, meta],
        )
        .map_err(db_err("Card update"))?;
        bump_card(&tx, card_id, source)?;
        index_card(&tx, card_id)?;
        touch_notebook(&tx, &c.notebook_id)?;
        let c = card_required(&tx, card_id)?;
        tx.commit().map_err(db_err("Commit"))?;
        Ok(c)
    }

    /// Put a card right after `after_card_id`, or first when None.
    pub fn notebook_card_move(
        &self,
        card_id: &str,
        after_card_id: Option<&str>,
    ) -> Result<(), String> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err("Transaction"))?;
        let c = card_required(&tx, card_id)?;
        let pos = position_after(
            &tx,
            "notebook_cards",
            "notebook_id",
            &c.notebook_id,
            after_card_id,
            false,
            Some(card_id),
        )?;
        tx.execute(
            "UPDATE notebook_cards SET position = ?2 WHERE id = ?1",
            params![card_id, pos],
        )
        .map_err(db_err("Card move"))?;
        touch_notebook(&tx, &c.notebook_id)?;
        tx.commit().map_err(db_err("Commit"))
    }

    /// Move a card to Trash, or back with `deleted` false.
    pub fn notebook_card_set_deleted(&self, card_id: &str, deleted: bool) -> Result<(), String> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err("Transaction"))?;
        let c = card_required(&tx, card_id)?;
        tx.execute(
            "UPDATE notebook_cards SET deleted_at = ?2 WHERE id = ?1",
            params![card_id, deleted.then(now)],
        )
        .map_err(db_err("Card delete"))?;
        touch_notebook(&tx, &c.notebook_id)?;
        tx.commit().map_err(db_err("Commit"))
    }

    pub fn notebook_card_purge(&self, card_id: &str) -> Result<(), String> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err("Transaction"))?;
        forget_cards(&tx, &[card_id.to_string()])?;
        tx.execute("DELETE FROM notebook_cards WHERE id = ?1", params![card_id])
            .map_err(db_err("Card purge"))?;
        tx.commit().map_err(db_err("Commit"))
    }

    /// Deleted notebooks, and deleted cards of notebooks that aren't.
    pub fn notebook_trash_list(&self) -> Result<NotebookTrash, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {NOTEBOOK_COLS} FROM notebooks n WHERE n.deleted_at IS NOT NULL
                 ORDER BY n.deleted_at DESC"
            ))
            .map_err(db_err("Trash query"))?;
        let mut notebooks = stmt
            .query_map([], summary_from_row)
            .map_err(db_err("Trash query"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err("Trash read"))?;
        for nb in &mut notebooks {
            nb.tags = tags_of(&conn, &nb.id)?;
        }
        let mut stmt = conn
            .prepare(
                "SELECT c.id, n.title FROM notebook_cards c JOIN notebooks n ON n.id = c.notebook_id
                 WHERE c.deleted_at IS NOT NULL AND n.deleted_at IS NULL
                 ORDER BY c.deleted_at DESC",
            )
            .map_err(db_err("Trash query"))?;
        let pairs = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(db_err("Trash query"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err("Trash read"))?;
        let mut cards = Vec::new();
        for (id, notebook_title) in pairs {
            if let Some(card) = card(&conn, &id)? {
                cards.push(TrashedCard {
                    card,
                    notebook_title,
                });
            }
        }
        Ok(NotebookTrash { notebooks, cards })
    }

    /// Delete for good what has been in Trash for 30 days, as of `now_ms`.
    pub fn purge_notebook_trash(&self, now_ms: i64) -> Result<(), String> {
        let cutoff = now_ms - TRASH_MS;
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err("Transaction"))?;
        let old_notebooks: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM notebooks WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
                )
                .map_err(db_err("Trash query"))?;
            let ids = stmt
                .query_map(params![cutoff], |r| r.get(0))
                .map_err(db_err("Trash query"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err("Trash read"))?;
            ids
        };
        for id in &old_notebooks {
            purge_notebook(&tx, id)?;
        }
        let old_cards: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM notebook_cards WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
                )
                .map_err(db_err("Trash query"))?;
            let ids = stmt
                .query_map(params![cutoff], |r| r.get(0))
                .map_err(db_err("Trash query"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_err("Trash read"))?;
            ids
        };
        forget_cards(&tx, &old_cards)?;
        for id in &old_cards {
            tx.execute("DELETE FROM notebook_cards WHERE id = ?1", params![id])
                .map_err(db_err("Card purge"))?;
        }
        tx.commit().map_err(db_err("Commit"))
    }

    /// Every file hash a card (live or in Trash) or a revision of one still
    /// refers to: the notebook file store keeps exactly these.
    pub fn notebook_referenced_hashes(&self) -> Result<Vec<String>, String> {
        let conn = self.conn();
        let mut hashes = std::collections::BTreeSet::new();
        let mut stmt = conn
            .prepare(
                "SELECT json_extract(meta, '$.hash') FROM notebook_cards
                 WHERE kind IN ('attachment', 'image')",
            )
            .map_err(db_err("Hash query"))?;
        for h in stmt
            .query_map([], |r| r.get::<_, Option<String>>(0))
            .map_err(db_err("Hash query"))?
        {
            if let Some(h) = h.map_err(db_err("Hash read"))? {
                hashes.insert(h);
            }
        }
        let mut stmt = conn
            .prepare(
                "SELECT json_extract(json_extract(snapshot, '$.meta'), '$.hash')
                 FROM notebook_revisions",
            )
            .map_err(db_err("Hash query"))?;
        for h in stmt
            .query_map([], |r| r.get::<_, Option<String>>(0))
            .map_err(db_err("Hash query"))?
        {
            if let Some(h) = h.map_err(db_err("Hash read"))? {
                hashes.insert(h);
            }
        }
        Ok(hashes.into_iter().collect())
    }

    /// The MIME type stored with a notebook file, if any card has it.
    pub fn notebook_file_mime(&self, hash: &str) -> Result<Option<String>, String> {
        self.conn()
            .query_row(
                "SELECT json_extract(meta, '$.mime') FROM notebook_cards
                 WHERE json_extract(meta, '$.hash') = ?1 LIMIT 1",
                params![hash],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(db_err("File lookup"))
    }
}

fn purge_notebook(conn: &Connection, id: &str) -> Result<(), String> {
    let cards: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM notebook_cards WHERE notebook_id = ?1")
            .map_err(db_err("Card list"))?;
        let ids = stmt
            .query_map(params![id], |r| r.get(0))
            .map_err(db_err("Card list"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err("Card read"))?;
        ids
    };
    forget_cards(conn, &cards)?;
    conn.execute(
        "DELETE FROM notebooks_fts WHERE notebook_id = ?1",
        params![id],
    )
    .map_err(db_err("Search purge"))?;
    conn.execute(
        "DELETE FROM conversations WHERE notebook_id = ?1",
        params![id],
    )
    .map_err(db_err("Notebook chat purge"))?;
    conn.execute("DELETE FROM notebooks WHERE id = ?1", params![id])
        .map_err(db_err("Notebook purge"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const USER: &str = r#"{"kind":"user"}"#;

    pub(crate) fn text_card(body: &str) -> NewCard {
        NewCard {
            kind: "text".into(),
            title: String::new(),
            body: body.into(),
            meta: "{}".into(),
            rows: None,
        }
    }

    #[test]
    fn create_add_and_reorder_cards() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("Speakers", &["audio".into()]).unwrap();
        assert_eq!(nb.tags, vec!["audio".to_string()]);
        let a = db
            .notebook_card_add(&nb.id, None, &text_card("a"), USER)
            .unwrap();
        let b = db
            .notebook_card_add(&nb.id, None, &text_card("b"), USER)
            .unwrap();
        let c = db
            .notebook_card_add(&nb.id, Some(&a.id), &text_card("c"), USER)
            .unwrap();
        let order = |db: &Database| -> Vec<String> {
            db.notebook_get(&nb.id)
                .unwrap()
                .cards
                .into_iter()
                .map(|c| c.body)
                .collect()
        };
        assert_eq!(order(&db), ["a", "c", "b"]);
        db.notebook_card_move(&b.id, None).unwrap();
        assert_eq!(order(&db), ["b", "a", "c"]);
        db.notebook_card_move(&b.id, Some(&c.id)).unwrap();
        assert_eq!(order(&db), ["a", "c", "b"]);
    }

    #[test]
    fn many_moves_renumber_without_losing_order() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("N", &[]).unwrap();
        let a = db
            .notebook_card_add(&nb.id, None, &text_card("a"), USER)
            .unwrap();
        let b = db
            .notebook_card_add(&nb.id, None, &text_card("b"), USER)
            .unwrap();
        let c = db
            .notebook_card_add(&nb.id, None, &text_card("c"), USER)
            .unwrap();
        // Bounce c between a and b until the gap halves below 1e-6.
        for _ in 0..60 {
            db.notebook_card_move(&c.id, Some(&a.id)).unwrap();
            db.notebook_card_move(&b.id, Some(&a.id)).unwrap();
        }
        let ids: Vec<String> = db
            .notebook_get(&nb.id)
            .unwrap()
            .cards
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, [a.id, b.id, c.id]);
    }

    #[test]
    fn a_stale_version_is_a_conflict() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("N", &[]).unwrap();
        let c = db
            .notebook_card_add(&nb.id, None, &text_card("a"), USER)
            .unwrap();
        let c2 = db
            .notebook_card_update(&c.id, c.version, None, Some("b"), None, USER)
            .unwrap();
        assert_eq!(c2.version, c.version + 1);
        let err = db
            .notebook_card_update(&c.id, c.version, None, Some("x"), None, USER)
            .unwrap_err();
        assert_eq!(err, "conflict");
        assert_eq!(db.notebook_get(&nb.id).unwrap().cards[0].body, "b");
    }

    #[test]
    fn trash_hides_then_purges_after_30_days() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("N", &[]).unwrap();
        db.notebook_card_add(&nb.id, None, &text_card("a"), USER)
            .unwrap();
        db.notebook_set_deleted(&nb.id, true).unwrap();
        assert!(db.notebook_list(false).unwrap().is_empty());
        assert_eq!(db.notebook_trash_list().unwrap().notebooks.len(), 1);
        db.purge_notebook_trash(now()).unwrap();
        assert_eq!(db.notebook_list(true).unwrap().len(), 1, "too soon");
        db.purge_notebook_trash(now() + TRASH_MS + 1000).unwrap();
        assert!(db.notebook_list(true).unwrap().is_empty());
        let left: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM notebook_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn deleted_cards_show_in_trash_and_restore() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("N", &[]).unwrap();
        let c = db
            .notebook_card_add(&nb.id, None, &text_card("a"), USER)
            .unwrap();
        db.notebook_card_set_deleted(&c.id, true).unwrap();
        assert!(db.notebook_get(&nb.id).unwrap().cards.is_empty());
        assert_eq!(db.notebook_trash_list().unwrap().cards.len(), 1);
        db.notebook_card_set_deleted(&c.id, false).unwrap();
        assert_eq!(db.notebook_get(&nb.id).unwrap().cards.len(), 1);
    }

    #[test]
    fn unknown_kinds_and_bad_json_are_refused() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("N", &[]).unwrap();
        let mut bad = text_card("a");
        bad.kind = "video".into();
        assert!(db.notebook_card_add(&nb.id, None, &bad, USER).is_err());
        let mut bad = text_card("a");
        bad.meta = "{".into();
        assert!(db.notebook_card_add(&nb.id, None, &bad, USER).is_err());
    }

    #[test]
    fn a_notebook_chat_is_kept_out_of_chat_and_purged_with_its_notebook() {
        let db = Database::open_in_memory();
        db.create_conversation("plain", "Plain").unwrap();
        let nb = db.notebook_create("N", &[]).unwrap();
        let id = db.conversation_for_notebook(&nb.id).unwrap();
        assert_eq!(id, format!("notebook-{}", nb.id));
        assert_eq!(
            db.conversation_for_notebook(&nb.id).unwrap(),
            id,
            "made once"
        );
        let listed: Vec<String> = db
            .list_conversations()
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(listed, vec!["plain".to_string()]);
        db.notebook_purge(&nb.id).unwrap();
        let left: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn referenced_hashes_include_revisions() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("N", &[]).unwrap();
        let (h1, h2) = ("a".repeat(64), "b".repeat(64));
        let file = NewCard {
            kind: "attachment".into(),
            title: String::new(),
            body: String::new(),
            meta: format!(r#"{{"hash":"{h1}","name":"x.pdf","mime":"application/pdf","size":1}}"#),
            rows: None,
        };
        let c = db.notebook_card_add(&nb.id, None, &file, USER).unwrap();
        let meta2 =
            format!(r#"{{"hash":"{h2}","name":"y.pdf","mime":"application/pdf","size":1}}"#);
        db.notebook_card_update(&c.id, c.version, None, None, Some(&meta2), USER)
            .unwrap();
        assert_eq!(
            db.notebook_referenced_hashes().unwrap(),
            vec![h1, h2.clone()]
        );
        assert_eq!(
            db.notebook_file_mime(&h2).unwrap().as_deref(),
            Some("application/pdf")
        );
    }
}
