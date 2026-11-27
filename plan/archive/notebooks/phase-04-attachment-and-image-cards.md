# Phase 04 — Attachment and image cards, file drop

**Depends on:** 01, 02 · **Enables:** 06 (agents attaching files), 07 (dropping
documents on the agent panel), 11 (exporting with files)

## Goal
Attachment cards keep a file with the notebook: you can open it, save a copy,
and preview it inline when it's a PDF. Image cards show a picture inline.
Files are added with a picker or by dropping them on the notebook, and an
image card can also come from an image already in Haruspex. Files live in
phase 01's durable store and are never evicted while referenced.

## Files touched
- `src/lib/utils/fileDrop.ts` (new):
  - a `fileDropTarget` Svelte action built like `imageDrop.ts` (Tauri
    `onDragDropEvent` with a rect hit-test)
  - hands back **paths** of any file type
  - `imageDrop.ts` is left unchanged
- `src/lib/utils/fileDrop.test.ts` (new): the hit-test and path filtering.
- `src/lib/components/notebooks/cards/AttachmentCard.svelte` (new):
  - shows the file name, size and type icon
  - buttons: Open (opens with the system app through the `notebook_file_path`
    command and the opener plugin), Save a copy… (a save dialog), Replace…
  - PDFs show a first-page preview using the existing PDF preview path from
    `src/lib/documents/preview.ts`
- `src/lib/components/notebooks/cards/ImageCard.svelte` (new):
  - `<img src="haruspex-notebook-file://<hash>">` with a caption (the card
    title)
  - click to view full size with `openImageViewer`
    (`src/lib/stores/imageViewer.svelte.ts`, shown by `ImageViewerHost.svelte`)
- `src/lib/notebooks/cardKinds.ts`: register `attachment` and `image`. "Add
  card" opens a file picker.
- `src/lib/components/notebooks/NotebookView.svelte`:
  - `use:fileDropTarget` on the card list
  - each dropped file becomes a card after the card under the pointer: an
    image card for `image/*`, otherwise an attachment card
- `src-tauri/src/notebook_files/mod.rs`: add `notebook_file_from_image(hash)`,
  which copies a `haruspex-img` cache entry into the durable store so a later
  eviction can't break the card.
- `src-tauri/src/lib.rs`: register the new command.
- IPC bindings and mocks regenerated.
- `docs/guide/notebooks.md`: "Files and pictures" section.

## Steps
1. Write `fileDropTarget` and its test.
2. Dropping or picking a file calls `notebook_file_store_path(path)`, then
   `notebook_card_add` with `meta {hash,name,mime,size}` and
   `source {kind:'user'}`.
3. Files over 200 MB are refused with the toast "Files over 200 MB can't be
   added."
4. Replace… stores the new file and updates `meta` with `expected_version`.
   The old hash stays referenced by the revision snapshot until it is pruned,
   and phase 01's stray sweep counts hashes in revisions as referenced.
5. On WebKitGTK the dev page needs the CORS allowlist entry phase 01 added.
   Confirm images display in `tauri dev`.

## Build gate
- `cd src-tauri && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` (no drift)
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Rust: copying from the image cache to the durable store survives the image
  cache's eviction, and the stray sweep keeps hashes referenced only by
  revisions.
- Manual:
  1. Drop a PDF, a PNG and a .zip on a notebook; three cards appear in the
     right places.
  2. Open the PDF with the system app.
  3. Save a copy.
  4. Restart, and the image still shows.
  5. Delete the card, purge the trash, restart; the file is gone from
     `<app_data>/notebook_files/`.

## Commit
`feat(notebooks): add attachment and image cards with file drop`

## Rollback
Revert the commit. Stored files stay on disk, and phase 01's stray sweep
removes them once their cards are purged. Leaving cards of these kinds behind
is safe because phase 02 shows them as unavailable.
