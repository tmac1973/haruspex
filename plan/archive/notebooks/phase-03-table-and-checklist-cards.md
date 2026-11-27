# Phase 03 — Table and checklist cards

**Depends on:** 01, 02 · **Enables:** 06 (row tools), 08 (tables as
dataframes), 10 (capturing tables), 11 (table export and import), 15 (URL
cells)

## Goal
Table cards have typed columns that you edit inline, sort, filter and total.
Checklist cards hold items you tick off. Both save through row operations,
so a cell edit writes one row.

## Files touched
- `src/lib/notebooks/columns.ts` (new): one module for column types.
  - `parseCell(type, input)`, `formatCell(type, value)`, `compare(type,a,b)`,
    `total(type, values)`.
  - Types: text, number, currency (number plus an ISO code in column meta,
    default from the locale), url, date (ISO `YYYY-MM-DD`), checkbox (bool),
    and status (one of the column's options, default `todo|doing|done`).
- `src/lib/notebooks/columns.test.ts` (new).
- `src/lib/notebooks/csv.ts` (new):
  - an RFC 4180 parser and writer, with no new dependency
  - `rowsFromCsv(csv, columns?)` infers column types from the first 50 rows
    when `columns` is absent
  - phase 06 (tools) and 11 (import) reuse it
- `src/lib/notebooks/csv.test.ts` (new).
- `src/lib/components/notebooks/cards/TableCard.svelte` (new):
  - a grid with a header menu per column (rename, change type, sort, delete)
  - a "+ column" control, a "+ row" control, and a row menu (delete, move)
  - cells edit in place: Enter or Tab saves and moves on, Esc cancels
  - URL cells render as links that open in the system browser
  - a filter box filters rows on the client
  - a totals row under number and currency columns
  - loads 200 rows, then pages with "Show more"
- `src/lib/components/notebooks/cards/ChecklistCard.svelte` (new):
  - items with checkboxes; Enter adds the next item and Backspace on an empty
    item deletes it
  - drag to reorder
  - "Hide done" toggle
- `src/lib/notebooks/cardKinds.ts`: register `table` (an empty table with
  columns Name: text and Notes: text, plus one empty row) and `checklist` (one
  empty item).
- `src/lib/stores/notebooks.svelte.ts`: `applyRows(cardId, ops)` and
  `setColumns(cardId, cols)`, with the same conflict handling as phase 02.
- `docs/guide/notebooks.md`: a short "Tables and checklists" section.

## Steps
1. Write `columns.ts` and `csv.ts` with their tests first.
2. Build TableCard.
   - Each edit sends one `notebook_rows_apply` call with a single op.
   - A paste of tab- or comma-separated text into a cell becomes an `add` op
     per line, after that row.
3. Changing a column type re-parses that column's values with `parseCell`.
   - Values that don't parse are kept as text and shown with a warning tint,
     with the original text in a tooltip.
   - Nothing is discarded.
4. Build ChecklistCard on the same row ops, with cells `{text, done}`.
5. Changing a row bumps the card's `version`, and the store keeps the new
   version from the response.

## Build gate
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Unit:
  - Parse, format, compare and total for each type, including currency and
    locale and bad dates.
  - CSV round trip with quotes, commas, newlines and a BOM.
  - Type inference.
- Manual:
  1. Build a 4-column table with a URL and a currency column. Sort, filter and
     total it.
  2. Paste 20 lines from a spreadsheet.
  3. Change a column from text to number.
  4. Check `notebook_card_history` shows grouped revisions.
  5. A checklist: tick, reorder, hide done.

## Commit
`feat(notebooks): add table and checklist cards with typed columns`

## Rollback
Revert the commit. Table or checklist cards created meanwhile stay in the
database. Phase 02's view shows unknown kinds as "This card type isn't
available in this version", so leaving data behind is safe.
