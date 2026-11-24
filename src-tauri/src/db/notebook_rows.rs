//! Row-level edits to table and checklist cards, so changing one cell
//! writes one row and never the whole table. A batch of ops is one
//! transaction and one revision.

use super::notebook_revisions::{record_revision, RevisionMode};
use super::notebook_search::index_card;
use super::notebooks::{
    bump_card, card_required, check_json, check_version, insert_row, position_after, rows_of,
    touch_notebook, NotebookCard, NotebookRow,
};
use super::*;
use rusqlite::params;
use serde::Deserialize;

/// The most rows one table or checklist card holds.
pub const MAX_ROWS: i64 = 5000;

/// One change to a card's rows. `after` None: `add` appends at the end,
/// `move` puts the row first.
#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[serde(tag = "op", rename_all = "lowercase")]
#[ts(export)]
pub enum RowOp {
    Add {
        #[serde(default)]
        after: Option<String>,
        cells: String,
    },
    Update {
        row_id: String,
        cells: String,
    },
    Delete {
        row_id: String,
    },
    Move {
        row_id: String,
        #[serde(default)]
        after: Option<String>,
    },
}

fn require_rows(card: &NotebookCard) -> Result<(), String> {
    if card.kind == "table" || card.kind == "checklist" {
        Ok(())
    } else {
        Err(format!(
            "Card {} is a {} card, not a table.",
            card.id, card.kind
        ))
    }
}

impl Database {
    pub fn notebook_rows_get(
        &self,
        card_id: &str,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<NotebookRow>, String> {
        rows_of(
            &self.conn(),
            card_id,
            offset.max(0),
            limit.clamp(1, MAX_ROWS),
        )
    }

    /// Apply `ops` in order, all or nothing. Returns the card as it ends up.
    pub fn notebook_rows_apply(
        &self,
        card_id: &str,
        expected_version: i64,
        ops: &[RowOp],
        source: &str,
    ) -> Result<NotebookCard, String> {
        check_json(source, "The source")?;
        let mut conn = self.conn();
        let tx = conn
            .transaction()
            .map_err(|e| format!("Transaction failed: {e}"))?;
        let card = card_required(&tx, card_id)?;
        require_rows(&card)?;
        check_version(&card, expected_version)?;
        record_revision(&tx, &card, source, RevisionMode::Grouped)?;
        let mut count = card.row_count;
        let row_exists = |id: &str| -> Result<(), String> {
            let ok: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM notebook_rows WHERE id = ?1 AND card_id = ?2)",
                    params![id, card_id],
                    |r| r.get(0),
                )
                .map_err(|e| format!("Row check failed: {e}"))?;
            if ok {
                Ok(())
            } else {
                Err(format!("No row {id} in card {card_id}."))
            }
        };
        for op in ops {
            match op {
                RowOp::Add { after, cells } => {
                    if count >= MAX_ROWS {
                        return Err(format!("A table holds at most {MAX_ROWS} rows."));
                    }
                    let pos = position_after(
                        &tx,
                        "notebook_rows",
                        "card_id",
                        card_id,
                        after.as_deref(),
                        true,
                        None,
                    )?;
                    insert_row(&tx, card_id, pos, cells)?;
                    count += 1;
                }
                RowOp::Update { row_id, cells } => {
                    row_exists(row_id)?;
                    check_json(cells, "A row's cells")?;
                    tx.execute(
                        "UPDATE notebook_rows SET cells = ?2 WHERE id = ?1",
                        params![row_id, cells],
                    )
                    .map_err(|e| format!("Row update failed: {e}"))?;
                }
                RowOp::Delete { row_id } => {
                    row_exists(row_id)?;
                    tx.execute("DELETE FROM notebook_rows WHERE id = ?1", params![row_id])
                        .map_err(|e| format!("Row delete failed: {e}"))?;
                    count -= 1;
                }
                RowOp::Move { row_id, after } => {
                    row_exists(row_id)?;
                    let pos = position_after(
                        &tx,
                        "notebook_rows",
                        "card_id",
                        card_id,
                        after.as_deref(),
                        false,
                        Some(row_id),
                    )?;
                    tx.execute(
                        "UPDATE notebook_rows SET position = ?2 WHERE id = ?1",
                        params![row_id, pos],
                    )
                    .map_err(|e| format!("Row move failed: {e}"))?;
                }
            }
        }
        bump_card(&tx, card_id, source)?;
        index_card(&tx, card_id)?;
        touch_notebook(&tx, &card.notebook_id)?;
        let c = card_required(&tx, card_id)?;
        tx.commit().map_err(|e| format!("Commit failed: {e}"))?;
        Ok(c)
    }

    /// Replace a table's columns (JSON list of `{id,name,type,…}`). Cells
    /// under column ids no longer listed are dropped from every row.
    pub fn notebook_columns_set(
        &self,
        card_id: &str,
        expected_version: i64,
        columns: &str,
        source: &str,
    ) -> Result<NotebookCard, String> {
        check_json(source, "The source")?;
        let cols: Vec<serde_json::Value> =
            serde_json::from_str(columns).map_err(|e| format!("Columns are not a list: {e}"))?;
        let keep: std::collections::HashSet<String> = cols
            .iter()
            .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(String::from))
            .collect();
        if keep.len() != cols.len() {
            return Err("Every column needs its own id.".into());
        }
        let mut conn = self.conn();
        let tx = conn
            .transaction()
            .map_err(|e| format!("Transaction failed: {e}"))?;
        let card = card_required(&tx, card_id)?;
        require_rows(&card)?;
        check_version(&card, expected_version)?;
        record_revision(&tx, &card, source, RevisionMode::Grouped)?;
        let mut meta: serde_json::Value =
            serde_json::from_str(&card.meta).unwrap_or_else(|_| serde_json::json!({}));
        if !meta.is_object() {
            meta = serde_json::json!({});
        }
        meta["columns"] = serde_json::Value::Array(cols);
        tx.execute(
            "UPDATE notebook_cards SET meta = ?2 WHERE id = ?1",
            params![card_id, meta.to_string()],
        )
        .map_err(|e| format!("Column update failed: {e}"))?;
        for row in rows_of(&tx, card_id, 0, i64::MAX)? {
            let mut cells: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&row.cells).unwrap_or_default();
            let before = cells.len();
            cells.retain(|k, _| keep.contains(k));
            if cells.len() != before {
                tx.execute(
                    "UPDATE notebook_rows SET cells = ?2 WHERE id = ?1",
                    params![row.id, serde_json::Value::Object(cells).to_string()],
                )
                .map_err(|e| format!("Row update failed: {e}"))?;
            }
        }
        bump_card(&tx, card_id, source)?;
        index_card(&tx, card_id)?;
        touch_notebook(&tx, &card.notebook_id)?;
        let c = card_required(&tx, card_id)?;
        tx.commit().map_err(|e| format!("Commit failed: {e}"))?;
        Ok(c)
    }
}

