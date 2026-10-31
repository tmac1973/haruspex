# Phase 03 — Card job infrastructure

**Depends on:** 01, 02 · **Enables:** 04, 06 (judged card types), 07
(actions on judged items)

## Goal
Build what every judged card needs, with no card type yet: a validated
structured result per run, a background class in the inference queue so card
jobs always give way to chat and code on the same model, the launch catch-up
behaviour stated correctly in the UI, the plumbing for a card that owns its
job, and opt-in notifications for new items. After this phase a judged card
type is only a job type, a card component and a registry entry.

## Files touched
- `src-tauri/src/db/mod.rs` — `ALTER TABLE job_runs ADD COLUMN result_json
  TEXT NULL`.
- `src-tauri/src/db/runs.rs` — `set_run_result(run_id, json)`; include
  `result_json` in `get_job_run`, `list_job_runs` and `list_recent_runs`.
- `src-tauri/src/db/commands.rs` — `db_job_runs_set_result`.
- `src-tauri/src/inference_queue.rs` — background class and lane
  reservations (steps 2–3).
- `src/lib/ipc/gen/*` — regenerated.
- `src/lib/agent/inferenceQueue.svelte.ts` — `priority` option on
  `withInferenceSlot`; `HeldSlot.release()` passes `reserve: true`.
- `src/lib/agent/jobs/types/types.ts` — `JobTypeDefinition` gains
  `background?: boolean` and `resultSchema?: ResultSchema`; `JobRunContext`
  gains `setResult(value: unknown): Promise<void>`.
- `src/lib/agent/jobs/runner.svelte.ts` — background priority for those
  types; `setResult` implementation.
- `src/lib/agent/jobs/cardResult.ts` (new) — `ResultSchema`, `validate`,
  `parseModelJson`, `keepKnownIds`, `pickWithRetry`.
