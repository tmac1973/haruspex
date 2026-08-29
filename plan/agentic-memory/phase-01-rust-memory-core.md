# Phase 01 — Rust memory core: schema, embedder, db module, IPC

**Depends on:** nothing · **Enables:** all later phases.

## Goal

All persistence and vector machinery lands, fully tested, with no user-facing
behaviour change. After this phase the app has `memory_*` IPC commands that
the frontend does not call yet.

## Files touched

- **EDIT** `src-tauri/src/db/mod.rs` — schema + migration:
  - `CREATE TABLE IF NOT EXISTS memories (
       id TEXT PRIMARY KEY,
       content TEXT NOT NULL,
       category TEXT NOT NULL DEFAULT 'fact',
       embedding BLOB NOT NULL,
       embedding_model TEXT NOT NULL,
       source_conversation_id TEXT,
       created_at INTEGER NOT NULL,
       last_seen_at INTEGER NOT NULL,
       use_count INTEGER NOT NULL DEFAULT 0
     )` in the `execute_batch`. No FK on `source_conversation_id` — the
    memory must outlive its source conversation (deleting a chat must not
    delete what was learned; incognito is the tool for that).
  - Idempotent `ALTER TABLE` loop additions:
    `conversations.memory_enabled INTEGER NOT NULL DEFAULT 1` and
    `conversations.memory_extracted_to INTEGER NOT NULL DEFAULT -1`
    (max message `sort_order` already extracted). Both live here from day
    one so Phases 03–05 need no further migration.
  - Row structs: `Memory` (with `embedding` deliberately **not** serialized
    to the frontend — split a `MemoryMeta` view struct for IPC).
- **NEW** `src-tauri/src/memory/mod.rs` + `src-tauri/src/memory/embedder.rs`
  — fastembed wrapper:
  - `fastembed` crate, `BGESmallENV15` (384-dim). Lazy `OnceCell<Mutex<TextEmbedding>>`;
    init sets `cache_dir` to `<app_data_dir>/models/embeddings` and
    `show_download_progress` off (we surface progress ourselves, Phase 02).
  - `embed(texts: &[String]) -> Result<Vec<Vec<f32>>>`, plus
    `model_present(app_dir) -> bool` (pure file check, no init) and
    `ensure_model(app_dir) -> Result<()>` (triggers the download; only ever
    called from the consent flow command in Phase 02).
  - Cosine helpers + BLOB encode/decode (f32 little-endian). Keep this
    module free of db imports (mirror the `proxy`/`StatSink` direction:
    `db` may call `memory`, never the reverse).
- **NEW** `src-tauri/src/db/memories.rs` — queries, all taking `&Connection`:
  - `insert_memory`, `list_memories(offset, limit, filter)`, `update_memory_content`
    (re-embeds), `delete_memory`, `delete_all_memories`, `count_memories`.
  - `search_memories(conn, query_embedding, k, min_score)` — load
    `(id, embedding)` for all rows, brute-force cosine, rerank by
    `score * recency_factor(last_seen_at)`, return top-k `MemoryMeta` +
    score; bump `use_count`/`last_seen_at` on the returned rows.
  - `find_similar(conn, embedding, threshold)` — dedupe primitive for
    Phase 03.
  - Watermark + flag accessors on conversations:
    `get_memory_cursor(conversation_id) -> (memory_enabled, memory_extracted_to)`,
    `set_memory_extracted_to`, `set_memory_enabled`.
- **NEW** commands in `src-tauri/src/db/commands.rs` (same `on_pool` /
  `spawn_blocking` shape as every existing db command):
  `memory_add(content, category, source_conversation_id)` (embeds + inserts),
  `memory_search(query: String, k, min_score)` (embeds query + searches),
  `memory_list`, `memory_update`, `memory_delete`, `memory_delete_all`,
  `memory_count`, `memory_find_similar(content)`,
  `conversation_set_memory_enabled`, `conversation_set_memory_extracted_to`.
  Embedding happens inside `spawn_blocking` — fastembed inference is
  CPU-bound and must never touch the main thread (see the arboard lesson).
- **EDIT** `src-tauri/src/lib.rs` — register commands in `generate_handler!`.
- **RUN** `scripts/export-ipc-types.sh`; commit `src/lib/ipc/` output.
- **EDIT** `src-tauri/src/db/tests.rs` — insert/search/dedupe/watermark
  round-trips. Embedder tests that need the ONNX model are `#[ignore]`d
  (CI has no model); cosine/BLOB codec tests run everywhere with synthetic
  vectors.

## Implementation notes

- **Search cost check**: 5k memories × 384 f32 = ~7.5 MB scanned per search;
  sub-millisecond on any target machine. No index, no sqlite-vec. Revisit
  only past ~50k rows.
- `recency_factor`: gentle half-life (e.g. 90 days on `last_seen_at`),
  floor 0.5 — recency should break ties, not bury old-but-true facts.
  Constant lives in one place; Phase 04 tunes it.
- `embedding_model` column is written on every insert; `search_memories`
  filters `WHERE embedding_model = current` so a future model swap degrades
  to "old memories invisible until re-embedded", never to garbage cosine.
- `Cargo.toml`: `fastembed` pulls `ort` (ONNX Runtime). **Resolved
  2026-08-21**: the default download-binaries strategy links ONNX Runtime
  statically, so nothing has to be bundled or symlinked — at +30.3 MB on the
  release binary (52.2 → 82.5). Accepted (D6). Declared
  `default-features = false` with the rustls variants, because fastembed's
  `native-tls` default would pull OpenSSL into an otherwise rustls-only tree.
  Documented in `maintenance.md` §11c.

## Acceptance

- `cargo test` green including new db tests; `cargo clippy -D warnings`.
- With a locally downloaded model: an ignored test embeds two paraphrases +
  one unrelated sentence and asserts cosine(paraphrases) > cosine(unrelated).
- `memory_*` commands callable from devtools console via `invoke`; app
  behaviour otherwise unchanged.
- `scripts/check-ipc.mjs` passes.