#[cfg(test)]
mod tests {
    use super::super::notebooks::NewCard;
    use super::*;

    const USER: &str = r#"{"kind":"user"}"#;

    fn table(db: &Database, rows: usize) -> NotebookCard {
        let nb = db.notebook_create("N", &[]).unwrap();
        db.notebook_card_add(
            &nb.id,
            None,
            &NewCard {
                kind: "table".into(),
                title: "T".into(),
                body: String::new(),
                meta: r#"{"columns":[{"id":"a","name":"A","type":"text"},{"id":"b","name":"B","type":"number"}]}"#.into(),
                rows: Some((0..rows).map(|i| format!(r#"{{"a":"r{i}","b":{i}}}"#)).collect()),
            },
            USER,
        )
        .unwrap()
    }

    fn cell_a(c: &NotebookCard) -> Vec<String> {
        c.rows
            .iter()
            .map(|r| {
                serde_json::from_str::<serde_json::Value>(&r.cells).unwrap()["a"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn ops_apply_together() {
        let db = Database::open_in_memory();
        let c = table(&db, 3);
        let (r0, r2) = (c.rows[0].id.clone(), c.rows[2].id.clone());
        let c = db
            .notebook_rows_apply(
                &c.id,
                c.version,
                &[
                    RowOp::Update {
                        row_id: r0.clone(),
                        cells: r#"{"a":"first","b":0}"#.into(),
                    },
                    RowOp::Delete { row_id: r2 },
                    RowOp::Add {
                        after: Some(r0.clone()),
                        cells: r#"{"a":"new"}"#.into(),
                    },
                    RowOp::Move {
                        row_id: r0,
                        after: None,
                    },
                ],
                USER,
            )
            .unwrap();
        assert_eq!(cell_a(&c), ["first", "new", "r1"]);
        assert_eq!(c.row_count, 3);
    }

    #[test]
    fn a_bad_row_rolls_the_batch_back() {
        let db = Database::open_in_memory();
        let c = table(&db, 2);
        let err = db
            .notebook_rows_apply(
                &c.id,
                c.version,
                &[
                    RowOp::Update {
                        row_id: c.rows[0].id.clone(),
                        cells: r#"{"a":"changed"}"#.into(),
                    },
                    RowOp::Delete {
                        row_id: "nope".into(),
                    },
                ],
                USER,
            )
            .unwrap_err();
        assert!(err.contains("nope"));
        let now = db.notebook_get(&c.notebook_id).unwrap().cards.remove(0);
        assert_eq!(cell_a(&now), ["r0", "r1"]);
        assert_eq!(now.version, c.version);
    }

    #[test]
    fn row_cap_is_enforced() {
        let db = Database::open_in_memory();
        let c = table(&db, MAX_ROWS as usize);
        let err = db
            .notebook_rows_apply(
                &c.id,
                c.version,
                &[RowOp::Add {
                    after: None,
                    cells: "{}".into(),
                }],
                USER,
            )
            .unwrap_err();
        assert!(err.contains("at most"));
    }

    #[test]
    fn removing_a_column_drops_its_cells() {
        let db = Database::open_in_memory();
        let c = table(&db, 2);
        let c = db
            .notebook_columns_set(
                &c.id,
                c.version,
                r#"[{"id":"a","name":"A","type":"text"}]"#,
                USER,
            )
            .unwrap();
        assert!(c.rows.iter().all(|r| !r.cells.contains("\"b\"")));
        assert!(c.meta.contains("\"columns\""));
    }

    #[test]
    fn rows_page() {
        let db = Database::open_in_memory();
        let c = table(&db, 250);
        assert_eq!(c.rows.len(), 200);
        assert_eq!(c.row_count, 250);
        assert_eq!(db.notebook_rows_get(&c.id, 200, 100).unwrap().len(), 50);
    }
}
