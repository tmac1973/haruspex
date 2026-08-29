# Phase 05 — Incognito toggle, memories manager, in-chat visibility

**Depends on:** Phases 01–04 · **Enables:** done — feature complete.

## Goal

The trust surface. Per-chat incognito becomes a visible control, Settings
gains the full memories manager, and each assistant turn can show exactly
which memories it was given.

## Files touched

### Incognito (per-chat)

- **EDIT** `src/lib/components/ChatView.svelte` — an incognito pill next to
  the existing `.research-toggle` pill (same visual family). States:
  - Memory on (default): subtle/off appearance.
  - Incognito: filled pill + a persistent small indicator while the chat is
    open ("Incognito — this chat won't be remembered"), because a privacy
    mode the user can't see is a privacy mode they can't trust.
  - Hidden entirely when `memoryEnabled` is globally off.
  Toggling calls `conversation_set_memory_enabled` (persisted column from
  Phase 01 — survives restart by construction).
- **EDIT** `src/lib/stores/chat.svelte.ts` / `db.ts` — carry
  `memory_enabled` on the loaded `Conversation` so the Phase 03/04 gates
  read local state, not a per-send query. New conversations inherit the
  default (on); a **new chat started while a hypothetical global "start
  chats incognito" preference exists is out of scope** — one default only.
- Semantics note (UI copy + docs): incognito = no recall in, no recording
  out, from toggle time forward. Turns extracted *before* toggling remain
  memories — deleting those is what the manager is for. Toggling incognito
  also freezes the watermark (scheduler gate already handles this).

### Memories manager (Settings → Memory)

- **EXTEND** `src/lib/components/settings/MemorySection.svelte` (split into
  subcomponents to respect the 400-line cap; e.g. `MemoryList.svelte`,
  `MemoryRow.svelte`):
  - Count + text filter (SQL `LIKE` via `memory_list` filter param — no
    semantic search needed to find a memory you're looking at).
  - Paged list (newest first): content, category chip, source conversation
    title (join in `memory_list`; "deleted chat" fallback), created /
    last-used dates.
  - Row actions: **edit** (inline textarea → `memory_update`, which
    re-embeds in Rust), **delete** (`memory_delete`, no confirm — single
    row, undo-friendly scale), **copy** (per the standing copy-buttons
    convention).
  - **Clear all** — destructive-styled, typed-out confirm ("delete N
    memories"), calls `memory_delete_all`.
- **EDIT** `src-tauri/src/db/memories.rs` — `list` gains the filter/join;
  nothing else new.

### In-chat visibility

- **NEW** `src/lib/components/MemoryRecallStep.svelte` — renders the
  `memory-recall` steps entry (Phase 04) in the same accordion family as
  `SearchStep.svelte`: collapsed line "Recalled N memories", expanding to
  the list with scores; per-memory actions: **delete** (`memory_delete` —
  the "why did it say that?" escape hatch) and jump-to-manager.
  Deleting here affects future turns only — no retroactive prompt edit.
- **EDIT** the step-rendering dispatch to route the new step type.

### Docs

- **EDIT** `maintenance.md` — memory subsystem section: embedding model
  cache location, the `embedding_model` column invariant, dedupe/recall
  constants and where to tune them, the extraction trust boundary
  (user/assistant turns only).

## Remote chat threads

Threads created by the remote web chat are born incognito (D3) and the toggle
is **not offered** for them: show the pill in a fixed, explained state
("Remote thread — never remembered") rather than a control the owner can flip.
Flipping it would let a guest's statements into the owner's memory, which is
the thing the default exists to prevent. Detect them the way the sidebar
already marks external conversations, not by sniffing the `remote-` id prefix
in new code.

## Acceptance

- Incognito pill: toggle → persists across app restart; extraction and
  recall verifiably off (no steps entry, no new rows); indicator visible.
- Manager: filter, edit (content change → next recall reflects it), delete,
  clear-all with confirm; source titles resolve; copy buttons work.
- Recall step: shows the exact Phase 04 injected set; delete removes from
  store and subsequent turns.
- Full `make check` green; conventional-commit history ready for
  release-please.

## Post-v1 candidates (recorded, not planned)

- Split recall/record toggles (D3 refinement) if a real use case appears.
- LLM reconciliation pass (UPDATE/supersede) if stale facts accumulate.
- Project scoping via a `scope` column (D5 refinement).
- Lazy re-embed on embedding-model upgrade.
- Memory for job pipelines.
- FTS5 hybrid retrieval if paraphrase recall underperforms.
