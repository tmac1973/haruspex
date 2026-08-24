//! Agentic-memory persistence: store, search, dedupe, and the per-conversation
//! extraction cursor.
//!
//! Search is a brute-force cosine scan. 5k memories × 384 f32 is ~7.5 MB read
//! and compared per query — sub-millisecond on any machine this app targets,
//! and it keeps the schema plain SQLite with no vector extension to ship.
//! Revisit past ~50k rows.
//!
//! Embedding is the caller's job (the command layer, inside `spawn_blocking`).
//! This module only ever sees vectors, which is what keeps `db` free of an
//! ONNX dependency and lets every query here be tested with synthetic ones.

use super::*;
use crate::memory::{cosine_similarity, decode_embedding, encode_embedding, recency_factor};
use rusqlite::params;

/// Columns every `MemoryMeta` read needs, in the order `read_meta` expects.
const META_COLUMNS: &str =
    "id, content, category, source_conversation_id, created_at, last_seen_at, use_count";

fn read_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryMeta> {
    Ok(MemoryMeta {
        id: row.get(0)?,
        content: row.get(1)?,
        category: row.get(2)?,
        source_conversation_id: row.get(3)?,
        created_at: row.get(4)?,
        last_seen_at: row.get(5)?,
        use_count: row.get(6)?,
    })
}

impl Database {
    /// Store one fact. Returns its id.
    ///
    /// `id` is generated here rather than by the caller so the frontend never
    /// has to invent one, and `created_at`/`last_seen_at` start equal — a
    /// brand-new memory is by definition as fresh as it will ever be.
    pub fn insert_memory(
        &self,
        content: &str,
        category: &str,
        embedding: &[f32],
        embedding_model: &str,
        source_conversation_id: Option<&str>,
        now: i64,
    ) -> Result<String, String> {
        let id = format!("mem-{}-{}", now, fastrand_suffix());
        let conn = self.conn();
        conn.execute(
            "INSERT INTO memories
                (id, content, category, embedding, embedding_model,
                 source_conversation_id, created_at, last_seen_at, use_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 0)",
            params![
                id,
                content,
                category,
                encode_embedding(embedding),
                embedding_model,
                source_conversation_id,
                now
            ],
        )
        .map_err(|e| format!("Memory insert failed: {}", e))?;
        Ok(id)
    }

    pub fn count_memories(&self) -> Result<i64, String> {
        let conn = self.conn();
        conn.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
            .map_err(|e| format!("Memory count failed: {}", e))
    }

    /// Newest first, optionally filtered by a content substring.
    ///
    /// Ordered by `created_at` rather than relevance because this backs the
    /// manager UI, where "what did it learn recently" is the question being
    /// asked; relevance ordering belongs to `search_memories`.
    pub fn list_memories(
        &self,
        offset: i64,
        limit: i64,
        filter: Option<&str>,
    ) -> Result<Vec<MemoryMeta>, String> {
        let conn = self.conn();
        let like = filter
            .map(|f| format!("%{}%", f.trim()))
            .filter(|f| f.len() > 2);
        let sql = format!(
            "SELECT {META_COLUMNS} FROM memories
             {}
             ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
            if like.is_some() {
                "WHERE content LIKE ?3"
            } else {
                ""
            }
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("Memory list failed: {}", e))?;
        let rows = match &like {
            Some(f) => stmt.query_map(params![limit, offset, f], read_meta),
            None => stmt.query_map(params![limit, offset], read_meta),
        }
        .map_err(|e| format!("Memory list failed: {}", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Memory row read failed: {}", e))
    }

    /// Replace a memory's text and its vector together.
    ///
    /// Both or neither: content and embedding are two representations of the
    /// same fact, and a row whose text says one thing while its vector says
    /// another is recalled for the wrong queries and shown as the wrong
    /// answer. The caller re-embeds before calling.
    pub fn update_memory_content(
        &self,
        id: &str,
        content: &str,
        embedding: &[f32],
        embedding_model: &str,
    ) -> Result<bool, String> {
        let conn = self.conn();
        let n = conn
            .execute(
                "UPDATE memories SET content = ?1, embedding = ?2, embedding_model = ?3
                 WHERE id = ?4",
                params![content, encode_embedding(embedding), embedding_model, id],
            )
            .map_err(|e| format!("Memory update failed: {}", e))?;
        Ok(n > 0)
    }

    pub fn delete_memory(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn();
        let n = conn
            .execute("DELETE FROM memories WHERE id = ?1", params![id])
            .map_err(|e| format!("Memory delete failed: {}", e))?;
        Ok(n > 0)
    }

    pub fn delete_all_memories(&self) -> Result<i64, String> {
        let conn = self.conn();
        let n = conn
            .execute("DELETE FROM memories", [])
            .map_err(|e| format!("Memory clear failed: {}", e))?;
        Ok(n as i64)
    }

    /// Top-k memories for a query vector, reranked by age.
    ///
    /// `min_similarity` is applied to raw cosine, BEFORE the recency discount:
    /// the threshold is answering "is this fact about the same thing", which
    /// has nothing to do with how old it is. Recency then breaks ties among
    /// the survivors.
    ///
    /// Rows embedded by a different model are skipped, not compared — cosine
    /// between two embedding spaces is a number with no meaning, and acting
    /// on it would be worse than recalling nothing.
    pub fn search_memories(
        &self,
        query: &[f32],
        embedding_model: &str,
        k: usize,
        min_similarity: f32,
        now: i64,
    ) -> Result<Vec<MemoryHit>, String> {
        let mut hits = self.score_all(query, embedding_model, min_similarity, now)?;
        // Descending score; NaN cannot appear (cosine_similarity rejects
        // zero-magnitude vectors) but total_cmp keeps the sort total anyway.
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(k);
        self.mark_used(&hits, now)?;
        Ok(hits)
    }

    /// The dedupe primitive: the single closest memory above `threshold`.
    ///
    /// Extraction asks "have I already been told this?", so it wants the best
    /// match and nothing else. Unlike search, this does NOT bump usage
    /// counters — deciding not to store a duplicate is not the memory being
    /// used, and counting it would inflate the recall stats the manager shows.
    pub fn find_similar(
        &self,
        embedding: &[f32],
        embedding_model: &str,
        threshold: f32,
        now: i64,
    ) -> Result<Option<MemoryHit>, String> {
        let mut hits = self.score_all(embedding, embedding_model, threshold, now)?;
        hits.sort_by(|a, b| b.similarity.total_cmp(&a.similarity));
        Ok(hits.into_iter().next())
    }

    /// Bump `last_seen_at` and `use_count` — a duplicate fact re-observed is
    /// evidence the fact is still current, which is exactly what the recency
    /// rerank should reward.
    pub fn touch_memory(&self, id: &str, now: i64) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "UPDATE memories SET last_seen_at = ?1, use_count = use_count + 1 WHERE id = ?2",
            params![now, id],
        )
        .map_err(|e| format!("Memory touch failed: {}", e))?;
        Ok(())
    }

