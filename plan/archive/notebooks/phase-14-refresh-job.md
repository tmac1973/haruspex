# Phase 14 — Scheduled notebook refresh job

**Depends on:** 01, 02, 03, 05, 06, 10 · **Enables:** nothing later depends on it

## Goal
A new Jobs job type, **Refresh notebook**, takes a notebook and an instruction
("update prices and stock in the Speakers table"). On each scheduled run it
does one agent turn with that notebook in context and the notebook and web
tools, and records what changed. Its edits carry the job's source, so each
card's badge links to the run and History can undo it.

## Files touched
- `src/lib/agent/jobs/types/notebook-refresh/definition.ts` (new): fields
  modelled on `camera-digest/definition.ts`:
  - `id:'notebook_refresh'`, `label:'Refresh notebook'`
  - `description`: "Re-runs your instruction against a notebook on a
    schedule."
  - `supportsSchedule:true`, `background:true`, `hasPlannedSteps:false`
  - `available()` is false when the Notebooks tab is off or in lean mode,
    with the reason given
- `src/lib/agent/jobs/types/notebook-refresh/config.ts` (new):
  - `{notebookId, instruction}`
  - `validate`: the notebook exists and is not in Trash, and the instruction
    is 10–2,000 characters
- `src/lib/agent/jobs/types/notebook-refresh/pipeline.ts` (new):
  1. Reads the notebook outline (as `notebook_read` builds it).
  2. Calls `ctx.runJobTurn` with:
     - the instruction
     - the outline in the system addendum
     - a tool allowlist of the `notebooks` category plus web search and fetch
     - the note "Change only what the instruction asks; use row updates"
  3. Collects the cards touched, from tool results.
  4. `setResult` gives a summary: one line per changed card, plus the
     model's closing text.
  5. If the notebook was deleted meanwhile, the run fails with "The notebook
     is in Trash or gone."
- `src/lib/agent/jobs/types/notebook-refresh/Editor.svelte` (new):
  - a notebook picker: phase 10's `NotebookPicker` with `mode="select"`
  - an instruction textarea
  - `src/lib/components/jobs/JobScheduleField.svelte` for the schedule
- `src/lib/agent/jobs/types/notebook-refresh/pipeline.test.ts` (new).
- `src/lib/agent/jobs/types/index.ts`: register after the existing background
  types.
- `src/lib/stores/jobs.svelte.ts:16-27`: add `'notebook_refresh'` to
  `JobType`.
- `src/lib/notebooks/source.ts`: job runs pass `{kind:'job', ref:jobId,
  label:jobName}` through the tool context. This is already mapped in phase
  05; confirm the job context carries it.
- `src/lib/components/notebooks/NotebookView.svelte`: a "Refresh on a
  schedule…" notebook menu item that calls `openJobDraft`
  (`src/lib/agent/jobs/openDraft.ts`) with a `JobDraft` of type
  `notebook_refresh` and config `{notebookId}`.
- `docs/guide/job-types.md` and `docs/guide/notebooks.md`: the job type.
- `docs/showcase/jobs.md`: a card ("Keep a price table up to date").

## Steps
1. Definition, config, editor and registration.
2. Pipeline, with a fake `runJobTurn` in tests.
3. The notebook menu shortcut.
4. Guide and showcase. Check the showcase with `node
   scripts/build-showcase.mjs`.

## Build gate
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`
- `node scripts/build-showcase.mjs`

## Test plan
- Unit:
  - `validate` cases.
  - The pipeline builds the right allowlist and addendum.
  - The result lists the touched cards.
  - A deleted notebook fails cleanly.
- Live: on the speakers notebook, create "update prices" scheduled every 5
  minutes, and wait for one run.
  - Prices change, with badges "From Jobs: update prices" linking to the run.
  - History restores the previous prices.
  - Then delete the job.

## Commit
`feat(jobs): add a scheduled notebook refresh job type`

## Rollback
Revert the commit. Saved jobs of this type show as an unknown type in Jobs,
which is the existing behaviour for unregistered types; delete them by hand.
Notebook data is unaffected.
