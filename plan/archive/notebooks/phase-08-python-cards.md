# Phase 08 — Python cards

**Depends on:** 01, 02, 03, 05, 06, 07 · **Enables:** 11 (`.ipynb` export)

## Goal
Python cards hold code run in the existing Pyodide sandbox. The notebook's
tables come in as pandas dataframes, and the saved output (text, plots, HTML
tables) shows under the code. You press Run. An agent's new or edited Python
card runs once, so the agent sees its output. Output is marked stale when a
table it read has changed. A dataframe result can be saved as a new table
card. Code never changes existing tables.

## Files touched
- `src/lib/notebooks/pythonRun.ts` (new):
  - `runPythonCard(notebookId, card)`:
    1. Builds a prelude that defines `tables`, a dict from table card title to
       a `pandas.DataFrame` built from the rows. Number and currency columns
       become floats, dates become `datetime64`, checkboxes become bool.
       Duplicate titles get ` (2)`, ` (3)`. A `table(name)` helper raises a
       clear error listing the names.
    2. Runs `prelude + body` with `runPython('notebook-<id>', …,
       {timeoutMs: 120000})` from `src/lib/sandbox/sandbox.ts`.
    3. If the code leaves a top-level variable named `result` that is a
       `pandas.DataFrame`, the runner then evaluates
       `result.head(5000).to_csv(index=False)` in the same sandbox (globals
       persist per sandbox ID), so the code is never re-run.
    4. Stores `{stdout, stderr, error, artifacts, duration_ms, ran_at,
       read_versions:{cardId:version}, result_csv?}` in the card's
       `meta.output`.
       `artifactsList` comes from `src/lib/sandbox/protocol.ts`.
  - Image artifacts larger than 2 MB, and anything else after 5 MB in total,
    are dropped, with a note in the output.
- `src/lib/notebooks/pythonRun.test.ts` (new): the prelude for each column
  type; staleness.
- `src/lib/components/notebooks/cards/PythonCard.svelte` (new):
  - a CodeMirror Python editor (`src/lib/editor/languages.ts`)
  - Run, Stop (`cancelRun`), and Reset sandbox (`resetSandbox`)
  - the output area renders stdout and stderr, images, HTML artifacts (in `src/lib/components/ArtifactFrame.svelte`, as Chat's sandbox output
    does) and errors
  - a "stale" chip when any `read_versions` entry is behind the current card
    version
  - when `meta.output.result_csv` is present, a "Save as table card" button:
    `rowsFromCsv(result_csv)`, then `notebook_card_add` with the inferred
    columns in `meta`, the rows in `rows`, and `source {kind:'python', ref:
    cardId}`; nothing is re-run
  - the card's placeholder text says "Assign a DataFrame to `result` to save
    it as a table."
  - a `readonly` prop for phase 05 history previews
- `src/lib/notebooks/cardKinds.ts`: register `python`. It is unavailable, with
  a tooltip, when `src/lib/sandbox/availability.ts` reports the sandbox is
  unavailable.
- `src/lib/agent/tools/notebook.ts`:
  - `notebook_add_card` accepts `kind: 'python'` with `code`
  - `notebook_edit_card` accepts `code`
  - after either, the tool runs the card with `runPythonCard` and returns the
    formatted output (`formatResult.ts`, capped at 20 KB)
  - the run goes through `src/lib/stores/sandboxApproval.svelte.ts` (shown by
    `SandboxApprovalModal.svelte`), as the `sandbox` tool does, so the user's
    approval setting applies
- `src/lib/agent/tools/notebook.test.ts`: the Python paths.
- `docs/guide/notebooks.md`: "Python cards" section. It covers network access
  following Settings → Tools → Python sandbox network, and that tables are
  read-only to code.

## Steps
1. Write `pythonRun.ts`.
   - Load pandas through the sandbox's existing package install.
   - The sandbox ID is per notebook, so variables persist between cards in
     one notebook, like Jupyter.
   - "Reset sandbox" clears them.
2. Build PythonCard.
   - Output is saved with `notebook_card_update`, using a source of the
     runner: the user, or the agent's source.
   - A run is grouped with the edit into one revision by phase 01's 2-minute
     rule.
3. Extend the tools, including approval.
4. Staleness is computed on render from `read_versions` against the current
   cards. It does not re-run anything.

## Build gate
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Unit: the prelude builds correct dtypes for every column type; staleness
  flips when a table's version changes; the tool runs and returns output.
- Manual:
  1. In the speakers notebook, add a Python card plotting price against
     battery life from `tables["Speakers"]`. The plot shows.
  2. Edit a price; the card shows stale.
  3. Run again.
  4. `result = df.describe()` then "Save as table card" creates a table.
  5. Live: ask the notebook chat "chart prices by brand". The card is added
     and run, and the reply describes the chart.

## Commit
`feat(notebooks): add python cards that read the notebook's tables`

## Rollback
Revert the commit. Python cards left in the database show as unavailable
(phase 02 behaviour). The sandbox is unchanged.
