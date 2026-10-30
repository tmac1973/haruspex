# Phase 04 — Jobs: research only

**Depends on:** 01, 02 · **Enables:** 05 (the `jobs.types` remote op uses the
same gate)

## Goal

In lean mode, the Jobs tab offers only the research job type. Existing jobs of
other types (audit, guided planning, autonomous coding, asset generation) stay
listed but are paused. Scheduled runs of those jobs are skipped, and a run that
is already going finishes. Turning lean mode off resumes them. A job's own
stage allowlists are not changed.

## Files touched

- `src/lib/agent/jobs/types/lean.ts` (new): `LEAN_JOB_TYPES` and
  `pausedByLean(typeId)`.
- `src/lib/agent/jobs/types/lean.test.ts` (new).
- `src/lib/agent/jobs/types/availability.svelte.ts`: `isJobTypeAvailable`
  respects lean mode.
- `src/lib/agent/jobs/runner.svelte.ts`: `enqueue` refuses paused types.
- `src/lib/agent/jobs/runner.test.ts`: lean enqueue test.
- `src/lib/components/jobs/JobList.svelte`: greyed "Paused by lean mode" state.
- `src/lib/components/settings/LeanModeSetting.svelte`: add "Job types other
  than Research" to "Off in lean mode".
- `docs/guide/jobs.md`: a short "In lean mode" section.

## Steps

1. **lean.ts.** Export `LEAN_JOB_TYPES = new Set(['research'])` and
   `pausedByLean(id: string): boolean`, which returns
   `getSettings().leanMode && !LEAN_JOB_TYPES.has(id)`.
2. **Availability.** At the top of `isJobTypeAvailable(id)`, add
   `if (pausedByLean(id)) return false;`. The platform cache stays as it is.
   The editor's type picker (`JobEditor.svelte:453`) then lists only Research
   for a new job. It still shows the current type of a job being edited,
   through its existing `|| d.id === jobType` clause.
3. **Runner.** In `enqueue` (`runner.svelte.ts:618`), right after the job type
   is found, add: if `pausedByLean(job.job_type)`, log
   `logDebug('jobs', 'enqueue skipped: paused by lean mode', { jobId, type, trigger })`
   and return `null`. That covers manual, scheduled
   (`scheduler.svelte.ts:110`) and chained runs. A run already in progress is
   not touched.
4. **Job list.** In `JobList.svelte`, compute `paused = pausedByLean(job.job_type)`.
   When it is true:
   - the row gets a `paused` class (reduced opacity) and a small "Paused by
     lean mode" tag in the meta line;
   - the run button is disabled (add `paused ||` to its `disabled`
     expression), and its `title` is "Turn off lean mode in Settings → General
     to run this". This branch comes before the platform message.
     The row still opens, so the user can read past runs.
5. **Settings list.** Add "Job types other than Research" to "Off in lean
   mode".
6. **Guide.** In `docs/guide/jobs.md`, add a section "In lean mode". It says
   that only Research jobs can be made or run, that other jobs stay listed and
   paused, that scheduled runs are skipped rather than queued, and that turning
   lean mode off resumes them. Add the same fact in one line to the settings
   page section.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Unit (`lean.test.ts`): `pausedByLean('research')` is false. With lean on,
  `pausedByLean('audit')` is true. With lean off, both are false.
- Unit (`runner.test.ts`): with lean on, `enqueue` for an audit job returns
  `null` and creates no run. A research job enqueues as usual.
- Live:
  - Make an audit job with lean mode off, then turn lean mode on. The job is
    greyed with the tag and its run button is disabled.
  - The new-job type picker lists only Research.
  - Turn lean mode off. The audit job runs.

## Commit

`feat(jobs): offer only research jobs in lean mode`

PR body names `docs/guide/jobs.md` and `docs/guide/settings.md`.

## Rollback

Revert the commit. All job types come back, and paused jobs resume on their
next schedule. Scheduled runs skipped while lean mode was on are not replayed.