- `src/lib/stores/jobRuns.svelte.ts` — `result_json` on run types.
- `src/lib/components/jobs/JobScheduleField.svelte` — launch catch-up copy.
- `src/lib/agent/jobs/scheduler.svelte.ts` — header comment.
- `src/lib/home/cardTypes.ts` — registry fields `notifies?: boolean`,
  `jobType?: JobType`, `itemLabel?(item): string`, `defaultSchedule?:
  Schedule` (the Add card form's preset interval).
- `src/lib/home/cardJobs.ts` (new) — `createCardJob`.
- `src/lib/stores/homeCards.svelte.ts` — `addCard` with a created job;
  remove-dialog default for owned jobs; new-run hook calling
  `notifyNewItems`; exported `ownedJobIds()`.
- `src/lib/home/notifyNewItems.ts` (new).
- `src/lib/components/home/CardFrame.svelte` — Notify on new items toggle;
  Edit job item.
- `src/lib/components/home/cards/JobsCard.svelte` — "waiting for chat"
  label.
- `src/lib/components/jobs/JobList.svelte` — "Home" badge.
- `docs/guide/jobs.md`, `docs/guide/home.md`.

## Steps
1. Migration and `set_run_result`; regenerate IPC types.
2. Inference queue, background class: `Ticket` gains `priority: Foreground |
   Background` (serde `"foreground" | "background"`, default foreground);
   `inference_acquire` takes `priority: Option<String>`; `TicketDto` carries
   it. In `pump`, a waiting background ticket is admitted only when its lane
   has capacity, no foreground ticket on that lane is running or waiting, and
   the lane has no reservation (step 3). A running background ticket is never
   pre-empted. Lanes stay independent: a chat on the remote lane does not
   hold a card job on the local lane, because they do not share a model.
3. Lane reservations: `inference_release` takes `reserve: Option<bool>`.
   With `true`, the released ticket leaves a reservation on its lane, keyed by
   the ticket's turn and owned by its window, that blocks background tickets
   only. The reservation ends when that turn reacquires (a `front` acquire
   from the same window), on `release_window`, or after the lease timeout the
   sweeper already enforces. `HeldSlot.release()` (a turn giving its slot
   back during a long tool) passes `reserve: true`; the final release in
   `finally` passes nothing. So a chat or code turn blocks card jobs for its
   whole life, not only while it holds a slot.
4. Runner: `runJobTurn` passes `priority: 'background'` when
   `getJobType(job.job_type)?.background` is true. `RunState.waitingForSlot`
   already marks the wait; `JobsCard` shows "Waiting for chat" when
   `getCurrentRun()` is waiting and `getJobType(run.jobType)?.background` is
   true, "Waiting for model" otherwise.
5. `cardResult.ts`:
   - `ResultSchema = { idField: string; fields: Record<string, 'string' |
     'number'>; max: number }`, describing one item of `{ items: [...] }`.
   - `validate(value, schema)` accepts `{ items }` where each item has the
     id field and every listed field with the right type. Extra fields are
     removed, not rejected. More than `max` items are cut to `max`.
   - `parseModelJson(text)` strips code fences and parses the first JSON
     object in the text.
   - `keepKnownIds(items, knownIds)` drops unknown ids and returns
     `{ items, dropped }`.
   - `pickWithRetry(ctx, prompt, schema, knownIds)` runs one model turn,
     parses, validates and filters; on a parse or validation error it runs
     one more turn that quotes the error; if that also fails it throws with
     the second error. The caller marks the step failed with that message.
6. `setResult(value)` is called by a pipeline after it has added its own
   source fields (phases 04 and 06 add `source`). It stores the value with
   `db_job_runs_set_result` as given; validation of model output happens in
   `pickWithRetry`, before the pipeline enriches it.
7. Freshness: the scheduler already fires an overdue job once at launch
   (`list_due_jobs` returns `next_due_at <= now`; `computeNextDueAt` skips
   ahead). Add a scheduler test that holds this. Change `JobScheduleField`
   copy to "Runs once at launch if a run was missed while the app was
   closed." Update the scheduler header comment to match.
8. `createCardJob(cardType, typeConfig, schedule)`: reads the card type's
   `jobType`, creates the job with that type's `configDefaults()` merged with
   `typeConfig`, the job name from the card title, the given schedule, and
   `next_due_at = Date.now()` so it runs at once; returns the job id.
   `homeCards.addCard` stores it as `job_id`. The remove dialog from phase 02
   defaults to "Remove card and delete job" when the card's type has a
   `jobType` (owned), and to "Remove card" for pinned jobs.
9. `ownedJobIds()` returns the set of `job_id`s whose card type has a
   `jobType`. `JobList` shows a "Home" badge on those jobs. This is the only
   Jobs tab change in this phase.
10. CardFrame menu gets Edit job for cards with a `job_id`, using the
    `selectJob` function phase 01 added to `jobsTabSelection.svelte.ts`.
11. `notifyNewItems(card, prevResult, nextResult)`: when `card.notify` is on,
    `prevResult` exists, and `nextResult.items` has ids not in `prevResult`,
    call `notify(cardTitle, label)` where `label` is the card type's
    `itemLabel(firstNewItem)`, plus " and N more" when there are several.
    `homeCards` calls it when a `job-run` event brings a new succeeded run
    for a card's job, comparing with the run before it.
12. CardFrame menu shows Notify on new items for card types with
    `notifies: true`; it writes `notify` through `db_home_cards_update`.
13. Docs: `jobs.md` gets the launch catch-up sentence and the Home badge;
    `home.md` gets Notify on new items and Edit job.

## Build gate
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff
- `node scripts/guide-check.mjs` passes

## Test plan
- Rust queue: a background ticket waits while a foreground ticket on its lane
  is running or waiting; it waits while a reservation is held and starts when
  the reservation's turn finally releases; a reservation ends on
  `release_window` and on lease expiry; a foreground ticket enqueued while a
  background ticket waits is admitted first; a background ticket on another
  lane is not blocked.
- Unit: `cardResult` — fenced JSON parses; wrong field types fail; extra
  fields are removed; unknown ids are dropped; `max` is enforced;
  `pickWithRetry` retries once with the error and then throws.
- Unit: scheduler — a job overdue by three intervals fires once and its next
  due time is in the future.
- Unit: `notifyNewItems` — no call when off, for the first result, or when
  ids are unchanged; label uses `itemLabel`.
- Unit: runner with a fixture job type that sets `background` (in
  `runner.fixtures.ts`) — every `withInferenceSlot` call for its run carries
  `priority: 'background'`; a non-background type's calls do not.
- The hand test of chat-versus-card-job timing runs in phase 04, the first
  phase that ships a background type.

## Commit
`feat(jobs): background inference priority and validated run results for Home cards`

## Rollback
Revert the commit. `result_json` stays as an unused nullable column. With the
queue change reverted every ticket is foreground and no reservations exist,
which is today's behaviour.
