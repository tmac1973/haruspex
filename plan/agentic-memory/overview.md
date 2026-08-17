# Agentic Memory — Project Overview

**Status:** Planning only — no implementation yet. · **Type:** New feature (cross-session memory: extract → store → recall). · Meant to be read, argued with, and edited before any code gets written.

---

## Problem

Every chat starts cold. Facts the user has already established — preferences,
recurring project context, corrections — must be re-stated per conversation.
The app already acknowledges this inside a single chat: compaction
(`src/lib/agent/compaction.ts`) summarizes at 80% context and its prompt
explicitly preserves "key facts, decisions, user preferences" — but that
summary dies with the conversation. There is no cross-session carry-over.

A survey of pre-built memory libraries (Mem0, Letta, Zep/Graphiti, LangMem,
cognee, Hindsight, plus every Rust crate in the space, 2026-08) concluded
none is shippable here: all mature options are Python (often plus
Postgres/Neo4j/Docker), and every Rust-native attempt is a weeks-old solo
project. The algorithm, however, is small and well documented (Mem0 v2's
single-pass recipe): extract facts with one LLM call, embed, dedupe by cosine
similarity, store with timestamps, retrieve top-k at prompt time. We build
that bespoke from mature pieces we already have or can embed.

## Goals

- **A `memories` table in the existing SQLite db** — one fact per row with an
  embedding BLOB, provenance (source conversation), and recency metadata.
  Follows every existing `db/` pattern (rusqlite, `spawn_blocking` command
  wrappers, idempotent migration, IPC type regeneration).
- **In-process embeddings via the `fastembed` crate** (ONNX, pure Rust) —
  no new sidecar, no `--embeddings` flag on llama-server, no contention with
  the single inference slot, identical behaviour for local and remote chat
  backends. Model (~34 MB) downloaded once with explicit user consent.
- **Background extraction on idle + chat-switch** via the existing
  `runEphemeralTurn` + `withInferenceSlot` machinery, using a forced
  structured-output `submit_memories` tool (the audit/planning pattern).
- **Recall injected at the existing prompt seam**: top-k relevant memories
  become one more conditional section of `buildSystemPrompt`, under a token
  budget, merged legally via `mergeLeadingSystemMessages`.
- **Two-layer off-switch**: a global enable in Settings, plus a **persisted
  per-chat incognito toggle** (`conversations.memory_enabled`) — incognito
  means *no recall in AND no recording out*, surviving app restart.
- **Full trust surface**: a memories manager in Settings (list, search, edit,
  delete, clear-all) and in-chat visibility of exactly which memories were
  injected into a turn, with per-memory delete.

## Non-goals

