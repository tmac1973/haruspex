//! Notebooks as one value, for a backup file (`notebook_files::backup`):
//! every notebook, in Trash or not, with its tags, cards, rows, earlier
//! versions and link-check results. Search rows and semantic vectors are
//! left out; restoring rebuilds the first and the indexer redoes the second.
//! Notebook chats are not part of it.

use super::notebook_search::{index_card, index_notebook_title};
use super::*;
use rusqlite::{params, Connection};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BackupRow {
    pub id: String,
    pub position: f64,
    pub cells: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BackupRevision {
    pub created_at: i64,
    pub source: String,
    pub snapshot: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BackupCard {
    pub id: String,
    pub position: f64,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub meta: String,
    pub version: i64,
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub rows: Vec<BackupRow>,
    pub revisions: Vec<BackupRevision>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BackupLink {
    pub url: String,
    pub ok: bool,
    pub status: String,
    pub checked_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BackupNotebook {
    pub id: String,
    pub title: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub links_checked_at: Option<i64>,
    pub tags: Vec<String>,
    pub cards: Vec<BackupCard>,
    pub links: Vec<BackupLink>,
}

impl BackupNotebook {
    /// The kept files this notebook's cards and their earlier versions use.
    pub fn file_hashes(&self) -> Vec<String> {
        let hash_of = |meta: &str| {
            serde_json::from_str::<serde_json::Value>(meta)
                .ok()
                .and_then(|v| v.get("hash")?.as_str().map(str::to_string))
        };
        let mut out = Vec::new();
        for c in &self.cards {
            if c.kind == "attachment" || c.kind == "image" {
                out.extend(hash_of(&c.meta));
            }
            for r in &c.revisions {
                let meta = serde_json::from_str::<serde_json::Value>(&r.snapshot)
                    .ok()
                    .and_then(|v| v.get("meta")?.as_str().map(str::to_string));
                out.extend(meta.as_deref().and_then(hash_of));
            }
        }
        out
    }
}

/// What a restore does with a notebook that is already here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "NotebookRestoreMode")]
pub enum RestoreMode {
    /// Add the notebooks that aren't here; leave the rest as they are.
    Add,
    /// Make the notebooks match the backup: those in it replace the ones
    /// here, and those only here move to Trash.
    Replace,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, ts_rs::TS)]
#[ts(export, rename = "NotebookRestoreCounts")]
pub struct RestoreCounts {
    pub added: u32,
    pub replaced: u32,
    /// Already here, left alone (Add).
    pub skipped: u32,
    /// Only here, moved to Trash (Replace).
    pub trashed: u32,
}

fn err(what: &str) -> impl Fn(rusqlite::Error) -> String + '_ {
    move |e| format!("{what} failed: {e}")
}

fn read_all<T>(
    conn: &Connection,
    sql: &str,
    p: impl rusqlite::Params,
    f: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let mut stmt = conn.prepare(sql).map_err(err("Backup read"))?;
    let rows = stmt
        .query_map(p, f)
        .map_err(err("Backup read"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err("Backup read"));
    rows
}

fn dump_card(conn: &Connection, mut c: BackupCard) -> Result<BackupCard, String> {
    c.rows = read_all(
        conn,
        "SELECT id, position, cells FROM notebook_rows WHERE card_id = ?1 ORDER BY position",
        params![c.id],
        |r| {
            Ok(BackupRow {
                id: r.get(0)?,
                position: r.get(1)?,
                cells: r.get(2)?,
            })
        },
    )?;
    c.revisions = read_all(
        conn,
        "SELECT created_at, source, snapshot FROM notebook_revisions
         WHERE card_id = ?1 ORDER BY id",
        params![c.id],
        |r| {
            Ok(BackupRevision {
                created_at: r.get(0)?,
                source: r.get(1)?,
                snapshot: r.get(2)?,
            })
        },
    )?;
    Ok(c)
}

fn dump_notebook(conn: &Connection, mut n: BackupNotebook) -> Result<BackupNotebook, String> {
    n.tags = read_all(
        conn,
        "SELECT tag FROM notebook_tags WHERE notebook_id = ?1 ORDER BY tag",
        params![n.id],
        |r| r.get(0),
    )?;
    let cards = read_all(
        conn,
        "SELECT id, position, kind, title, body, meta, version, source, created_at,
                updated_at, deleted_at
         FROM notebook_cards WHERE notebook_id = ?1 ORDER BY position",
        params![n.id],
        |r| {
            Ok(BackupCard {
                id: r.get(0)?,
                position: r.get(1)?,
                kind: r.get(2)?,
                title: r.get(3)?,
                body: r.get(4)?,
                meta: r.get(5)?,
                version: r.get(6)?,
                source: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
                deleted_at: r.get(10)?,
                rows: Vec::new(),
                revisions: Vec::new(),
            })
        },
    )?;
    n.cards = cards
        .into_iter()
        .map(|c| dump_card(conn, c))
        .collect::<Result<_, _>>()?;
    n.links = read_all(
        conn,
        "SELECT url, ok, status, checked_at FROM notebook_link_status
         WHERE notebook_id = ?1 ORDER BY url",
        params![n.id],
        |r| {
            Ok(BackupLink {
                url: r.get(0)?,
                ok: r.get(1)?,
                status: r.get(2)?,
                checked_at: r.get(3)?,
            })
        },
    )?;
    Ok(n)
}

/// Remove a notebook's contents ahead of putting the backup's back. Unlike
/// a purge, its chat is kept: the backup has no chats to put back.
fn clear_notebook(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notebooks_fts WHERE notebook_id = ?1",
        params![id],
    )
    .map_err(err("Search clear"))?;
    // Cards, rows, versions, tags, links and vectors go with it (cascade).
    conn.execute("DELETE FROM notebooks WHERE id = ?1", params![id])
        .map_err(err("Notebook clear"))?;
    Ok(())
}

fn insert_notebook(conn: &Connection, n: &BackupNotebook) -> Result<(), String> {
    conn.execute(
        "INSERT INTO notebooks
         (id, title, pinned, created_at, updated_at, deleted_at, links_checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            n.id,
            n.title,
            n.pinned,
            n.created_at,
            n.updated_at,
            n.deleted_at,
            n.links_checked_at
        ],
    )
    .map_err(err("Notebook restore"))?;
    for tag in &n.tags {
        conn.execute(
            "INSERT OR IGNORE INTO notebook_tags (notebook_id, tag) VALUES (?1, ?2)",
            params![n.id, tag],
        )
        .map_err(err("Tag restore"))?;
    }
    for c in &n.cards {
        conn.execute(
            "INSERT INTO notebook_cards
             (id, notebook_id, position, kind, title, body, meta, version, source,
              created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                c.id,
                n.id,
                c.position,
                c.kind,
                c.title,
                c.body,
                c.meta,
                c.version,
                c.source,
                c.created_at,
                c.updated_at,
                c.deleted_at
            ],
        )
        .map_err(|e| format!("Card \"{}\" could not be restored: {e}", c.title))?;
        for r in &c.rows {
            conn.execute(
                "INSERT INTO notebook_rows (id, card_id, position, cells) VALUES (?1, ?2, ?3, ?4)",
                params![r.id, c.id, r.position, r.cells],
            )
            .map_err(err("Row restore"))?;
        }
        for r in &c.revisions {
            conn.execute(
                "INSERT INTO notebook_revisions (card_id, created_at, source, snapshot)
                 VALUES (?1, ?2, ?3, ?4)",
                params![c.id, r.created_at, r.source, r.snapshot],
            )
            .map_err(err("Version restore"))?;
        }
        index_card(conn, &c.id)?;
    }
    for l in &n.links {
        conn.execute(
            "INSERT OR REPLACE INTO notebook_link_status (notebook_id, url, ok, status, checked_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![n.id, l.url, l.ok, l.status, l.checked_at],
        )
        .map_err(err("Link restore"))?;
    }
    index_notebook_title(conn, &n.id, &n.title)?;
    Ok(())
}

impl Database {
    /// Every notebook, in Trash or not, ready to write to a backup.
    pub fn notebook_backup_dump(&self) -> Result<Vec<BackupNotebook>, String> {
        let conn = self.conn();
        let notebooks = read_all(
            &conn,
            "SELECT id, title, pinned, created_at, updated_at, deleted_at, links_checked_at
             FROM notebooks ORDER BY created_at",
            [],
            |r| {
                Ok(BackupNotebook {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    pinned: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                    deleted_at: r.get(5)?,
                    links_checked_at: r.get(6)?,
                    tags: Vec::new(),
                    cards: Vec::new(),
                    links: Vec::new(),
                })
            },
        )?;
        notebooks
            .into_iter()
            .map(|n| dump_notebook(&conn, n))
            .collect()
    }

    /// Ids of the given notebooks that are already here.
    pub fn notebook_ids_present(&self, ids: &[String]) -> Result<Vec<String>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT 1 FROM notebooks WHERE id = ?1")
            .map_err(err("Notebook lookup"))?;
        let mut out = Vec::new();
        for id in ids {
            if stmt.exists(params![id]).map_err(err("Notebook lookup"))? {
                out.push(id.clone());
            }
        }
        Ok(out)
    }

    /// Put a backup's notebooks back, all or nothing.
    pub fn notebook_backup_load(
        &self,
        notebooks: &[BackupNotebook],
        mode: RestoreMode,
        now_ms: i64,
    ) -> Result<RestoreCounts, String> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(err("Transaction"))?;
        let mut counts = RestoreCounts::default();
        let here: Vec<String> = read_all(&tx, "SELECT id FROM notebooks", [], |r| r.get(0))?;
        for n in notebooks {
            let exists = here.contains(&n.id);
            match (exists, mode) {
                (true, RestoreMode::Add) => {
                    counts.skipped += 1;
                    continue;
                }
                (true, RestoreMode::Replace) => {
                    clear_notebook(&tx, &n.id)?;
                    counts.replaced += 1;
                }
                (false, _) => counts.added += 1,
            }
            insert_notebook(&tx, n)?;
        }
        if mode == RestoreMode::Replace {
            for id in here
                .iter()
                .filter(|id| !notebooks.iter().any(|n| &n.id == *id))
            {
                let n = tx
                    .execute(
                        "UPDATE notebooks SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
                        params![id, now_ms],
                    )
                    .map_err(err("Trash"))?;
                counts.trashed += n as u32;
            }
        }
        tx.commit().map_err(err("Commit"))?;
        Ok(counts)
    }
}

