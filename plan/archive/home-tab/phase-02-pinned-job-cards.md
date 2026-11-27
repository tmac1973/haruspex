# Phase 02 — Pinned job cards

**Depends on:** 01 · **Enables:** 03 (the card ↔ job link, Run now and the
remove-card dialog that card-owned jobs reuse)

## Goal
Let a user pin any existing job to Home. The card shows the job's latest run:
its status, when it finished, and the last step's markdown output, with Run
now and Open buttons. This gives every scheduled job a place to show its
result today, and builds the card-to-job link that judged cards use in
phase 03.

## Files touched
- `src/lib/home/cardTypes.ts` — add `pinned_job` (kind `pinned`).
- `src/lib/components/home/cards/PinnedJobCard.svelte` (new).
- `src/lib/components/home/AddCardMenu.svelte` (new, split out of
  `HomeTab.svelte`) — Add card → Pinned job → job picker.
- `src/lib/components/home/JobPicker.svelte` (new) — list from `getJobs()`.
- `src/lib/components/home/CardFrame.svelte` — Refresh slot and an "updated"
  time.
- `src/lib/home/latestRun.svelte.ts` (new) — latest run per job id, derived
  from `getRunsForJob` (`stores/jobRuns.svelte.ts`).
- `src/lib/stores/homeCards.svelte.ts` — `removeCard` asks, for a card with a
  `job_id`, whether to delete the job too.
- `docs/guide/home.md`, `docs/guide/jobs.md`.

## Steps
1. Add `pinned_job` to the registry. Its config is `{}`; the job is
   `home_cards.job_id`.
2. `latestRun.svelte.ts`: `getLatestRun(jobId)` returns `{ latest,
   latestSucceeded }` — the newest run of any status and the newest
   succeeded run, each with its steps (via `getJobRun`). It calls
   `loadRunsForJob(jobId)` once, then reads the reactive `getRunsForJob`,
   which `createJobRun` and `markRunFinished` already reload. Steps are
   cached per run id and refetched when that run's status changes. The
   engine's `job-run` events are not used: they run only with Remote control
   on and do not reach desktop listeners.
3. `PinnedJobCard`: header is the job name. Body is `latestSucceeded`'s last
   step `output`
   rendered with `ChatMessage` (assistant role), clamped to 12 lines with a
   Show more toggle; when `latest` failed, its error shows above that output. While a run is live
   for this job, show the current step name and "Running". Buttons: Run now
   (`enqueue(jobId, 'manual')`, disabled while one is queued or running) and
   Open (`selectJob(jobId, runId)` from phase 01, then
   `setActiveTab('jobs')`). The CardFrame
   Refresh button is Run now for this card.
4. When `job_id` is null (the job was deleted), the body says "This job was
   deleted." and the menu offers Remove only.
5. Remove dialog for a card with a job: `ConfirmDialog` (confirm label
   "Remove card") with a `children` snippet holding an "Also delete the job"
   checkbox. Pinned jobs leave it unchecked. The dialog has one confirm, so
   the checkbox carries the second choice.
6. Update `home.md` (pinning a job). `jobs.md` is 16 bytes under the 6 KB
   page limit (`guide/pages.test.ts`), so it gets no new line here; phase 03
   trims it before adding to it.

## Build gate
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test`
- `node scripts/guide-check.mjs` passes

## Test plan
- Unit: `latestRun` picks the newest run and the newest succeeded run, and
  updates when `getRunsForJob` changes. Its step cache has a
  `_resetForTests()` (Vitest runs shuffled).
- Component: `PinnedJobCard` renders output, error and deleted states; Run now
  is disabled while a run for the job is queued.
- Hand: pin a scheduled research job; wait for it to fire; the card updates
  without a reload. Delete the job in the Jobs tab; the card shows the deleted
  state.

## Commit
`feat(home): pin any job to Home and show its latest output`

## Rollback
Revert the commit. Existing `pinned_job` rows show as "Unknown card" with
Remove only, through the guard phase 01 added.
