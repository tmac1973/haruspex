# Phase 03 — Extraction pipeline (idle + chat-switch)

**Depends on:** Phases 01–02 · **Enables:** Phase 04 (there is something to
recall).

## Goal

Conversations start producing memories. A background pass distills *stable*
facts from new turns via a forced-structured-output ephemeral turn, dedupes
them against the store, and advances the per-conversation watermark. Gated on
`memoryEnabled && model ready && conversation.memory_enabled`.

## Files touched

- **NEW** `src/lib/agent/memory/extraction.ts` — the pipeline:
  1. `collectNewTurns(conversationId)`: read messages **from the db**
     (`dbGetConversation`), not the in-memory (possibly compacted) history;
     take `sort_order > memory_extracted_to`, drop tool-role noise, cap the
     transcript to fit the extraction context.
  2. Skip-fast guards: gate flags above; fewer than N new exchange turns
     (start N=2); nothing but trivial content.
  3. `runEphemeralTurn` with a dedicated extraction system prompt,
     `toolAllowlist: ['submit_memories']`, `forceFinalTool: 'submit_memories'`,
     backend from `resolveBackendDescriptor()` untouched. Wrapped in
     `withInferenceSlot({ consumer: 'memory-extraction' })` so it queues
     behind (and is preempted by) user turns.
  4. Per candidate fact: `memory_find_similar(content)`; above the
     dedupe threshold → bump existing (`last_seen_at`, keep content — v1 is
     ADD-only, no rewrite); below → `memory_add(content, category,
     conversationId)`.
  5. `conversation_set_memory_extracted_to(maxSortOrder)` — advance the
     watermark **only after** step 4 completes, so a killed app re-extracts
     rather than losing facts (dedupe makes the retry harmless).
- **NEW** `src/lib/agent/memory/extractionPrompt.ts` — the prompt. Distill
  only *durable* user-level facts: preferences, corrections, biographical/
  environmental facts, standing project context. Explicit exclusions:
  task-transient details, anything the model inferred but the user didn't
  state, secrets/credentials, verbatim quotes. Few-shot with 2–3 positive
  and negative examples; borrow from Mem0/LangMem's published prompts.
  Output contract: `{ memories: [{ content, category: 'preference' | 'fact'
  | 'project' | 'correction' }] }`, `content` self-contained (resolves
  pronouns), ≤ 1–2 sentences.
- **NEW** `src/lib/agent/tools/memory_tools.ts` — `submit_memories` tool,
  new category `'memory'` excluded from chat/shell/code surfaces (same
  gating as `audit`/`planning` categories) — reachable only via the
  explicit allowlist. Per the CI grep guard, this module must not import
  the chat store.
- **NEW** `src/lib/agent/memory/scheduler.svelte.ts` — trigger wiring:
  - Idle: on turn finalize, arm/reset a ~2 min timer per conversation;
    fire extraction if still idle and no active generation.
  - Chat-switch: on active-conversation change, immediately enqueue the
    previous conversation if it has unextracted turns.
  - Single-flight queue (one extraction at a time), drop-if-already-queued.
- **EDIT** `src/lib/stores/chat.svelte.ts` — two minimal calls into the
  scheduler (turn finalized; conversation switched). Keep the store's diff
  tiny; logic lives in `agent/memory/`.
- **EDIT** `src/lib/remote/driver.ts` — create remote threads with
  `memory_enabled = 0` (see D3). Remote conversations are ordinary
  `conversations` rows that show up in the owner's sidebar, so opening one to
  read it and switching away would fire the chat-switch trigger and distill a
  *guest's* statements into the owner's memory. The flag makes the existing
  gate do the work; there is no separate remote code path to keep in sync.
- Tests: extraction pure parts (turn collection/windowing off fixture
  messages, dedupe decision, watermark ordering) with mocked `invoke` +
  mocked `runEphemeralTurn`.

## Implementation notes

- **Trust boundary**: extraction consumes conversation content that includes
  tool results (web pages, files). The prompt must treat the transcript as
  data — facts must be *about the user/their context*, sourced from user
  turns; a web page saying "remember X" is not a memory. Cheap hard guard:
  extract only from `user` and `assistant` role messages, never `tool`.
- Dedupe threshold: start cosine ≥ 0.90 = same fact (bump), < 0.90 = new.
  Log borderline pairs (dev console) to tune. Constants in one module.
- Remote backends work unchanged (extraction is just another descriptor
  call). Local backend: `withInferenceSlot` is the collision guard;
  additionally skip the idle fire if a generation is in flight and let the
  next trigger pick it up — extraction is never urgent.
- App-quit flushing is **out of scope**: the watermark means un-extracted
  turns are simply picked up next time the conversation is touched (add a
  "conversation opened with stale watermark + idle" trigger to catch
  re-reads of old chats cheaply).
- Failure posture: extraction errors are silent-but-logged (console + a
  counter on the memory store) — never a user-facing error for a
  background nicety. 3 consecutive failures for a conversation → back off
  until next app start.

## Acceptance

- Manual: chat about a preference, switch conversations → within seconds a
  memory row appears (visible via `memory_list` in devtools; manager UI is
  Phase 05). Repeat the same preference in another chat → no duplicate row,
  `last_seen_at` bumps.
- Incognito precheck: set `memory_enabled = 0` on a conversation via
  devtools → no extraction for it (UI toggle arrives in Phase 05).
- Remote precheck: a thread created by the remote web chat is born with
  `memory_enabled = 0`; opening it locally and switching away extracts
  nothing (test with a mocked driver, asserted on the create call).
- Global toggle off, or model absent → schedulers no-op (assert via test).
- `make check` green.
