//! Semantic (meaning-based) notebook search, when Settings → Notebooks →
//! Semantic search is on. Cards are cut into chunks of about 800
//! characters (a table into its header plus about 20 rows), each embedded
//! with the model Memory uses and stored in `notebook_embeddings`; a query
//! is embedded the same way and scored against them all. A card is
//! re-embedded when its text changes (its content hash differs).
//!
//! The embed function is passed in, so tests need no model.

use super::notebook_search::NotebookSearchHit;
use super::*;
use rusqlite::{params, Connection};

/// What embeds texts: the real model in the app, a stub in tests.
pub type EmbedFn<'a> = &'a dyn Fn(&[String]) -> Result<Vec<Vec<f32>>, String>;

const CHUNK_CHARS: usize = 800;
const ROWS_PER_CHUNK: usize = 20;
/// Below this a chunk isn't about the query.
const MIN_SIMILARITY: f32 = 0.35;
/// Reciprocal-rank fusion's constant.
const RRF_K: f64 = 60.0;

fn json_values(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) if !s.is_empty() => out.push(s.clone()),
        serde_json::Value::Number(n) => out.push(n.to_string()),
        serde_json::Value::Bool(b) => out.push(b.to_string()),
        serde_json::Value::Array(a) => a.iter().for_each(|x| json_values(x, out)),
        serde_json::Value::Object(o) => o.values().for_each(|x| json_values(x, out)),
        _ => {}
    }
}

