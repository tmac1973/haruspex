# Phase 08 — Run-view additions

**Depends on:** Phases 03 (data), 05/06/07 (run state + stages) · **Enables:**
the polished guided experience. The feature is *functional* without this phase
(the global modal handles Q&A and checkpoints; `JobRunView` shows steps); this
phase makes it pleasant.

## Goal

Augment the existing `JobRunView` for guided_planning runs with: a **checkpoint
banner**, a **documents panel** showing the written overview/phase files (with
live updates as they land), cleaner **Q&A rendering** in the step stream, and a
**needs-input** affordance to resume a parked run. Reuse `JobRunView` — no
separate run view.

## Files touched

- **EDIT** `src/lib/components/jobs/JobRunView.svelte` — guided_planning branch.
- **NEW** `src/lib/components/jobs/GuidedPlanningPanel.svelte` — documents panel
  + checkpoint banner + needs-input control (rendered by `JobRunView` for this
  job type).
- Possibly **EDIT** `JobRunHistory` / `JobRunDetail` — render past
  guided_planning runs' documents read-only.

## Implementation

### Checkpoint banner

When the run's `planning_state.pendingCheckpoint` is set (`overview_review` or
`dep_map`), show a banner ("Reviewing overview" / "Approve the dependency map")
above the stream. The actual choice still happens in the global question
modal — the banner is context so the user understands what the modal is about
and can find the on-disk file to edit.

### Documents panel

List the markdown files in the run's output dir (`overview.md`, `phase-NN-*.md`)
with a click-to-preview. Update reactively as files are written (the runner
already tracks files written; reuse that signal, or list the dir). Provides the
"watch the plan take shape" feel. Read-only preview; editing is done on disk or
via the agent (Revise).

### Q&A rendering

`ask_user_question` tool steps currently render as generic tool calls. Add a
compact rendering for this job type: show the question + the chosen answer
inline in the step stream, so the run history reads as a Q&A transcript. (Source
is the tool call args + result already captured by `onToolStart`/`onToolEnd`.)

### Needs-input resume control

When run status is `needs_input`, show a prominent "Resume — answer the next
question" button that re-enters the run (foreground ⇒ interactive ⇒ the modal
appears). This is the user-facing half of the Phase 05 pause-to-needs-input.

## Build gate

`npm run check && npm run lint && npm run test`

## Test plan

1. During a run: checkpoint banner appears/clears with each checkpoint.
2. Documents panel lists `overview.md`, then phase files as they're written;
   preview renders them.
3. Q&A steps render question + answer inline in the stream.
4. Park a run as `needs_input` (scheduled trigger or forced), confirm the
   "Resume" control appears and resumes correctly.
5. A past guided_planning run in history shows its documents read-only.
6. Research/audit run views are unchanged (branch is isolated).

## Commit

```
feat(jobs): guided_planning run-view additions

Adds a checkpoint banner, a live documents panel, inline Q&A rendering,
and a needs-input resume control to JobRunView for guided_planning runs.
Research/audit views unaffected.
```

## Roll-back rule

Pure presentation over existing state; revert to fall back to the plain
`JobRunView` (feature still works, just less polished).