#[cfg(test)]
mod tests {
    use super::super::notebook_rows::RowOp;
    use super::super::notebooks::NewCard;
    use super::*;

    fn card(kind: &str, body: &str, meta: &str, rows: Option<Vec<String>>) -> NewCard {
        NewCard {
            kind: kind.into(),
            title: format!("{kind} card"),
            body: body.into(),
            meta: meta.into(),
            rows,
        }
    }

    const USER: &str = r#"{"kind":"user"}"#;

    fn sample(db: &Database) -> String {
        let nb = db
            .notebook_create("Speakers", &["audio".to_string()])
            .unwrap();
        let text = db
            .notebook_card_add(&nb.id, None, &card("text", "v1", "{}", None), USER)
            .unwrap();
        db.notebook_card_update(&text.id, text.version, None, Some("v2 battery"), None, USER)
            .unwrap();
        let cols = r#"{"columns":[{"id":"a","name":"Name","type":"text"}]}"#;
        let table = db
            .notebook_card_add(
                &nb.id,
                None,
                &card("table", "", cols, Some(vec![r#"{"a":"Flip 6"}"#.into()])),
                USER,
            )
            .unwrap();
        db.notebook_rows_apply(
            &table.id,
            table.version,
            &[RowOp::Add {
                cells: r#"{"a":"Charge 5"}"#.into(),
                after: None,
            }],
            USER,
        )
        .unwrap();
        let h = "a".repeat(64);
        db.notebook_card_add(
            &nb.id,
            None,
            &card(
                "image",
                "",
                &format!(r#"{{"hash":"{h}","name":"p.png","mime":"image/png","size":3}}"#),
                None,
            ),
            USER,
        )
        .unwrap();
        nb.id
    }

    #[test]
    fn a_dump_loads_back_the_same_into_an_empty_database() {
        let a = Database::open_in_memory();
        let id = sample(&a);
        let dump = a.notebook_backup_dump().unwrap();
        assert_eq!(dump.len(), 1);
        assert_eq!(dump[0].tags, vec!["audio"]);
        assert_eq!(dump[0].cards.len(), 3);
        assert_eq!(dump[0].cards[1].rows.len(), 2);
        assert!(!dump[0].cards[0].revisions.is_empty());
        assert_eq!(dump[0].file_hashes(), vec!["a".repeat(64)]);

        let b = Database::open_in_memory();
        let counts = b.notebook_backup_load(&dump, RestoreMode::Add, 0).unwrap();
        assert_eq!(counts.added, 1);
        assert_eq!(b.notebook_backup_dump().unwrap(), dump);
        // Search works on what came back.
        let hits = b.notebook_search_keyword("Charge", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].notebook_id, id);
        assert_eq!(b.notebook_search_keyword("battery", 10).unwrap().len(), 1);
    }

    #[test]
    fn add_leaves_notebooks_already_here_alone() {
        let db = Database::open_in_memory();
        let id = sample(&db);
        let dump = db.notebook_backup_dump().unwrap();
        db.notebook_update(&id, Some("Changed"), None, None)
            .unwrap();
        let counts = db.notebook_backup_load(&dump, RestoreMode::Add, 0).unwrap();
        assert_eq!(counts.skipped, 1);
        assert_eq!(db.notebook_get(&id).unwrap().notebook.title, "Changed");
    }

    #[test]
    fn replace_puts_the_backup_back_and_trashes_what_is_only_here() {
        let db = Database::open_in_memory();
        let id = sample(&db);
        let dump = db.notebook_backup_dump().unwrap();
        db.notebook_update(&id, Some("Changed"), None, None)
            .unwrap();
        db.conversation_for_notebook(&id).unwrap();
        let other = db.notebook_create("Newer", &[]).unwrap();
        let counts = db
            .notebook_backup_load(&dump, RestoreMode::Replace, 42)
            .unwrap();
        assert_eq!(
            counts,
            RestoreCounts {
                added: 0,
                replaced: 1,
                skipped: 0,
                trashed: 1
            }
        );
        assert_eq!(db.notebook_get(&id).unwrap().notebook.title, "Speakers");
        assert_eq!(db.notebook_backup_dump().unwrap()[0], dump[0]);
        let trash = db.notebook_trash_list().unwrap();
        assert!(trash.notebooks.iter().any(|n| n.id == other.id));
        // Its chat is kept.
        let chats: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE notebook_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(chats, 1);
        // The replaced notebook's search rows aren't doubled.
        assert_eq!(db.notebook_search_keyword("Charge", 10).unwrap().len(), 1);
    }

    #[test]
    fn a_failed_restore_changes_nothing() {
        let db = Database::open_in_memory();
        let id = sample(&db);
        let mut dump = db.notebook_backup_dump().unwrap();
        dump[0].id = "fresh".into();
        // The same card ids as the notebook already here: the insert fails.
        let counts = db.notebook_backup_load(&dump, RestoreMode::Add, 0);
        assert!(counts.is_err());
        assert!(db.notebook_get("fresh").is_err());
        assert_eq!(db.notebook_get(&id).unwrap().cards.len(), 3);
    }
}
