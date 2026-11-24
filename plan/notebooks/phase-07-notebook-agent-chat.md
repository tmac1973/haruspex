# Phase 07 — Each notebook's agent chat

**Depends on:** 01, 02, 03, 04, 05, 06 · **Enables:** 12 (the web client shows
this chat), 13 (peers drive it)

## Goal
Each notebook has a side panel holding its own saved conversation. It has
Chat's tools plus the notebook tools always loaded, and its notebook in
context. You can drop PDF, DOCX and XLSX files on it to have them read, and
"Organize these notes" or "extract X from this PDF as a table" work there.

## Files touched
- `src-tauri/src/db/conversations.rs`:
  - `conversation_for_notebook(notebook_id)` returns or creates the row, with
    `notebook_id` set (the column is from phase 01)
  - the Chat list query excludes rows where `notebook_id IS NOT NULL`
  - purging a notebook deletes its conversation
- `src-tauri/src/db/notebook_commands.rs`: the `notebook_conversation(notebook_id)`
  command; `src-tauri/src/lib.rs`: register it and `document_read_path` in
  `generate_handler!`.
- `src-tauri/src/fs_tools/mod.rs`:
  - `document_read_path(path)` extracts text from a dropped file at an
    absolute path (PDF, DOCX, XLSX, plus plain text, Markdown and CSV)
  - it uses `read_document_blocking`'s format switch without the workdir
    confinement, accepting only paths the webview got from a native drop
    event or a file dialog
  - the frontend passes the path from the drop event, and Rust checks it is a
    regular file under 50 MB
- `src/lib/notebooks/notebookChatSource.svelte.ts` (new):
  - a `ChatSource` (`src/lib/chat/source.ts`) backed by the notebook's
    conversation
  - it runs turns with `runEphemeralTurn`, following
    `src/lib/remote/conversation.ts` + `driver.ts:187-225`: load messages,
    compact, run, persist
  - `toolAllowlist` is Chat's tool set plus the `notebooks` category, not
    deferred
  - a system-prompt addendum: "You are working in the notebook '<title>'
    (<id>). Its outline:" plus the `notebook_read` outline text, capped at
    4,000 characters, refreshed each turn
  - the tool context marks the surface `notebook_chat`, so `source.ts` stamps
    edits "From notebook chat"
- `src/lib/components/notebooks/NotebookChatPanel.svelte` (new):
  - `ChatView` with that source in the right column of `NotebooksTab`
  - collapsible, with the open/closed state remembered per viewer through
    `persistItem`
  - `use:fileDropTarget` (phase 04): each dropped document is extracted and
    also stored with `notebook_file_store_path`; it is attached to the draft
    as a fenced block headed `<file name> (file: <hash>)`
  - the agent keeps the original by calling `notebook_add_card` with
    `kind: 'attachment'` and `file: <hash>`; the system addendum says "When
    you use a dropped file, add it as an attachment card." Stored files the
    agent never attaches are removed by phase 01's stray sweep
  - dropped images go to the composer's `createPendingImages()` list
    (`src/lib/utils/pendingImages.svelte.ts`), as in `ChatView.svelte`
- `src/lib/components/notebooks/NotebooksTab.svelte`: mount the panel.
- `src/lib/agent/tools/registry.ts`: the `notebook_chat` surface uses Chat's
  gates.
- `src/lib/notebooks/source.ts`: `sourceFromToolContext` maps the
  `notebook_chat` surface to `{kind:'notebook_chat', ref: conversationId,
  label: notebook title}`; add the case to `source.test.ts`.
- `src/lib/agent/tools/notebook.ts`: `notebook_add_card` accepts `file`, the
  hash of a file already in the notebook file store, for attachment and
  image cards; `notebook.test.ts` covers it.
- `docs/guide/notebooks.md`: an "Ask about this notebook" section.

## Steps
1. Add the conversation lookup and the Chat-list exclusion, plus a Rust test
   that a notebook conversation never appears in `conversations_list`.
2. Add `document_read_path` with tests on fixture files, reusing the
   `fs_read_*` fixtures.
3. Build the ChatSource and the panel.
   - Busy state and Stop work as in Chat.
   - Switching notebooks switches the conversation.
   - A turn keeps running if you switch away, because the tab stays mounted
     since phase 02.
4. When a turn changes the open notebook, `notebook-changed` refreshes the
   cards live, and the changed cards flash once.

## Build gate
- `cd src-tauri && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` (no drift)
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Unit: the ChatSource builds the prompt addendum and allowlist; a dropped
  document becomes a fenced attachment block.
- Live (`npm run drive` or by hand against a real model):
  1. Type notes naming three companies, then ask "organize these thoughts and
     research the companies I mentioned". Cards are rewritten and a company
     table is added, each stamped "From notebook chat", and History restores
     the original notes.
  2. Drop a PDF with a price list and ask "extract the prices as a table". A
     table card and an attachment card with the PDF appear.
  3. Restart: the conversation is still there and absent from Chat's list.

## Commit
`feat(notebooks): give each notebook its own agent chat with document drop`

## Rollback
Revert the commit except the Chat-list exclusion clause in
`conversations.rs`, which stays so notebook conversations left in the
database never show up in Chat.
