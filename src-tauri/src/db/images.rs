//! Cached-image persistence: the `images` rows (content-addressed bytes plus
//! their provenance) and the `conversation_images` links that decide when the
//! bytes may be deleted.
//!
//! This module owns SQL only. Fetching, decoding and the on-disk files are
//! `crate::image_cache`'s job — keeping them apart is what lets every query
//! here be tested against an in-memory database with no network and no
//! filesystem.
//!
//! Two deletion paths exist and they are not the same thing:
//!
//!   - **Cascade.** Dropping a conversation drops its `conversation_images`
//!     rows via `ON DELETE CASCADE`. That alone frees nothing — it only makes
//!     the image unreferenced.
//!   - **Sweep.** [`Database::unreferenced_image_hashes`] then reports rows no
//!     conversation points at any more, and the caller deletes their files
//!     before calling [`Database::delete_images`]. Files first: a row without
//!     its file is a broken image, a file without its row is reclaimable junk
//!     the startup sweep collects.

use super::*;
use rusqlite::params;

/// Every column an [`ImageRow`] read needs, in the order [`read_image`] wants.
const IMAGE_COLUMNS: &str = "hash, source_url, source, mime, width, height, bytes, \
     license, attribution, description_url, embeddable, created_at, last_used_at";

/// One cached image: the bytes' identity, where it came from, and what may be
/// done with it.
///
/// `embeddable` is written by every insert and read by nothing in this
/// codebase yet. It records whether the licence permits redistributing the
/// image inside a generated document, so the future pptx/docx/pdf path can
/// filter on it without re-fetching or re-classifying anything. See
/// `crate::image_cache::license`.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ImageRow {
    pub hash: String,
    pub source_url: String,
    pub source: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    #[ts(type = "number")]
    pub bytes: i64,
    pub license: Option<String>,
    pub attribution: Option<String>,
    pub description_url: Option<String>,
    pub embeddable: bool,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub last_used_at: i64,
}

fn read_image(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImageRow> {
    Ok(ImageRow {
        hash: row.get(0)?,
        source_url: row.get(1)?,
        source: row.get(2)?,
        mime: row.get(3)?,
        width: row.get(4)?,
        height: row.get(5)?,
        bytes: row.get(6)?,
        license: row.get(7)?,
        attribution: row.get(8)?,
        description_url: row.get(9)?,
        embeddable: row.get::<_, i64>(10)? != 0,
        created_at: row.get(11)?,
        last_used_at: row.get(12)?,
    })
}

impl Database {
    /// Look one image up by the URL it was fetched from.
    ///
    /// This is the whole of the rehydration path: a row proves the URL passed
    /// the eligibility rules when it was first fetched, so an old conversation
    /// can render it again without re-deriving that permission. A miss proves
    /// nothing, which is why rehydration never falls through to a fetch.
    pub fn image_by_source_url(&self, source_url: &str) -> Result<Option<ImageRow>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {IMAGE_COLUMNS} FROM images WHERE source_url = ?1"
            ))
            .map_err(|e| format!("Failed to prepare image lookup: {}", e))?;
        let mut rows = stmt
            .query_map(params![source_url], read_image)
            .map_err(|e| format!("Failed to query image: {}", e))?;
        match rows.next() {
            Some(row) => Ok(Some(
                row.map_err(|e| format!("Failed to read image: {}", e))?,
            )),
            None => Ok(None),
        }
    }

    /// Insert an image, or return the existing row if those exact bytes are
    /// already cached.
    ///
    /// Content addressing means two URLs serving identical bytes collapse to
    /// one row and one file. The insert is `OR IGNORE` rather than `OR
    /// REPLACE` so the *first* provenance wins: if the same photograph arrives
    /// once from Commons with a licence and once scraped from a blog with
    /// none, keeping the first preserves the attribution rather than
    /// overwriting it with the poorer record.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_image(&self, image: &ImageRow) -> Result<(), String> {
        let now = chrono_now();
        let conn = self.conn();
        conn.execute(
            "INSERT OR IGNORE INTO images
                (hash, source_url, source, mime, width, height, bytes,
                 license, attribution, description_url, embeddable,
                 created_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            params![
                image.hash,
                image.source_url,
                image.source,
                image.mime,
                image.width,
                image.height,
                image.bytes,
                image.license,
                image.attribution,
                image.description_url,
                image.embeddable as i64,
                now,
            ],
        )
        .map_err(|e| format!("Failed to insert image: {}", e))?;
        Ok(())
    }

    /// Record that a conversation displays an image.
    ///
    /// Idempotent: the composite primary key makes a repeat link a no-op, so
    /// re-opening a conversation and resolving the same images again costs
    /// nothing and cannot double-count a reference.
    pub fn link_image(&self, conversation_id: &str, image_hash: &str) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "INSERT OR IGNORE INTO conversation_images (conversation_id, image_hash)
             VALUES (?1, ?2)",
            params![conversation_id, image_hash],
        )
        .map_err(|e| format!("Failed to link image: {}", e))?;
        Ok(())
    }

    /// Total bytes currently held by cached images.
    pub fn images_total_bytes(&self) -> Result<i64, String> {
        let conn = self.conn();
        conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM images", [], |r| {
            r.get(0)
        })
        .map_err(|e| format!("Failed to sum image bytes: {}", e))
    }

    /// Hashes to evict, least recently used first, until the cache would fit
    /// within `cap_bytes`.
    ///
    /// Referenced images are evictable. The conversation keeps the original
    /// URL in its message text, so the cap is a disk limit rather than a
    /// retention promise — and because rehydration is lookup-only, an evicted
    /// image simply stops rendering instead of being re-fetched.
    pub fn images_to_evict(&self, cap_bytes: i64) -> Result<Vec<String>, String> {
        let total = self.images_total_bytes()?;
        if total <= cap_bytes {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT hash, bytes FROM images ORDER BY last_used_at ASC")
            .map_err(|e| format!("Failed to prepare eviction scan: {}", e))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| format!("Failed to scan for eviction: {}", e))?;

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

    /// Images no conversation references any more — the cascade's leftovers.
    pub fn unreferenced_image_hashes(&self) -> Result<Vec<String>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT i.hash FROM images i
                 LEFT JOIN conversation_images ci ON ci.image_hash = i.hash
                 WHERE ci.image_hash IS NULL",
            )
            .map_err(|e| format!("Failed to prepare orphan scan: {}", e))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("Failed to scan orphans: {}", e))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("Failed to read orphan row: {}", e))
    }

    /// Every cached hash, for reconciling the table against the files on disk.
    pub fn all_image_hashes(&self) -> Result<Vec<String>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT hash FROM images")
            .map_err(|e| format!("Failed to prepare hash list: {}", e))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("Failed to list hashes: {}", e))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("Failed to read hash row: {}", e))
    }

    /// Drop image rows. The caller deletes the files first — see the module
    /// docs on why that order matters.
    pub fn delete_images(&self, hashes: &[String]) -> Result<(), String> {
        if hashes.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn();
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to open delete transaction: {}", e))?;
        {
            let mut stmt = tx
                .prepare("DELETE FROM images WHERE hash = ?1")
                .map_err(|e| format!("Failed to prepare image delete: {}", e))?;
            for hash in hashes {
                stmt.execute(params![hash])
                    .map_err(|e| format!("Failed to delete image: {}", e))?;
            }
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit image delete: {}", e))
    }
}
