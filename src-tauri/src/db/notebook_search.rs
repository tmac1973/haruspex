//! Keyword search over notebooks (`notebooks_fts`). The index is written
//! by the notebook write paths rather than triggers, because what's
//! searchable is derived: a card's title, body and file name, each table
//! row's cell values, and the notebook's title.

use super::camera_events::fts_query;
use super::*;
use rusqlite::{params, Connection};

/// One search result. `card_id` is None for a match on the notebook's
/// title, and `row_id` is set for a match in a table or checklist row.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct NotebookSearchHit {
    pub notebook_id: String,
    pub notebook_title: String,
    pub card_id: Option<String>,
    pub card_title: Option<String>,
    pub card_kind: Option<String>,
    pub row_id: Option<String>,
    /// The matching text, with matches wrapped in `[[` and `]]`.
    pub snippet: String,
    pub score: f64,
}

/// The text a JSON value contributes to search: strings and numbers,
/// recursively, separated by spaces.
fn json_text(v: &serde_json::Value, out: &mut String) {
    match v {
        serde_json::Value::String(s) => {
            out.push_str(s);
            out.push(' ');
        }
        serde_json::Value::Number(n) => {
            out.push_str(&n.to_string());
            out.push(' ');
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| json_text(x, out)),
        serde_json::Value::Object(o) => o.values().for_each(|x| json_text(x, out)),
        _ => {}
    }
}

pub(super) fn unindex_card(conn: &Connection, card_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notebooks_fts WHERE card_id = ?1",
        params![card_id],
    )
    .map_err(|e| format!("Search index delete failed: {e}"))?;
    Ok(())
}

