# Phase 06 — Notebook tool family for agents

**Depends on:** 01, 02, 03, 04, 05 · **Enables:** 07 (the notebook chat uses
these tools), 08 (Python cards added by tools), 09 (semantic search behind
`notebook_search`), 14 (refresh jobs)

## Goal
Agents in Chat, Code and Shell can list, read, search, create and change
notebooks. In Chat and Code the tools are a deferred family the model loads
with `load_tools`. In Shell they are always sent. They are excluded from lean
turns. Tables are edited by row operations, with rows given as CSV. Every
change is stamped with its source, so phase 05's badge links back.

## Files touched
- `src/lib/agent/tools/notebook.ts` (new): registers these tools under the new
  category `notebooks`.
  - `notebook_list {tag?}` returns `id · title · tags · cards · last edited`
    per line, at most 50, pinned first.
  - `notebook_read {notebook, card?, offset?, limit?}`
    - `notebook` is an ID or an exact title (case-insensitive). If several
      notebooks share the title, list them.
    - Without `card` it gives the outline: each card's ID, kind and title, plus
      the first 300 characters of text cards and the first 10 rows of tables
      as CSV.
    - With `card` it gives that card in full. Tables and checklists come as
      CSV pages of 100 rows (`offset` and `limit`). The CSV header shows
      column name and type, as in `Price:currency`.
  - `notebook_search {query, limit?}` uses `notebook_search_keyword` and
    returns hits as `notebook / card · snippet`.
  - `notebook_create {title, tags?}` returns the ID and a `notebook:<id>`
    link for the reply.
  - `notebook_add_card {notebook, kind, title?, after?, text?, csv?, items?,
    path?, image?}`, where `kind` is text|table|checklist|attachment|image:
    - text uses `text`
    - table uses `csv` (the header row may use `Name:type`; without types,
      `rowsFromCsv` infers them)
    - checklist uses `items`, one per line, with a `[x] ` prefix for done
    - attachment uses `path`, a file in the session's working directory,
      resolved and confined like the fs tools
    - image uses `image`, a `haruspex-img` hash from an image tool's result,
      or a workdir path
  - `notebook_edit_card {card, title?, text?, append_text?}` edits text cards.
    `append_text` adds to the end without a full rewrite.
  - `notebook_table_rows {card, add_csv?, update?, delete?}`
    - `add_csv` takes CSV rows (header required) appended at the end.
    - `update` is lines of `row_id: Column=value; Column=value`.
    - `delete` is row IDs separated by commas or newlines.
    - Checklists use the same tool, with the columns `text` and `done`.
  - `notebook_table_columns {card, add?, rename?, retype?, remove?}`, all
    simple `Name:type` / `Old=New` lines.
  - `notebook_move_card {card, after?}`, `notebook_delete_card {card}`. The
    delete goes to Trash, and the result says so.
  - Every result names the cards and rows it touched, with IDs.
  - Every write reads the card's current `version` and passes it as
    `expected_version`. On conflict it re-reads once and retries. If the
    retry also conflicts, it returns the error "The card changed while you
    were editing; read it again."
  - Writes fire the phase 02 `notebook-changed` event so an open notebook
    refreshes.
- `src/lib/agent/tools/types.ts`: add `'notebooks'` to the category union.
- `src/lib/agent/tools/index.ts`: import `notebook.ts`.
- `src/lib/agent/tools/registry.ts`:
  - `shouldIncludeChatTool`: include `notebooks` unless lean or
    `!settings.notebooksTab`
  - `shouldIncludeCodeTool`: add the tools to CODE_TOOLS under the same
    condition
  - `shouldIncludeShellTool`: include `notebooks` under the same condition
- `src/lib/agent/tools/_families.ts`: a `notebooks` family `{id:'notebooks',
  line:'Notebooks: create, read, search and edit the user\'s notebooks
  (text, tables, checklists, files).', has: byCategory('notebooks')}`.
- `src/lib/agent/tools/_familyNotes.ts`: a family note:
  - read before editing
  - use row ops, never rebuild a table
  - link the notebook in the reply as `[title](notebook:<id>)`
- `src/lib/agent/tools/_leanProfile.ts`: confirm notebooks stay out.
- `src/lib/agent/tools/notebook.test.ts` (new).
- `src/lib/agent/tools/_families.test.ts`: add the family to the expected list.
- `docs/guide/notebooks.md`: an "Ask an agent to make or change a notebook"
  section, listing what each tab can do.

## Steps
1. Write the tool module on `src/lib/notebooks/api.ts`, `csv.ts` and
   `columns.ts`.
   - The source comes from `sourceFromToolContext(ctx)` (phase 05).
   - The `path` argument goes through the same workdir confinement helper the
     fs tools use, then `notebook_file_store_path`.
   - Image hashes go through `notebook_file_from_image` (phase 04).
2. Parse `update` lines leniently: trim, case-insensitive column names, and
   an unknown column is an error that lists the real ones. Values go through
   `parseCell`.
3. Wire the category gates and the family. Deferral already applies only to
   interactive Chat and Code, so Shell gets the tools directly.
4. Make `notebook:` links in assistant replies work. They already do since
   phase 02, through the markdown renderer.
5. Add the guide section. It names which tools load ("the agent loads its
   notebook tools when you mention a notebook").

## Build gate
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Unit, with mocked `invoke`:
  - Each tool's argument parsing and the text of its results.
  - A CSV with typed headers creates the right column types.
  - `update` with a bad column lists the real ones.
  - Conflict, retry, then error.
  - Category gating per tab, lean and tab off.
  - The family appears in the deferred `load_tools` list.
- Live, with `npm run drive` against a real model:
  1. Chat: "find three Bluetooth speakers and make a notebook called speakers
     with a table of name, features, price and a retailer link". The notebook
     exists with a typed table, and the reply links it.
  2. Code: "create a notebook with the TODO comments in this repo as a
     checklist", then "work through notebook X and tick items off".
  3. Shell: "outline this folder in a notebook".
  4. Change one price; the debug log shows a single-row `notebook_rows_apply`.

## Commit
`feat(notebooks): let agents create, read, search and edit notebooks`

## Rollback
Revert the commit. Notebooks made by agents stay as ordinary data. The tool
family simply disappears from `load_tools`.
