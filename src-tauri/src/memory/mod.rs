//! Agentic memory: on-device embeddings and the vector maths around them.
//!
//! Deliberately free of `db` imports. The dependency runs one way — `db` may
//! call `memory`, never the reverse — the same direction `proxy`/`StatSink`
//! established, so the embedder stays testable without a database and the
//! schema stays ignorant of ONNX.
//!
//! See `plan/archive/agentic-memory/phase-01-rust-memory-core.md`.

pub mod embedder;

/// Dimensionality of BGE-small-en-v1.5, the model `embedder` loads.
///
/// Nothing in the storage path asserts this — a vector is stored and compared
/// at whatever width it arrives with, so the schema survives a model swap.
/// It exists for the tests that check the real model produces what we think,
/// and as the number to compare against when one is chosen later.
#[allow(dead_code)]
pub const EMBEDDING_DIM: usize = 384;

/// Encode a vector for the `memories.embedding` BLOB column.
///
/// Little-endian f32, no header: the row already records `embedding_model`,
/// which is what tells a reader how to interpret the bytes.
pub fn encode_embedding(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Decode a `memories.embedding` BLOB.
///
/// Returns None for a length that isn't a whole number of f32s — a truncated
/// blob would otherwise decode to a shorter vector and silently score against
/// everything as if it were a different fact.
pub fn decode_embedding(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// Cosine similarity, or None when the vectors can't be compared.
///
/// None rather than 0.0 for mismatched or zero-magnitude input: 0.0 is a
/// legitimate score meaning "unrelated", and a caller filtering on a minimum
/// score would silently treat corrupt rows as merely irrelevant.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> Option<f32> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a <= 0.0 || norm_b <= 0.0 {
        return None;
    }
    Some(dot / (norm_a.sqrt() * norm_b.sqrt()))
}

/// Milliseconds in a day, for the recency half-life below.
const DAY_MS: f64 = 86_400_000.0;

/// Half-life of the recency weighting, in days.
const RECENCY_HALF_LIFE_DAYS: f64 = 90.0;

/// Floor on the recency multiplier.
const RECENCY_FLOOR: f64 = 0.5;

/// How much a memory's age discounts its similarity score.
///
/// Decays from 1.0 to a floor of 0.5 with a 90-day half-life on
/// `last_seen_at`. Recency should break ties between comparably relevant
/// facts, never bury an old-but-true one — a floor of 0.5 means the oldest
/// memory in the store still outranks anything half as relevant.
pub fn recency_factor(last_seen_at_ms: i64, now_ms: i64) -> f32 {
    let age_days = ((now_ms - last_seen_at_ms) as f64 / DAY_MS).max(0.0);
    let decayed = 0.5f64.powf(age_days / RECENCY_HALF_LIFE_DAYS);
    (RECENCY_FLOOR + (1.0 - RECENCY_FLOOR) * decayed) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_codec_round_trips() {
        let v = vec![0.0, 1.0, -1.0, 0.5, f32::MIN_POSITIVE];
        assert_eq!(decode_embedding(&encode_embedding(&v)), Some(v));
    }

    #[test]
    fn decode_rejects_a_truncated_blob() {
        // Silently decoding to a shorter vector would score it against
        // everything as though it were simply a different fact.
        assert_eq!(decode_embedding(&[0u8; 6]), None);
        assert_eq!(decode_embedding(&[]), None);
    }

    #[test]
    fn cosine_is_one_for_identical_and_zero_for_orthogonal() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        assert!((cosine_similarity(&a, &a).unwrap() - 1.0).abs() < 1e-6);
        assert!(cosine_similarity(&a, &b).unwrap().abs() < 1e-6);
    }

    #[test]
    fn cosine_ignores_magnitude() {
        let a = vec![1.0, 2.0, 3.0];
        let scaled = vec![10.0, 20.0, 30.0];
        assert!((cosine_similarity(&a, &scaled).unwrap() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_is_none_rather_than_zero_for_uncomparable_input() {
        // 0.0 means "unrelated", which a min-score filter treats as a real
        // answer — corrupt rows must be distinguishable from irrelevant ones.
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0, 0.0, 0.0]), None);
        assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 0.0]), None);
        assert_eq!(cosine_similarity(&[], &[]), None);
    }

    #[test]
    fn recency_starts_at_one_and_decays_to_the_floor() {
        let now = 1_700_000_000_000i64;
        assert!((recency_factor(now, now) - 1.0).abs() < 1e-6);

        let half_life = now - (90.0 * DAY_MS) as i64;
        assert!((recency_factor(half_life, now) - 0.75).abs() < 1e-3);

        let ancient = now - (10_000.0 * DAY_MS) as i64;
        assert!((recency_factor(ancient, now) - 0.5).abs() < 1e-3);
    }

    #[test]
    fn recency_never_exceeds_one_for_a_future_timestamp() {
        // Clock skew across a restore or a timezone change must not let a
        // memory score above its own similarity.
        let now = 1_700_000_000_000i64;
        assert!(recency_factor(now + 5 * DAY_MS as i64, now) <= 1.0);
    }
}