- **No graph memory, no LLM reconciliation pass.** v1 is ADD-only extraction
  with cosine-similarity dedupe (Mem0 v2's own simplification). An
  UPDATE/DELETE arbitration call can be layered on later if stale facts
  become a real problem.
- **No project/working-dir scoping.** Memories are global to the user
  (Decision D5). Retrieval relevance is the filter. A `scope` column is easy
  to add later; designing classification rules now is speculative.
- **Chat only.** Job pipelines (research/audit/coding) neither read nor write
  memories in v1.
- **No FTS5 / hybrid retrieval.** Cosine over a few thousand rows is
  brute-force fine; add lexical fusion only if recall quality demands it.
- **No third-party memory library or memory sidecar.** See survey above.

## Architecture

```
        ┌────────────────────────── frontend (TS) ──────────────────────────┐
        │                                                                   │
 chat ──┤ buildApiPrompt ── buildSystemPrompt + [MEMORY section] ──► LLM    │
        │        ▲                                                          │
        │        │ memory_search(query_embedding → top-k)                   │
        │        │                                                          │
 idle / │ extraction trigger ── runEphemeralTurn(submit_memories)           │
 switch │        │                    │ facts[]                             │
        └────────┼────────────────────┼─────────────────────────────────────┘
                 │ IPC                │ IPC
        ┌────────┴────────────────────┴────────────── Rust ─────────────────┐
        │ db/memories.rs ◄── memory::embedder (fastembed, lazy singleton)   │
        │ memories table: id, content, category, embedding BLOB,            │
        │   source_conversation_id, created_at, last_seen_at, use_count     │
        └───────────────────────────────────────────────────────────────────┘
```

- **Rust owns embed + store + search.** The frontend never sees an embedding;
  IPC commands take/return text and memory rows. `memory_search(text, k)`
  embeds the query and does brute-force cosine + recency rerank in one call.
- **TS owns extraction and injection** — it is where the prompt, the backend
  descriptor, and the inference queue already live. Extraction reads the
  conversation from the **db** (not the possibly-compacted in-memory
  history), so facts survive even after compaction has summarized them away.
- **Watermark, not re-reading**: `conversations.memory_extracted_to` records
  the max message `sort_order` already processed, so each extraction pass
  only sees new turns and re-extraction is idempotent-ish.

## Decisions (settled 2026-08-12)

- **D1 — Retrieval: fastembed in Rust.** In-process ONNX embeddings
  (`fastembed` crate, BGE-small-en-v1.5, 384-dim, ~34 MB). Rejected:
  llama-server `--embeddings`/router mode (server config churn, slot/VRAM
  contention, remote backends lack the endpoint); FTS5-only (lexical recall
  misses paraphrase).
- **D2 — Extraction timing: idle + chat-switch.** ~2 min after the last
  finalized turn, or when the user switches away from a conversation with
  unextracted turns. Runs behind `withInferenceSlot`, never competing with an
  active user turn. Rejected: per-turn (latency tax on a single-slot server);
  manual-only (memory stays sparse).
- **D3 — Off-switch: global toggle + persisted per-chat incognito.** One
  switch per chat, browser-incognito semantics (no recall, no record),
  persisted as a column so it survives restart. Rejected: split recall/record
  toggles (more UI for a refinement that can come later); session-only pill
  (privacy footgun after restart).
- **D4 — UI: full manager + in-chat visibility.** Settings manager plus a
  per-turn indicator of injected memories with per-memory delete. "Why did it
  say that?" must be answerable.
- **D5 — Scope: global only.** Provenance (`source_conversation_id`) is
  stored for the manager UI, but recall does not filter by it.

## Known constraints this plan must respect

- IPC contract is CI-enforced: new commands go in `generate_handler!`
  (`src-tauri/src/lib.rs`), then `scripts/export-ipc-types.sh`, commit
  `src/lib/ipc/` output; `scripts/check-ipc.mjs` fails on literal invokes.
- Strict chat templates reject a non-first system message — memory injection
  must ride the single leading system message
  (`mergeLeadingSystemMessages`, `chat.svelte.ts`).
- CI grep guard: modules under `src/lib/agent/tools/` must not import
  `stores/chat.svelte` — ambient ids come from `stores/session.svelte.ts`.
- All model calls go through `resolveBackendDescriptor()`; no mode sniffing.
- ESLint caps: 400 lines/module, 80/function — plan the modules small.
- Migrations are hand-rolled and idempotent (`db/mod.rs::migrate`): new
  `CREATE TABLE IF NOT EXISTS` in the batch, new columns in the
  swallow-duplicate `ALTER TABLE` loop.
- fastembed downloads its model from Hugging Face on first init — for a
  privacy-focused app this must be explicit: memory ships **default-off**,
  and enabling it shows a one-time "download embedding model (~34 MB)"
  consent step, cached under the app data dir.
- Conventional Commits (release-please), `make check` green per phase.

## Risks

- **Bad memories are worse than no memories.** A stale/wrong fact injected
  with system-prompt authority poisons answers. Mitigations: similarity
  threshold + token budget on recall (Phase 04), full manager + per-turn
  visibility (Phase 05), extraction prompt tuned for *stable* facts only
  (Phase 03).
- **9B extraction quality.** Qwen 3.5 9B handles flat JSON fact lists fine
  (unlike graph schemas), but the prompt needs iteration; `forceFinalTool`
  guarantees parseable output shape at least.
- **fastembed cold start.** First embed loads the ONNX model (~hundreds of
  ms); a lazy `OnceCell` singleton keeps it warm after that. Acceptable for
  background extraction and per-send recall.
- **Embedding model swap invalidates stored vectors.** Store the model name
  per row; a future model change re-embeds lazily (out of scope for v1, but
  the column prevents a corrupt-recall bug).

## Phases

| Phase | Deliverable |
|---|---|
| [01](./phase-01-rust-memory-core.md) | `memories` schema, fastembed embedder, `db/memories.rs`, IPC commands |
| [02](./phase-02-settings-and-model-consent.md) | Global setting, Memory settings category, model download consent flow |
| [03](./phase-03-extraction-pipeline.md) | Idle/chat-switch triggers, `submit_memories` ephemeral turn, dedupe |
| [04](./phase-04-recall-and-injection.md) | Per-send retrieval, system-prompt MEMORY section, token budget |
| [05](./phase-05-incognito-and-manager-ui.md) | Per-chat incognito toggle, memories manager, in-chat visibility |