/// Split text into pieces of about `CHUNK_CHARS`, on paragraph breaks where
/// it can and on character boundaries where it must.
pub(super) fn split_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for para in text.split("\n\n") {
        if cur.chars().count() + para.chars().count() > CHUNK_CHARS && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        if para.chars().count() > CHUNK_CHARS {
            let chars: Vec<char> = para.chars().collect();
            for piece in chars.chunks(CHUNK_CHARS) {
                out.push(piece.iter().collect());
            }
            continue;
        }
        if !cur.is_empty() {
            cur.push_str("\n\n");
        }
        cur.push_str(para);
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

/// A card's chunks, each led by where it is ("Speakers / Models").
pub(super) fn card_chunks(conn: &Connection, card_id: &str) -> Result<Vec<String>, String> {
    let (nb_title, kind, title, body, meta): (String, String, String, String, String) = conn
        .query_row(
            "SELECT n.title, c.kind, c.title, c.body, c.meta FROM notebook_cards c
             JOIN notebooks n ON n.id = c.notebook_id WHERE c.id = ?1",
            params![card_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|e| format!("Card read failed: {e}"))?;
    let head = if title.is_empty() {
        nb_title.clone()
    } else {
        format!("{nb_title} / {title}")
    };
    let meta: serde_json::Value = serde_json::from_str(&meta).unwrap_or_default();
    let pieces: Vec<String> = match kind.as_str() {
        "text" | "python" => split_text(&body),
        "attachment" | "image" => meta
            .get("name")
            .and_then(|v| v.as_str())
            .map(|n| vec![n.to_string()])
            .unwrap_or_default(),
        _ => {
            let mut stmt = conn
                .prepare("SELECT cells FROM notebook_rows WHERE card_id = ?1 ORDER BY position")
                .map_err(|e| format!("Row read failed: {e}"))?;
            let rows: Vec<String> = stmt
                .query_map(params![card_id], |r| r.get::<_, String>(0))
                .map_err(|e| format!("Row read failed: {e}"))?
                .filter_map(Result::ok)
                .map(|cells| {
                    let mut vals = Vec::new();
                    json_values(&serde_json::from_str(&cells).unwrap_or_default(), &mut vals);
                    vals.join(" | ")
                })
                .collect();
            let mut cols = Vec::new();
            if let Some(list) = meta.get("columns").and_then(|c| c.as_array()) {
                for c in list {
                    if let Some(n) = c.get("name").and_then(|v| v.as_str()) {
                        cols.push(n.to_string());
                    }
                }
            }
            let header = cols.join(" | ");
            rows.chunks(ROWS_PER_CHUNK)
                .map(|chunk| format!("{header}\n{}", chunk.join("\n")))
                .collect()
        }
    };
    Ok(pieces
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| format!("{head}\n{p}"))
        .collect())
}

fn content_hash(chunks: &[String]) -> String {
    crate::blob_cache::hash_bytes(chunks.join("\u{1e}").as_bytes())
}

impl Database {
    /// Live cards whose embeddings are missing or out of date, in no order.
    fn notebook_stale_cards(
        &self,
        model: &str,
    ) -> Result<Vec<(String, String, Vec<String>)>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.notebook_id,
                        (SELECT content_hash FROM notebook_embeddings e
                         WHERE e.card_id = c.id AND e.embedding_model = ?1 LIMIT 1)
                 FROM notebook_cards c JOIN notebooks n ON n.id = c.notebook_id
                 WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL",
            )
            .map_err(|e| format!("Embedding scan failed: {e}"))?;
        let cards: Vec<(String, String, Option<String>)> = stmt
            .query_map(params![model], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| format!("Embedding scan failed: {e}"))?
            .collect::<Result<_, _>>()
            .map_err(|e| format!("Embedding scan failed: {e}"))?;
        let mut stale = Vec::new();
        for (id, nb, stored) in cards {
            let chunks = card_chunks(&conn, &id)?;
            let hash = content_hash(&chunks);
            if stored.as_deref() != Some(hash.as_str()) {
                stale.push((id, nb, chunks));
            }
        }
        Ok(stale)
    }

    /// Embed up to `limit` cards whose text changed. Returns how many still wait.
    pub fn notebook_embed_pending(
        &self,
        embed: EmbedFn<'_>,
        model: &str,
        limit: usize,
    ) -> Result<usize, String> {
        let stale = self.notebook_stale_cards(model)?;
        let remaining = stale.len().saturating_sub(limit);
        for (card_id, notebook_id, chunks) in stale.into_iter().take(limit) {
            let vectors = if chunks.is_empty() {
                Vec::new()
            } else {
                embed(&chunks)?
            };
            let hash = content_hash(&chunks);
            let mut conn = self.conn();
            let tx = conn
                .transaction()
                .map_err(|e| format!("Transaction failed: {e}"))?;
            tx.execute(
                "DELETE FROM notebook_embeddings WHERE card_id = ?1",
                params![card_id],
            )
            .map_err(|e| format!("Embedding delete failed: {e}"))?;
            if chunks.is_empty() {
                // An empty card: a row with no vector marks it as done.
                tx.execute(
                    "INSERT INTO notebook_embeddings
                     (card_id, chunk, notebook_id, text, embedding, embedding_model, content_hash)
                     VALUES (?1, -1, ?2, '', x'', ?3, ?4)",
                    params![card_id, notebook_id, model, hash],
                )
                .map_err(|e| format!("Embedding insert failed: {e}"))?;
            }
            for (i, (text, v)) in chunks.iter().zip(vectors.iter()).enumerate() {
                tx.execute(
                    "INSERT INTO notebook_embeddings
                     (card_id, chunk, notebook_id, text, embedding, embedding_model, content_hash)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        card_id,
                        i as i64,
                        notebook_id,
                        text,
                        crate::memory::encode_embedding(v),
                        model,
                        hash
                    ],
                )
                .map_err(|e| format!("Embedding insert failed: {e}"))?;
            }
            tx.commit().map_err(|e| format!("Commit failed: {e}"))?;
        }
        Ok(remaining)
    }

    /// How many cards wait to be embedded.
    pub fn notebook_embed_pending_count(&self, model: &str) -> Result<usize, String> {
        Ok(self.notebook_stale_cards(model)?.len())
    }

    /// Cards whose chunks mean something like `query`, best first, one hit per card.
    pub fn notebook_search_semantic(
        &self,
        embed: EmbedFn<'_>,
        model: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<NotebookSearchHit>, String> {
        let q = embed(&[query.to_string()])?
            .into_iter()
            .next()
            .ok_or("No embedding for the query")?;
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT e.card_id, e.notebook_id, n.title, c.title, c.kind, e.text, e.embedding
                 FROM notebook_embeddings e
                 JOIN notebook_cards c ON c.id = e.card_id
                 JOIN notebooks n ON n.id = e.notebook_id
                 WHERE e.embedding_model = ?1 AND e.chunk >= 0
                   AND c.deleted_at IS NULL AND n.deleted_at IS NULL",
            )
            .map_err(|e| format!("Search failed: {e}"))?;
        let mut best: std::collections::HashMap<String, NotebookSearchHit> = Default::default();
        let rows = stmt
            .query_map(params![model], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Vec<u8>>(6)?,
                ))
            })
            .map_err(|e| format!("Search failed: {e}"))?;
        for row in rows {
            let (card_id, nb_id, nb_title, card_title, kind, text, blob) =
                row.map_err(|e| format!("Search failed: {e}"))?;
            let Some(v) = crate::memory::decode_embedding(&blob) else {
                continue;
            };
            let Some(sim) = crate::memory::cosine_similarity(&q, &v) else {
                continue;
            };
            if sim < MIN_SIMILARITY {
                continue;
            }
            let better = best.get(&card_id).is_none_or(|h| (sim as f64) > h.score);
            if better {
                // The chunk without its "Notebook / Card" lead line.
                let body = text.split_once('\n').map(|(_, b)| b).unwrap_or(&text);
                let snippet: String = body.chars().take(160).collect();
                best.insert(
                    card_id.clone(),
                    NotebookSearchHit {
                        notebook_id: nb_id,
                        notebook_title: nb_title,
                        card_id: Some(card_id),
                        card_title: Some(card_title),
                        card_kind: Some(kind),
                        row_id: None,
                        snippet,
                        score: sim as f64,
                    },
                );
            }
        }
        let mut hits: Vec<NotebookSearchHit> = best.into_values().collect();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(limit);
        Ok(hits)
    }
}

