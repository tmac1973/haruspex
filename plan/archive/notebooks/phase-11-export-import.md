# Phase 11 — Export and import

**Depends on:** 01, 02, 03, 04, 08 · **Enables:** nothing later depends on it

## Goal
Notebooks, tables and Python cards can be exported, and Markdown, CSV and
XLSX files can be imported.

Export:
- a whole notebook to Markdown, HTML, PDF, DOCX or ODT
- a table card to CSV or XLSX
- a notebook's Python cards to `.ipynb`

Import:
- Markdown, CSV and XLSX, as a new notebook or as cards in the open one

## Files touched
- `src/lib/notebooks/toMarkdown.ts` (new): `notebookToMarkdown(nb, cards,
  {files:'link'|'inline'})` renders each kind as follows.
  - Text cards go through as written, under a `## <title>` when titled.
  - Tables become GFM tables, with URL cells as `[host](url)`.
  - Checklists become `- [ ]` / `- [x]` items.
  - Python cards become a fenced `python` block followed by their stdout, and
    plot images as `![](…)`.
  - Attachments become a link to `files/<name>`.
  - Images become `![title](files/<name>)`.
- `src/lib/notebooks/toMarkdown.test.ts` (new).
- `src/lib/notebooks/export.ts` (new): one export function per format. All
  save through a Tauri save dialog.
  - **Markdown**: a `.zip` holding `<title>.md` and `files/`, built with
    jszip. With no files, a plain `.md`.
  - **HTML**: one file, with `renderMarkdown` output inside a minimal styled
    document. Images are embedded as data: URIs and attachments listed by
    name.
  - **PDF**: `pdfFromMarkdown` (`src/lib/documents/pdf.ts`).
  - **DOCX/ODT**: `officeFromMarkdown` (`src/lib/documents/officeFile.ts`).
    Images resolve through the document model's image block, by reading
    bytes from `notebook_file_path`.
  - **Table CSV**: `csv.ts` writer.
  - **Table XLSX**: `fs_write_xlsx`. It is currently workdir-confined, so add
    the absolute-path command `notebook_export_xlsx(path, sheets)` in Rust
    that reuses `xlsx.rs`'s writer and takes only paths from a save dialog.
  - **`.ipynb`**: nbformat 4 JSON. Text cards become markdown cells and
    Python cards become code cells with outputs (`stream`, and
    `display_data` with `image/png`). Tables are inlined as markdown cells.
- `src-tauri/src/fs_tools/document_write.rs`: `notebook_export_bytes(path,
  bytes)` writes bytes to a dialog-chosen absolute path.
- `src-tauri/src/fs_tools/xlsx.rs`: `notebook_export_xlsx(path, sheets)`.
- Both check the magic bytes, as the existing writers do.
- `src-tauri/src/fs_tools/xlsx.rs`: `notebook_import_xlsx(path)` returns
  `[{name, rows: string[][]}]` through calamine, for a dialog-chosen path.
- `src-tauri/src/lib.rs`, IPC bindings and mocks: register the three commands.
- `src/lib/notebooks/import.ts` (new):
  - **Markdown**:
    - splits at `##` headings into text cards
    - GFM tables become table cards (types inferred)
    - a list made only of task items becomes a checklist card
    - the first `#` heading becomes the notebook title
  - **CSV**: one table card named after the file.
  - **XLSX**: one table card per non-empty sheet.
  - Source is `{kind:'import', label:<file name>}`.
- `src/lib/notebooks/import.test.ts` (new).
- `src/lib/components/notebooks/NotebookView.svelte`:
  - an "Export…" menu on the notebook header (Markdown, HTML, PDF, Word,
    OpenDocument, Jupyter)
  - an "Import into this notebook…" menu item
- `src/lib/components/notebooks/CardFrame.svelte`: an "Export table…" item in
  the card menu for table cards (CSV, Excel).
- `src/lib/components/notebooks/NotebookList.svelte`: an "Import…" button
  that creates a new notebook.
- `docs/guide/notebooks.md`: "Export and import" section.

## Steps
1. `toMarkdown.ts` and its tests. Every other export builds on it.
2. Export functions, the Rust absolute-path writers, and menus.
3. Import parsing, the XLSX reader command, and menus.
4. A round-trip test: a table exported to CSV or XLSX and imported back has
   the same cells. A notebook exported to Markdown and imported back has the
   same text, tables and checklists.

## Build gate
- `cd src-tauri && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` (no drift)
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Unit: markdown output for each card kind, `.ipynb` JSON validity (nbformat
  4 shape), import splitting, and the round trips above.
- Rust: `notebook_import_xlsx` on a fixture with two sheets.
- Manual, with a notebook holding all six card kinds:
  1. Export each format.
  2. Open the PDF and DOCX in a document viewer, the ODT in LibreOffice, the
     XLSX in LibreOffice Calc, and the `.ipynb` in JupyterLab or VS Code.
  3. Import a real bank-statement CSV and a multi-sheet XLSX.

## Commit
`feat(notebooks): export notebooks to documents and import markdown, csv and xlsx`

## Rollback
Revert the commit. There is no data change: export only writes files, and
import creates ordinary cards that stay.