    /// Score every stored memory against `query`, keeping those at or above
    /// `min_similarity`. Shared by search and dedupe so the two can never
    /// disagree about what "similar" means.
    fn score_all(
        &self,
        query: &[f32],
        embedding_model: &str,
        min_similarity: f32,
        now: i64,
    ) -> Result<Vec<MemoryHit>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {META_COLUMNS}, embedding FROM memories WHERE embedding_model = ?1"
            ))
            .map_err(|e| format!("Memory search failed: {}", e))?;
        let rows = stmt
            .query_map(params![embedding_model], |row| {
                Ok((read_meta(row)?, row.get::<_, Vec<u8>>(7)?))
            })
            .map_err(|e| format!("Memory search failed: {}", e))?;

        let mut hits = Vec::new();
        for row in rows {
            let (meta, blob) = row.map_err(|e| format!("Memory row read failed: {}", e))?;
            // A row whose vector is unreadable or the wrong width is skipped
            // rather than scored: there is no honest similarity to report, and
            // a wrong one would be indistinguishable from a real weak match.
            let Some(vector) = decode_embedding(&blob) else {
                continue;
            };
            let Some(similarity) = cosine_similarity(query, &vector) else {
                continue;
            };
            if similarity < min_similarity {
                continue;
            }
            let score = similarity * recency_factor(meta.last_seen_at, now);
            hits.push(MemoryHit {
                memory: meta,
                score,
                similarity,
            });
        }
        Ok(hits)
    }

    fn mark_used(&self, hits: &[MemoryHit], now: i64) -> Result<(), String> {
        for hit in hits {
            self.touch_memory(&hit.memory.id, now)?;
        }
        Ok(())
    }

    /// The conversation's incognito flag and extraction watermark.
    ///
    /// A conversation that no longer exists reads as memory-disabled with
    /// nothing extracted: the extraction scheduler races deletion, and
    /// "process this vanished chat" is the wrong default for a privacy
    /// feature.
    pub fn get_memory_cursor(&self, conversation_id: &str) -> Result<MemoryCursor, String> {
        let conn = self.conn();
        conn.query_row(
            "SELECT memory_enabled, memory_extracted_to FROM conversations WHERE id = ?1",
            params![conversation_id],
            |row| {
                Ok(MemoryCursor {
                    memory_enabled: row.get::<_, i64>(0)? != 0,
                    memory_extracted_to: row.get(1)?,
                })
            },
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(MemoryCursor {
                memory_enabled: false,
                memory_extracted_to: -1,
            }),
            other => Err(format!("Memory cursor read failed: {}", other)),
        })
    }

    pub fn set_memory_enabled(&self, conversation_id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "UPDATE conversations SET memory_enabled = ?1 WHERE id = ?2",
            params![if enabled { 1 } else { 0 }, conversation_id],
        )
        .map_err(|e| format!("Memory flag update failed: {}", e))?;
        Ok(())
    }

    /// Advance the watermark, never retreat it.
    ///
    /// Two extraction passes can overlap (an idle timer firing as the user
    /// switches away), and the later-finishing one may hold the older cursor.
    /// Taking the max means a stale writer cannot cause the same turns to be
    /// distilled again.
    pub fn set_memory_extracted_to(
        &self,
        conversation_id: &str,
        sort_order: i64,
    ) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "UPDATE conversations SET memory_extracted_to = MAX(memory_extracted_to, ?1)
             WHERE id = ?2",
            params![sort_order, conversation_id],
        )
        .map_err(|e| format!("Memory watermark update failed: {}", e))?;
        Ok(())
    }
}

/// Short random suffix for a memory id.
///
/// Ids are `mem-<millis>-<suffix>`: the timestamp keeps them roughly ordered
/// and greppable, and the suffix separates the several facts one extraction
/// pass inserts inside the same millisecond.
fn fastrand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:06x}", nanos % 0x100_0000)
}
