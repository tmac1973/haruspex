# Phase 03 — Browse the jobs tab while a run is live

Depends on: — / Enables: —

## Goal

While a run is live you can select, edit and create jobs, look at history,
and come back to the live run whenever you like, without cancelling it.

Today the run view takes over the centre pane as long as `getCurrentRun()`
is non-null, and the list is locked (`JobsTab.svelte`, `showRunView` and
`listLocked`). The only way out of the run view is Cancel. The run itself
lives in the runner, not the view, so the view can come and go freely.

This phase also fixes chain ordering in the run queue. Today a job you queue
while a chain is planning runs before the chain's next stage, because
`enqueue` is first in, first out.

## Files touched

- `src/lib/components/jobs/JobsTab.svelte`: selection and centre-pane logic.
- New `src/lib/components/jobs/LiveRunBar.svelte`.
- `src/lib/components/jobs/JobRunView.svelte`: a Hide control.
- `src/lib/components/jobs/JobList.svelte`: drop `locked`; show a running
  marker on the live job's row.
- `src/lib/components/jobs/JobEditor.svelte`: a note when the job is running;
  no delete while it runs.
- `src/lib/agent/jobs/runner.svelte.ts`: chained stages go ahead of
  hand-queued runs.
- Tests:
  - `JobsTab.test.ts`;
  - `src/lib/agent/jobs/runner.test.ts`;
  - `JobList.test.ts`, whose four `locked: true` tests (around :58-84) are
    replaced by running-marker tests;
  - a new `JobEditor.test.ts`.

## Steps

1. **Separate "a run exists" from "the run view is showing".** After a run
   ends, the runner keeps `getCurrentRun()` set, so the user can read the
   result and press Close (`runner.svelte.ts:729-731`,
   `JobRunView.svelte:118-121`). That stays.
   - New state: `runViewOpen`.
     - It becomes true when the user starts a run from this tab (▶, or Run in
       the editor) and when the bar is clicked.
     - It becomes false on Hide and on the run view's Close.
     - Runs from other sources (chained, scheduled, drained from the queue)
       leave it as it is. A user watching one chain stage keeps watching the
       next; a user browsing keeps browsing.
   - The centre pane shows the run view while `runViewOpen &&
     getCurrentRun()`. Otherwise it shows the selection, as with no run.
   - `listLocked` and the `locked` prop are removed.
2. **`LiveRunBar`**, shown at the top of the centre pane while a run is
   **running** (not merely finished and unclosed) and the run view is hidden.
   - Content: "Running: <job name> · step N of M", plus the queue count when
     the queue isn't empty.
   - Clicking it sets `runViewOpen`.
   - It reads the runner's existing state and adds no new store.
3. **`JobRunView` gets a Hide button** next to Cancel, with the tooltip
   "Keep it running and go back to your jobs". Hide never touches the runner.
4. **`JobList` marks the live job's row** with a small running indicator and
   an accessible label. ▶ on any row keeps enqueueing as today. Its tooltip
   becomes "Run now, or after the current run finishes" while a run is live.
5. **Editing a running job.** `JobEditor` shows one line: "This job is
   running. Changes apply to its next run." The Delete button is disabled,
   with a tooltip saying why. No runner change is needed: the run already
   snapshots the job at enqueue (`runner.svelte.ts:454-464`).
6. **Chained stages go first in the queue.** `enqueue(jobId, trigger)` with
   trigger `'chained'` inserts ahead of every queued non-chained entry, and
   behind any chained entries already queued, so chained stages keep their
   own order. The queue badge's tooltip lists the queued job names in order.

## Build gate

The overview's gate.

## Test plan

- **Component, JobsTab:**
  - with a run live, selecting another job shows its editor and the bar;
  - clicking the bar shows the run view;
  - Hide returns to the selection;
  - the run never receives a cancel;
  - after the run finishes, the view stays until Close, and the bar is gone;
  - a chained run that starts while the user is browsing doesn't take over
    the pane.
- **Component, JobsTab:** with a run live, + New opens a new-job editor and
  Save works.
- **Component, JobEditor:** for the running job, Delete is disabled and the
  note shows; for any other job, neither.
- **Unit, runner:**
  - `enqueue(a,'manual')`, then `enqueue(b,'manual')`, then
    `enqueue(c,'chained')` gives the order c, a, b;
  - two chained entries keep their relative order.
- **Manual:** start a long guided-planning run. Hide it, edit another job and
  save it, queue a third job, then return through the bar. The run has kept
  going and shows the live step.

## Commit

`feat(jobs): browse and edit jobs while a run is live; chained stages go first in the queue`

## Rollback

Revert the commit. No data changes.
