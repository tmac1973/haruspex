# Phase 02 — Settings, Memory category, model download consent

**Depends on:** Phase 01 · **Enables:** Phase 03 (extraction is gated on the
setting + model presence).

## Goal

Memory becomes a visible, opt-in feature: a new **Memory** settings category
with the global toggle and the one-time embedding-model download consent.
Still no extraction or recall — the toggle controls machinery that arrives in
Phases 03–04, but shipping it first means recording never starts before the
off-switch exists.

## Files touched

- **EDIT** `src/lib/stores/settings.ts` — add to `AppSettings`:
  `memoryEnabled: boolean` (**default `false`** — privacy-first, and
  enabling requires the model download anyway). Deep-merge `load()` already
  handles new scalar fields; add the default.
- **NEW** `src/lib/stores/memory.svelte.ts` — small store: model status
  (`absent | downloading | ready | error`), memory count, and
  `enableMemory()` orchestration (consent → download → flip setting).
  Refreshes via the Phase 01 commands.
- **NEW** commands (Rust, `src-tauri/src/memory/commands.rs`):
  `memory_model_status()` (file check, instant) and
  `memory_model_download()` (async command wrapping `ensure_model` in
  `spawn_blocking`; emits `memory-model-progress` events if fastembed's
  progress hook allows, otherwise indeterminate). Register + re-run
  `scripts/export-ipc-types.sh`.
- **NEW** `src/lib/components/settings/MemorySection.svelte`:
  - `.settings-section` card "Memory", with `ToggleField` — "Remember
    across chats" + description ("Haruspex extracts stable facts and
    preferences from your conversations and recalls them in future chats.
    Everything stays on this device.").
  - First enable with model absent → confirm step in-card (not a modal):
    "Requires a one-time download of a small embedding model (~34 MB) from
    Hugging Face." with Download button + progress; toggle only flips once
    status is `ready`.
  - Placeholder count line ("N memories stored") — the full manager list
    replaces/extends this card in Phase 05.
- **EDIT** `src/lib/components/settings/SettingsPanel.svelte` — new
  `Category` `'memory'`, `CategoryDef` (label "Memory", subtitle "What the
  assistant remembers between chats"), `{:else if}` branch.
- Tests: `memory.svelte.ts` state transitions (mock invoke), settings
  default merge.

## Implementation notes

- Keep the download **explicitly user-triggered** — never auto-download on
  app start even when `memoryEnabled` is somehow true with model absent
  (settings restored onto a fresh machine). In that state the store reports
  `absent` and extraction/recall (Phases 03–04) no-op; the Memory section
  shows the download prompt again.
- Offline dev parity: add the model fetch to `scripts/dev-setup.sh`
  (`--skip-models` respects it) so devs and CI-adjacent flows don't depend
  on first-run downloads.
- The Agent section subtitle already says "…remembers…" — leave it; the
  dedicated Memory category is the single home for all of this (toggle,
  consent, manager later). No memory UI in AgentSection.

## Acceptance

- Fresh profile: Memory category visible, toggle off; enabling walks
  through consent → download → ready → toggle on; setting persists.
- Disabling flips the setting only (model stays cached).
- `memoryEnabled && model absent` state degrades gracefully as above.
- `npm run check`, `lint`, `test` green.
