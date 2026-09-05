# Phase 06 — Decompose stage + the ralph loop engine

**Depends on:** Phase 05 · **Enables:** Phase 07.

## Goal

The heart of the feature: decompose the plan into atomic steps, then run the
unattended fresh-context-per-iteration loop — implement one item, verify,
commit, check it off — until every item is done or blocked, then write the
final report. After this phase the job is functionally complete end to end.

## Files touched

- **EDIT** `src/lib/agent/jobs/types/autonomous-coding/pipeline.ts` —
  `runDecompose`, `runLoop`, `runFinalize`, wired after preflight.
- **NEW** `src/lib/agent/jobs/types/autonomous-coding/loopState.ts` — pure
  state module (injected-deps style, per the audit precedent): the task list,
  per-item attempt counts, done/blocked transitions, TODO/PROGRESS markdown
  rendering. This is where the unit tests live.
- **NEW** `src/lib/agent/jobs/types/autonomous-coding/tools.ts` —
  `submit_task_list`, `submit_iteration_result` (structured, forced-final —
  the audit `forceFinalTool` pattern), registered under a new
  `'autonomous_coding'` tool category exposed via `def.toolCategories`.
- **EDIT** `prompts.ts` — decompose prompt, iteration prompt, finalize prompt.
- Tests: `loopState.test.ts` (the bulk), tool schema tests, pipeline
  sequencing with a mocked `runJobTurn`.

## Implementation

### Stage 1 — Decompose

Fresh-context turn; toolset = read-only fs + forced `submit_task_list`
(`{ items: { id, title, description }[] }`). Prompt: read all plans +
`DECISIONS-coding.md`; produce a strictly ordered list of **small atomic
steps** — each independently implementable, verifiable, and committable;
earlier items must never depend on later ones (the guided-planning invariant,
restated for code). Bias item 1 toward "establish a runnable build/test
harness" when the project lacks one, so later verification has teeth.

Runner persists the list three ways: `TODO-coding.md` in `plan_dir` (the
model-facing artifact), `ctx.saveRunnerState` (attempt counts + statuses, the
resume slot), and the run's display steps (each item becomes a step in the
run view — replacing the placeholder list from `planSteps`, which for this
type returns just Preflight/Decompose/Loop/Finalize until real items exist).

### Git baseline (before the loop)

Via the shell plumbing, in the working dir: `git init` if no repo; if dirty,
commit everything as `chore: pre-ralph baseline`. Nothing the loop does can
destroy pre-existing work; every later step has a rollback point.

### Stage 2 — The loop

```
while (items remain with status 'todo'):
    item = first 'todo' item
    run one fresh-context iteration turn
    apply the submitted result to loopState; persist state + files
```

Each **iteration turn** gets: the rendered TODO list (with done/blocked
marks), the tail of `PROGRESS-coding.md` (bounded — last ~N entries, keeping
iteration context flat regardless of run length), blocked notes, the verify
command if configured, and the instruction set: *implement exactly one item —
the first actionable 'todo' item; verify it (run `verify_command` if set, else
build/test by your own judgment); then call `submit_iteration_result`.*

- **Toolset:** full fs + shell (cwd pinned to working dir) + forced-final
  `submit_iteration_result` (`{ item_id, status: 'done' | 'failed', note }`).
  **`ask_user_question` is excluded** — after preflight the run cannot ask;
  this is enforced by the toolset, not the prompt.
- **On `done`:** loopState checks the item off; runner appends the note to
  `PROGRESS-coding.md`, updates `TODO-coding.md`, marks the display step
  finished, and commits: `feat: <item title> [ralph <n>/<total>]`
  (conventional format; scope/type adjusted by the model's note if it says
  fix/chore). Commit is runner-driven (deterministic), not model-driven.
- **On `failed`:** append the failure note (these notes are the next
  attempt's context); increment the attempt count; at `max_attempts`
  (default 3) transition to **blocked** with the accumulated notes and move
  on. The iteration prompt tells the model blocked items exist and to skip
  items that genuinely depend on them (marking such items failed with a
  "depends on blocked #k" note — which blocks them too after max attempts, by
  design; the cascade is visible in the report).
- **Sanity checks (runner-side, cheap):** submitted `item_id` must be the
  expected item; a `done` with no working-tree diff **and** no new commit is
  downgraded to `failed` ("claimed done, changed nothing") — the minimal
  guard against a model checking items off on faith.
- **No iteration cap.** Termination = no `'todo'` items left. Every iteration
  strictly consumes one attempt on one item and items are finite
  (`items × max_attempts` bounds total iterations structurally — "run until
  done" cannot actually run forever).
- **Resume:** state persists via `saveRunnerState` after every iteration; an
  app crash/restart resumes at the next `'todo'` item (the guided-planning
  milestone-resume pattern; the repo + TODO file are the ground truth the
  fresh context re-reads anyway).

### Finalize

One last turn (read-only fs + fs-write allowlisted to `plan_dir`): write
`REPORT-coding.md` — what was built, verify-command status, each blocked item
with its failure history, suggested next steps for the human. Runner commits
it (`docs: ralph run report`) and finalizes the run: `done` when nothing is
blocked, else surfaced as "done with blockers (k)" (run summary field — the
existing `finalizeRun` message path).

## Acceptance

- `loopState` unit tests: ordering, attempt counting, blocked transition at
  max attempts, done-with-blockers terminal detection, markdown round-trip.
- E2E on a toy plan (e.g. 3-item CLI tool with a `verify_command`): wakes up
  to a git history of `baseline → feat × 3 → docs: report`, all items checked,
  report written.
- E2E with a deliberately impossible item: 3 failed attempts → blocked → later
  items still complete → run ends "done with blockers (1)" with the failure
  history in the report.
- Kill the app mid-loop, reopen, re-run: resumes from the next item without
  re-doing completed ones.
- `npm run check` / `lint` / `test` green.
