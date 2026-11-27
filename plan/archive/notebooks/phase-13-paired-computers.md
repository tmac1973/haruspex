# Phase 13 — Notebooks on paired computers (live view)

**Depends on:** 01, 02, 03, 04, 05, 07, 08, 09, 10, 11, 12 · **Enables:** nothing later depends on
it

## Goal
In the Notebooks tab, notebooks on paired computers appear under each
computer's name, read and edited live over that computer's owner API, the way
remote chats and Code sessions work today. Nothing is copied. A computer's
notebooks are reachable only while it is on. Attachment and image files up to
25 MB can be opened and viewed. Larger files show their name and size with
"On <computer>".

## Files touched
- `src/lib/peers/remoteNotebooks.svelte.ts` (new):
  - a peer-side store mirroring the phase 12 ops through
    `src/lib/peers/transport.ts`, following `remoteChat.svelte.ts` and
    `remoteCodeSession.svelte.ts`
  - subscribes to the peer's `notebook-changed` events
- `src/lib/notebooks/backend.ts` (new):
  - a `NotebookBackend` interface (list, get, rows, search, card ops, rows
    apply, history, rollback, chat)
  - `localBackend` over `api.ts`, and `peerBackend(peerId)` over
    `remoteNotebooks`
  - `NotebookBackend` has `kind: 'local' | 'peer'` (phase 15 uses it)
  - every component and module from phases 02–11 that calls `api.ts`
    directly switches to the backend passed through Svelte context, so one
    view serves both. This includes `NotebookPicker.svelte` and `capture.ts`
    (phase 10), which always use `localBackend`, and `export.ts` and
    `import.ts` (phase 11), which take a backend argument. Agent tools
    (phases 06–08) keep calling `api.ts`: they act on this computer only
- `src/lib/components/notebooks/*.svelte`, `cards/*.svelte`,
  `src/lib/notebooks/export.ts`, `import.ts`: take the backend from context
  or as an argument instead of importing `api.ts`.
- `src/lib/components/notebooks/NotebookList.svelte`:
  - a "This computer" group, then one collapsible group per online paired
    peer (from `src/lib/peers/store.svelte.ts`)
  - offline peers show greyed out with "Offline"
  - search optionally includes peers through a "Search other computers" chip,
    on by default when any peer is online
- `src/lib/components/notebooks/NotebookChatPanel.svelte`: for a peer
  notebook, the chat runs on that peer through `notebooks.chat.*`, like
  `remoteChat` implements `ChatSource`.
- Python cards on a peer notebook: Run is disabled with the tooltip "Python
  runs on the computer that owns this notebook". The saved output shows.
- Files:
  - Image and attachment cards on a peer fetch bytes over the peer's
    `/image/{hash}` route (phase 12 fallback) only when `size <= 25 MB`.
  - "Open" fetches the bytes, writes them with the new Rust command
    `notebook_file_open_bytes(name, bytes)` into
    `<app_cache>/notebook-peer-files/` (cleared at startup), and opens the
    file with the opener plugin. Register it in `src-tauri/src/lib.rs`,
    implemented in `src-tauri/src/notebook_files/mod.rs`.
  - Larger files show "On <computer> (<size>)" and no button.
- `src-tauri/src/owner/server.rs`: the `/image/{hash}` fallback for notebook
  files refuses files over 25 MB to peer clients with 413, matching the UI.
- Export and import on peer notebooks: Export works by reading through the
  backend, with files over 25 MB listed but not included. Import into a peer
  notebook is disabled.
- `docs/guide/notebooks.md` and `docs/guide/other-computers.md`: "Notebooks on
  your other computers".

## Steps
1. Introduce `NotebookBackend` and switch the components to it, with no change
   in behaviour for local notebooks. This is a pure refactor commit inside the
   phase; run the full test suite after it.
2. Add `remoteNotebooks` and `peerBackend`.
3. List grouping, peer search, peer chat, Python and file rules, and the
   server size limit.
4. Phase 05's source links on a peer card open the source on that peer when a
   remote view exists (Chat, Code), otherwise they show the label only.

## Build gate
- `cd src-tauri && cargo clippy -- -D warnings && cargo test`
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Unit:
  - `peerBackend` maps every method to its op.
  - Components render with a mock backend.
  - The 25 MB rule is enforced in the UI and the server.
- Manual, with two paired computers (this needs a second machine; offer to
  drive the test host via the owner API before handing it over):
  1. Computer A's notebooks appear on B.
  2. Edit a table on B; A updates live.
  3. Ask the notebook chat on B; the turn runs on A.
  4. A 10 MB PDF opens; a 40 MB file shows its size only.
  5. Turn A off: its group shows Offline.

## Commit
`feat(notebooks): show and edit notebooks on paired computers`

## Rollback
Revert the commit. Step 1's backend refactor can stay on its own if needed.
No data is involved.
