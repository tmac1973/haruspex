# Phase 12 — Engine ops and the Remote control web client

**Depends on:** 01, 02, 03, 04, 05, 07, 08, 09 · **Enables:** 13 (paired computers use
the same ops)

## Goal
Notebooks are reachable through the owner API, and the Remote control web
client (Settings → Remote control) uses it to:
- list, search and read every card
- edit text, table and checklist cards
- use each notebook's agent chat

Python runs, uploads and exports stay on the desktop.

## Files touched
- `src/lib/engine/types.ts`: add these ops to the `EngineOp` union:
  - `notebooks.list {tag?}`
  - `notebooks.get {notebookId}`
  - `notebooks.rows {cardId, offset, limit}`
  - `notebooks.search {query}`
  - `notebooks.create {title}`
  - `notebooks.card.add {notebookId, kind:'text'|'table'|'checklist', …}`
  - `notebooks.card.update {cardId, expectedVersion, title?, body?}`
  - `notebooks.rows.apply {cardId, expectedVersion, ops}`
  - `notebooks.card.delete {cardId}`
  - `notebooks.card.history {cardId}`
  - `notebooks.card.rollback {cardId, revisionId}`
  - `notebooks.chat.send {notebookId, text}`
  - `notebooks.chat.stop {notebookId}`
  - `notebooks.chat.messages {notebookId}`
  - a `notebook-changed` event type `{notebookId, cardIds}`
  - render-ready view types for cards; file cards carry
    `{name, size, mime, imageUrl?}`
  - No field is named `id`, to avoid engine routing by session ID (see
    `engine/mod.rs:68`).
- `src/lib/engine/notebooks.ts` (new): op handlers over
  `src/lib/notebooks/api.ts` and the phase 07 ChatSource. Source is stamped
  `{kind:'user', label:'Remote control'}` for edits made over the API.
- `src/lib/engine/dispatch.ts`: `case` entries that lazily import
  `engine/notebooks.ts`, like `home.cards` at :267-269. All are refused in
  lean mode and when the tab is off, through `LEAN_REFUSED` and a tab check.
- `src/lib/engine/notebookWatch.svelte.ts` (new): forwards the
  `notebook-changed` bus to engine events, like `homeWatch.svelte.ts`.
- `src-tauri/src/owner/clients.rs` `required_scope()`:
  - Read: list, get, rows, search, card.history, chat.messages
  - Drive: create, card.add, card.update, rows.apply, card.delete,
    card.rollback, chat.send, chat.stop
- `src-tauri/src/owner/server.rs`: image cards are served through the
  existing `/image/{hash}` route by extending its lookup to fall back to
  `notebook_files` for unknown hashes, read-scoped.
- `src/lib/engine/dispatch.scopes.test.ts`: passes with the new cases.
- `src/web/store.svelte.ts`: a notebooks store using `client.op` and event
  subscriptions.
- `src/web/components/notebooks/` (new):
  - `NotebooksView.svelte`: list with pins, tags and search
  - `NotebookPage.svelte`: cards, plus a chat drawer built from
    `src/web/components/Transcript.svelte` and `Composer.svelte`
  - `TextCard.svelte`: a textarea editor on narrow screens, markdown view
  - `TableCard.svelte`: rows as stacked key/value cards below 600 px, a grid
    above, tap a cell to edit
  - `ChecklistCard.svelte`
  - `ReadOnlyCard.svelte`: Python output, attachments by name and size,
    images shown, each with "Open on the desktop to change this"
- `src/web/App.svelte`: add a Notebooks view to its navigation when `app.mode`
  reports it on.
- `src/web/web.test.ts`: cases for list, open and edit-row.
- `docs/guide/notebooks.md` and `docs/guide/remote-control.md`: what the web
  client can do with notebooks.

## Steps
1. Op types, handlers and dispatch cases. Scope entries in Rust, so unknown
   ops are no longer refused.
2. The event watcher.
3. The image route fallback, with a Rust test for scope and lookup.
4. Web client store and components. Conflicts show "Changed elsewhere —
   reloaded" as on desktop.
5. `npm run build:web`.

## Build gate
- `cd src-tauri && cargo clippy -- -D warnings && cargo test`
- `npm run check && npm run lint && npm run test && npm run build:web`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Unit: dispatch scope test; each handler with mocked api; web store and
  components (`web.test.ts`).
- Manual, or via `npm run drive --api`:
  1. With Remote control on, open the web client on a phone.
  2. Search notebooks, edit a table cell, and tick a checklist item. The
     desktop updates live.
  3. Ask the notebook chat a question; the reply streams.
  4. A read-only token can read but not edit.

## Commit
`feat(notebooks): expose notebooks to the remote control web client`

## Rollback
Revert the commit. The ops disappear. Because unknown ops are refused, older
web client builds fail closed.