/// Rewrite a card's search rows from what is stored now.
pub(super) fn index_card(conn: &Connection, card_id: &str) -> Result<(), String> {
    unindex_card(conn, card_id)?;
    let (notebook_id, kind, title, body, meta): (String, String, String, String, String) = conn
        .query_row(
            "SELECT notebook_id, kind, title, body, meta FROM notebook_cards WHERE id = ?1",
            params![card_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|e| format!("Card read failed: {e}"))?;
    let mut text = format!("{title} {body} ");
    if kind == "attachment" || kind == "image" {
        let meta: serde_json::Value = serde_json::from_str(&meta).unwrap_or_default();
        if let Some(name) = meta.get("name").and_then(|v| v.as_str()) {
            text.push_str(name);
        }
    }
    let insert = |text: &str, row_id: &str| {
        conn.execute(
            "INSERT INTO notebooks_fts (text, notebook_id, card_id, row_id) VALUES (?1, ?2, ?3, ?4)",
            params![text.trim(), notebook_id, card_id, row_id],
        )
        .map_err(|e| format!("Search index insert failed: {e}"))
    };
    if !text.trim().is_empty() {
        insert(&text, "")?;
    }
    if kind == "table" || kind == "checklist" {
        let mut stmt = conn
            .prepare("SELECT id, cells FROM notebook_rows WHERE card_id = ?1")
            .map_err(|e| format!("Row read failed: {e}"))?;
        let rows = stmt
            .query_map(params![card_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Row read failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Row read failed: {e}"))?;
        for (row_id, cells) in rows {
            let mut t = String::new();
            json_text(&serde_json::from_str(&cells).unwrap_or_default(), &mut t);
            if !t.trim().is_empty() {
                insert(&t, &row_id)?;
            }
        }
    }
    Ok(())
}

pub(super) fn index_notebook_title(
    conn: &Connection,
    notebook_id: &str,
    title: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notebooks_fts WHERE notebook_id = ?1 AND card_id = ''",
        params![notebook_id],
    )
    .map_err(|e| format!("Search index delete failed: {e}"))?;
    conn.execute(
        "INSERT INTO notebooks_fts (text, notebook_id, card_id, row_id) VALUES (?1, ?2, '', '')",
        params![title, notebook_id],
    )
    .map_err(|e| format!("Search index insert failed: {e}"))?;
    Ok(())
}

impl Database {
    /// Keyword search over live notebooks and cards, best first.
    pub fn notebook_search_keyword(
        &self,
        query: &str,
        limit: i64,
    ) -> Result<Vec<NotebookSearchHit>, String> {
        let Some(q) = fts_query(query) else {
            return Ok(Vec::new());
        };
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT f.notebook_id, n.title, f.card_id, c.title, c.kind, f.row_id,
                        snippet(notebooks_fts, 0, '[[', ']]', '…', 16), bm25(notebooks_fts)
                 FROM notebooks_fts f
                 JOIN notebooks n ON n.id = f.notebook_id
                 LEFT JOIN notebook_cards c ON c.id = f.card_id
                 WHERE notebooks_fts MATCH ?1 AND n.deleted_at IS NULL
                   AND (f.card_id = '' OR (c.id IS NOT NULL AND c.deleted_at IS NULL))
                 ORDER BY bm25(notebooks_fts) LIMIT ?2",
            )
            .map_err(|e| format!("Search failed: {e}"))?;
        let hits = stmt
            .query_map(params![q, limit.clamp(1, 200)], |r| {
                let card_id: String = r.get(2)?;
                let row_id: String = r.get(5)?;
                let bm25: f64 = r.get(7)?;
                Ok(NotebookSearchHit {
                    notebook_id: r.get(0)?,
                    notebook_title: r.get(1)?,
                    card_id: (!card_id.is_empty()).then_some(card_id),
                    card_title: r.get(3)?,
                    card_kind: r.get(4)?,
                    row_id: (!row_id.is_empty()).then_some(row_id),
                    snippet: r.get(6)?,
                    // bm25 is lower-is-better and negative; flip it.
                    score: -bm25,
                })
            })
            .map_err(|e| format!("Search failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Search read failed: {e}"));
        hits
    }
}

#[cfg(test)]
mod tests {
    use super::super::notebooks::NewCard;
    use super::*;

    const USER: &str = r#"{"kind":"user"}"#;

    #[test]
    fn finds_titles_text_and_table_cells() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("Speakers", &[]).unwrap();
        let text = db
            .notebook_card_add(
                &nb.id,
                None,
                &NewCard {
                    kind: "text".into(),
                    title: "Notes".into(),
                    body: "Look for long battery life".into(),
                    meta: "{}".into(),
                    rows: None,
                },
                USER,
            )
            .unwrap();
        let table = db
            .notebook_card_add(
                &nb.id,
                None,
                &NewCard {
                    kind: "table".into(),
                    title: "Models".into(),
                    body: String::new(),
                    meta: "{}".into(),
                    rows: Some(vec![r#"{"a":"Soundcore Motion","b":79.99}"#.into()]),
                },
                USER,
            )
            .unwrap();

        let hit = &db.notebook_search_keyword("soundcore", 10).unwrap()[0];
        assert_eq!(hit.card_id.as_deref(), Some(table.id.as_str()));
        assert_eq!(hit.row_id.as_deref(), Some(table.rows[0].id.as_str()));
        assert!(hit.snippet.contains("[[Soundcore]]"));

        assert_eq!(
            db.notebook_search_keyword("batt", 10).unwrap()[0]
                .card_id
                .as_deref(),
            Some(text.id.as_str()),
            "prefix match"
        );
        let title = &db.notebook_search_keyword("speakers", 10).unwrap()[0];
        assert!(title.card_id.is_none());

        db.notebook_card_set_deleted(&text.id, true).unwrap();
        assert!(db
            .notebook_search_keyword("battery", 10)
            .unwrap()
            .is_empty());
        db.notebook_card_purge(&text.id).unwrap();
        assert!(db
            .notebook_search_keyword("battery", 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn renaming_reindexes_the_title() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("Old", &[]).unwrap();
        db.notebook_update(&nb.id, Some("Fresh"), None, None)
            .unwrap();
        assert!(db.notebook_search_keyword("old", 10).unwrap().is_empty());
        assert_eq!(db.notebook_search_keyword("fresh", 10).unwrap().len(), 1);
    }
}
