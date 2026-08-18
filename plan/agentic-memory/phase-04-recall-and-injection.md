# Phase 04 — Recall & injection

**Depends on:** Phases 01–03 · **Enables:** Phase 05 (visibility UI needs the
recall record).

## Goal

Memories start influencing chats. At send time, retrieve top-k relevant
memories and inject them as a bounded section of the system prompt. Recorded
per turn so Phase 05 can show exactly what was injected.

## Files touched

- **NEW** `src/lib/agent/memory/recall.ts`:
  - `recallForTurn(queryText, opts) -> RecalledMemory[]` — calls
    `memory_search(query, k, minScore)`; query text = the new user message
    plus a short tail of recent user turns (paraphrase context), truncated.
  - Filters: global + per-chat gates (skip entirely when off — recall must
    add **zero** latency to incognito/disabled chats); `minScore` start
    0.55; `k` start 6; then a **token budget** (~500 tokens estimated) that
    trims lowest-score first. Constants co-located with Phase 03's.
  - Returns `{ id, content, category, score }[]` and stamps the turn (below).
- **EDIT** `src/lib/agent/system-prompt.ts` — new conditional section in
  `buildSystemPrompt` (accepts the recalled list as a param; this module
  stays pure):

  ```
  MEMORY — facts previously learned about the user (may be stale; the
  user's current message always wins on conflict):
  - <content>
  ```

  Framing matters: memories are *context*, not instructions — the wording
  must not let an old preference override an explicit current request.
- **EDIT** `src/lib/stores/chat.svelte.ts` — in the send path (before
  `buildApiPrompt`): `await recallForTurn(...)`, pass into the prompt build.
  Injection rides the single leading system message so
  `mergeLeadingSystemMessages` keeps strict chat templates happy. Recall is
  one embed (warm fastembed) + one SQLite scan — a few ms, acceptable
  synchronously in the send path.
- **Recall record for Phase 05**: append a `memory-recall` entry
  (`{ memories: [{id, content, score}] }`) to the turn's steps (the
  existing `messages.steps` / `messageSteps` machinery) so it persists with
  the message and needs no new storage.
- **EDIT** `src/lib/agent/compaction.ts` — one-line interplay note in the
  summarizer prompt: cross-session facts are handled by memory; compaction
  should stop trying to be long-term memory (keep its in-chat role).
- Tests: recall filtering/budget logic (mocked invoke), system-prompt
  section rendering, gate short-circuits.

## Implementation notes

- **Do not recall on every agent-loop iteration** — once per user turn, at
  send. Tool-call iterations reuse the already-built prompt.
- Empty result (no memories, none above threshold) → no MEMORY section at
  all; never an empty header.
- `use_count`/`last_seen_at` bumps happen in `memory_search` (Phase 01) —
  recall usage feeds the recency rerank automatically.
- Compaction safety: the MEMORY section lives in the system message, which
  compaction already preserves; verify it isn't duplicated when a summary
  system message is merged in (`mergeLeadingSystemMessages` ordering test).
- Tuning loop: dev-only console log of (query, top-10 with scores) behind
  a flag, to calibrate `minScore`/`k` against real use before Phase 05
  polish.

## Acceptance

- Manual end-to-end: state a preference in chat A; new chat B on a related
  topic reflects it unprompted. Unrelated chat C gets no MEMORY section
  (verify via request log / steps entry).
- Explicit contradiction in the current message beats a stored memory.
- Incognito/disabled chats: no recall call at all (test), no MEMORY section.
- Steps entry records exactly the injected set.
- `make check` green.
