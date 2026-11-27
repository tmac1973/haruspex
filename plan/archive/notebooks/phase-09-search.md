# Phase 09 — Search: keyword UI and semantic search

**Depends on:** 01, 02, 03, 06 · **Enables:** 12 (web client search), 13 (peer
search)

## Goal
The search box in the notebook list searches every notebook and opens the
matching card, with the matching row or text highlighted. Keyword search
always works. With Settings → Notebooks → Semantic search on, the embedding
model is downloaded, cards are embedded in the background, and results merge
keyword and meaning-based hits. `notebook_search` for agents uses the same
merged search.

## Files touched
- `src-tauri/src/db/notebook_search.rs`:
  - `notebook_embed_pending(limit)` finds cards whose content hash differs
    from the stored one, chunks the card text, embeds each chunk, and stores
    it
    - chunks are about 800 characters on paragraph or row boundaries; a table
      chunk is a header plus about 20 rows
  - `notebook_search_semantic(query, limit)` is a brute-force cosine scan over
    `rows_with_vectors`, using the `memory::cosine_similarity`,
    `encode_embedding` and `decode_embedding` helpers, with no recency factor
    and a minimum similarity of 0.35
  - `notebook_search(query, limit, semantic)`:
    - runs both and merges with reciprocal-rank fusion (k = 60)
    - dedupes by card
    - returns the keyword snippet when there is one, else the chunk's first
      160 characters
  - writes into `notebook_embeddings`, created in phase 01; soft-deleted
    cards are skipped by search, and purges remove their rows (phase 01)
- `src-tauri/src/db/notebook_commands.rs`:
  - `notebook_search` (replaces direct UI use of `notebook_search_keyword`)
  - `notebook_embed_pending`
  - `notebook_semantic_status` returns `{model_present, pending}`
- `src-tauri/src/db/notebook_search.rs` takes the embed function as a
  parameter, `embed: &dyn Fn(&[String]) -> Result<Vec<Vec<f32>>, String>`.
  The commands pass `|t| embedder::embed(&dir, t)` using the
  `on_pool_with_model` pattern from `memory_commands.rs:29`, and tests pass a
  stub that hashes words into a 384-dimensional vector.
  `src-tauri/src/memory/embedder.rs` is unchanged; the model downloads
  through the existing `memory_download_model` command.
- `src/lib/stores/memory.svelte.ts`: `disableMemory()` does not call
  `memory_unload_model` while `settings.notebooks.semanticSearch` is on.
- `src/lib/components/settings/NotebooksSection.svelte` (new):
  - Settings → Notebooks, with the "Semantic search" toggle
  - switching it on calls `memory_download_model` with a progress line
  - shows "Indexing n cards…" while pending
- `src/lib/components/settings/categories.ts`: add `'notebooks'` to
  `Category`, after `'chat'`.
- `src/lib/components/settings/SettingsPanel.svelte`: list and render
  `NotebooksSection` for that category.
- `src/routes/+layout.svelte`: call `startNotebookIndexer()` in `onMount`,
  next to `startCardWatch` and `initMemory`.
- `src/lib/notebooks/indexer.svelte.ts` (new), exporting
  `startNotebookIndexer()`:
  - when semantic search is on and the model is present, calls
    `notebook_embed_pending(16)` 5 seconds after any `notebook-changed` event
    and at startup
  - keeps going while `pending > 0`, yielding between batches
- `src/lib/components/notebooks/NotebookList.svelte`:
  - the search box becomes live (300 ms debounce)
  - results replace the list, showing title, card and snippet with the match
    in bold
  - Enter or click opens `openNotebook(id, cardId)`, and a `row_id`
    highlights that row
- `src/lib/agent/tools/notebook.ts`: `notebook_search` calls
  `notebook_search` with `semantic` from settings.
- `docs/guide/notebooks.md`: "Find something" section; `docs/guide/settings.md`
  mentions Settings → Notebooks.

## Steps
1. Chunking, embedding and search in Rust, with tests. Embedding tests
   use a stub embedder behind a `cfg(test)` seam so CI needs no model.
2. Merged search command, and the UI switched to it.
3. Settings section, model download, and the indexer.
4. Memory's unload guard.

## Build gate
- `cd src-tauri && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` (no drift)
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Rust:
  - Chunking a 300-row table gives header-carrying chunks.
  - An unchanged content hash is skipped.
  - RRF merging dedupes and ranks a hit found by both searches first.
  - Delete cascades.
- Unit: the indexer's debounce and loop; Memory's unload guard.
- Manual:
  1. Keyword "battery" finds a table cell and highlights the row.
  2. Turn on semantic search: the model downloads and indexing finishes.
  3. "how long it plays unplugged" finds the battery-life card.
  4. Turn off Memory; notebook semantic search still works.
  5. In Chat, "what did I note about speakers?" uses `notebook_search`.

## Commit
`feat(notebooks): add notebook search with optional semantic results`

## Rollback
Revert the commit. `notebook_embeddings` rows stay and are ignored. The
setting key is ignored. Keyword search from phase 01 is unaffected.