/// Keyword and semantic hits as one list: reciprocal-rank fusion, one hit
/// per card (a keyword hit's row and highlighted snippet win).
pub fn merge_hits(
    keyword: Vec<NotebookSearchHit>,
    semantic: Vec<NotebookSearchHit>,
    limit: usize,
) -> Vec<NotebookSearchHit> {
    let key = |h: &NotebookSearchHit| {
        h.card_id
            .clone()
            .unwrap_or_else(|| format!("nb:{}", h.notebook_id))
    };
    let mut merged: Vec<(String, f64, NotebookSearchHit)> = Vec::new();
    for list in [keyword, semantic] {
        let mut seen = std::collections::HashSet::new();
        let mut rank = 0usize;
        for h in list {
            let k = key(&h);
            if !seen.insert(k.clone()) {
                continue;
            }
            rank += 1;
            let score = 1.0 / (RRF_K + rank as f64);
            match merged.iter_mut().find(|(mk, _, _)| *mk == k) {
                Some(entry) => entry.1 += score,
                None => merged.push((k, score, h)),
            }
        }
    }
    merged.sort_by(|a, b| b.1.total_cmp(&a.1));
    merged
        .into_iter()
        .take(limit)
        .map(|(_, score, mut h)| {
            h.score = score;
            h
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::notebooks::NewCard;
    use super::*;

    const USER: &str = r#"{"kind":"user"}"#;

    /// Words hashed into a fixed-width vector: texts sharing words score high.
    fn stub(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        Ok(texts
            .iter()
            .map(|t| {
                let mut v = vec![0f32; 384];
                for w in t.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
                    if w.is_empty() {
                        continue;
                    }
                    let h = crate::blob_cache::hash_bytes(w.as_bytes());
                    let i = usize::from_str_radix(&h[..4], 16).unwrap() % 384;
                    v[i] += 1.0;
                }
                v
            })
            .collect())
    }

    fn text(body: &str) -> NewCard {
        NewCard {
            kind: "text".into(),
            title: String::new(),
            body: body.into(),
            meta: "{}".into(),
            rows: None,
        }
    }

    #[test]
    fn tables_chunk_with_their_header() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("N", &[]).unwrap();
        let rows: Vec<String> = (0..45).map(|i| format!(r#"{{"a":"item {i}"}}"#)).collect();
        let c = db
            .notebook_card_add(
                &nb.id,
                None,
                &NewCard {
                    kind: "table".into(),
                    title: "T".into(),
                    body: String::new(),
                    meta: r#"{"columns":[{"id":"a","name":"Thing","type":"text"}]}"#.into(),
                    rows: Some(rows),
                },
                USER,
            )
            .unwrap();
        let chunks = card_chunks(&db.conn(), &c.id).unwrap();
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|ch| ch.starts_with("N / T\nThing\n")));
    }

    #[test]
    fn unchanged_cards_are_skipped_and_edits_re_embed() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("N", &[]).unwrap();
        let c = db
            .notebook_card_add(&nb.id, None, &text("battery life"), USER)
            .unwrap();
        db.notebook_card_add(&nb.id, None, &text(""), USER).unwrap();
        assert_eq!(db.notebook_embed_pending_count("m").unwrap(), 2);
        assert_eq!(db.notebook_embed_pending(&stub, "m", 16).unwrap(), 0);
        assert_eq!(db.notebook_embed_pending_count("m").unwrap(), 0);
        db.notebook_card_update(
            &c.id,
            c.version,
            None,
            Some("longer battery life"),
            None,
            USER,
        )
        .unwrap();
        assert_eq!(db.notebook_embed_pending_count("m").unwrap(), 1);
    }

    #[test]
    fn finds_by_meaning_and_skips_trash() {
        let db = Database::open_in_memory();
        let nb = db.notebook_create("Speakers", &[]).unwrap();
        let c = db
            .notebook_card_add(
                &nb.id,
                None,
                &text("how long the battery lasts unplugged"),
                USER,
            )
            .unwrap();
        db.notebook_card_add(&nb.id, None, &text("bass and treble"), USER)
            .unwrap();
        db.notebook_embed_pending(&stub, "m", 16).unwrap();
        let hits = db
            .notebook_search_semantic(&stub, "m", "battery unplugged", 10)
            .unwrap();
        assert_eq!(hits[0].card_id.as_deref(), Some(c.id.as_str()));
        db.notebook_card_set_deleted(&c.id, true).unwrap();
        let hits = db
            .notebook_search_semantic(&stub, "m", "battery unplugged", 10)
            .unwrap();
        assert!(hits
            .iter()
            .all(|h| h.card_id.as_deref() != Some(c.id.as_str())));
    }

    fn hit(card: &str) -> NotebookSearchHit {
        NotebookSearchHit {
            notebook_id: "n".into(),
            notebook_title: "N".into(),
            card_id: Some(card.into()),
            card_title: None,
            card_kind: None,
            row_id: None,
            snippet: card.into(),
            score: 0.0,
        }
    }

    #[test]
    fn a_hit_in_both_lists_ranks_first() {
        let merged = merge_hits(vec![hit("a"), hit("b")], vec![hit("c"), hit("b")], 10);
        assert_eq!(merged[0].card_id.as_deref(), Some("b"));
        assert_eq!(merged.len(), 3);
    }

    #[test]
    fn long_text_splits_on_paragraphs() {
        let para = "word ".repeat(100);
        let chunks = split_text(&format!("{para}\n\n{para}\n\n{para}"));
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| c.chars().count() <= 1200));
    }
}
