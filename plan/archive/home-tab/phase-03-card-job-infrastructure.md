# Phase 03 — Card job infrastructure

**Depends on:** 01, 02 · **Enables:** 04, 06 (judged card types), 07
(actions on judged items), 09 (notifications)

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
  `withInferenceSlot`; `HeldSlot.release()` passes `reserve: true`; the
  take-back acquire passes `replaces`.
- `src/lib/agent/jobs/types/types.ts` — `JobTypeDefinition` gains
  `background?: boolean` and `resultSchema?: ResultSchema`; `JobRunContext`
  gains `setResult(value: unknown): Promise<void>`.
- `src/lib/agent/jobs/runner.svelte.ts` — background priority for those
  types; `setResult` implementation.
- `src/lib/agent/jobs/runner.fixtures.ts` — `mockModules.inferenceQueue`
  becomes a `vi.fn` in `mocks`, so tests can read each call's options.
- `src/lib/agent/jobs/cardResult.ts` (new) — `ResultSchema`, `validate`,
  `parseModelJson`, `keepKnownIds`, `pickWithRetry`.
- `src/lib/stores/jobRuns.svelte.ts` — `result_json` on run types.
- `src/lib/components/jobs/JobScheduleField.svelte` — launch catch-up copy in
  the tooltip and the warning.
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
- `src/lib/stores/jobRuns.svelte.ts` — `markRunFinished` unchanged; the
  runner writes `setResult` before it (step 6).
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
3. Lane reservations. No turn id crosses IPC: `HeldSlot`'s take-back mints
   a new `reqId`, and Rust knows tickets only by req id. So a reservation is
   keyed by the released req id:
   - `inference_release` takes `reserve: Option<bool>`. With `true`, the
     released ticket leaves a reservation on its lane, keyed by its req id
     and owned by its window, that blocks background tickets only.
     `HeldSlot.release()` (a turn giving its slot back during a long tool)
     passes `reserve: true`.
   - `inference_acquire` takes `replaces: Option<String>`. The take-back
     acquire (a `front` acquire) passes the req id it released, and that
     reservation ends as the new ticket is enqueued.
   - The final `inference_release` in `finally` passes no `reserve`. When the
     turn never took its slot back, `turn.reqId` is still the released id,
     so `release` also ends a reservation with that id.
   - `heartbeat` refreshes a reservation's lease as well as a ticket's. The
     turn keeps pinging `turn.reqId` after a release, so a tool that runs
     longer than `LEASE_TTL_MS` (5 min) keeps its reservation.
   - A reservation also ends on `release_window` and when its lease runs out
     in the sweeper.
   So a chat or code turn blocks card jobs for its whole life, not only
   while it holds a slot. New mutex sites use `lock_or_recover()`
   (`crate::sync_util::LockExt`), as the rest of the file does.
4. Runner: both `withInferenceSlot` calls in `runner.svelte.ts` (the job
   turn in `runJobTurn` and the tool-feedback turn) pass `priority:
   'background'` when `getJobType(job.job_type)?.background` is true. `RunState.waitingForSlot`
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
   `pickWithRetry`, before the pipeline enriches it. The write is awaited
   before the runner calls `markRunFinished`, because that call's
   `loadRunsForJob` is what Home reads; a later write would leave Home on
   the old result.
7. Freshness: the scheduler already fires an overdue job once at launch
   (`list_due_jobs` returns `next_due_at <= now`; `computeNextDueAt` skips
   ahead). Add a scheduler test that holds this. In `JobScheduleField`,
   replace the warning ("Missed runs while the app is closed are dropped…")
   with "Runs once at launch if a run was missed while the app was closed.",
   and change the tooltip's "dropped, not retro-run on next launch" sentence
   to say a missed run fires once at the next launch. Update the scheduler
   header comment to match. New scheduler and runner warnings use
   `console.warn`, as the scheduler now does.
8. `createCardJob(cardType, typeConfig, schedule)`: reads the card type's
   `jobType`, creates the job with that type's `configDefaults()` merged with
   `typeConfig`, the job name from the card title, the given schedule, and
   `next_due_at = Date.now()` so it runs at once, then calls
   `homeCards.addCard(cardType, {}, jobId)` so the card stores it as
   `job_id`, and returns the card. A form calls only `createCardJob`. The remove dialog from phase 02
   checks "Also delete the job" by default when the card's type has a
   `jobType` (owned), and leaves it unchecked for pinned jobs.
9. `ownedJobIds()` returns the set of `job_id`s whose card type has a
   `jobType`. `JobList` shows a "Home" badge on those jobs. This is the only
   Jobs tab change in this phase.
10. CardFrame menu gets Edit job for cards with a `job_id`, using the
    `selectJob` function phase 01 added to `jobsTabSelection.svelte.ts`.
11. `notifyNewItems(card, prevResult, nextResult)`: when `card.notify` is on,
    `prevResult` exists, and `nextResult.items` has ids not in `prevResult`,
    call `notify(cardTitle, label)` where `label` is the card type's
    `itemLabel(firstNewItem)`, plus " and N more" when there are several.
    `homeCards` calls it from an `$effect` (inside `$effect.root`, since the
    store is a module, not a component) per owned card that watches
    `getLatestRun(jobId).latestSucceeded` (phase 02): when its id changes,
    it compares the new result with the one before it. The engine's
    `job-run` events are not used (they need Remote control on).
12. CardFrame menu shows Notify on new items for card types with
    `notifies: true`; it writes `notify` through `db_home_cards_update`.
13. Docs: in `jobs.md`, replace "a run due while it is closed is dropped,
    not run later" with "a run missed while it is closed runs once at the
    next launch", and add one short line on the Home badge. The page is 16
    bytes under the 6 KB limit (`guide/pages.test.ts`), so shorten another
    sentence on it by as much as these add. `home.md` gets Notify on new
    items and Edit job.

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
- Rust queue: a `front` acquire with `replaces` ends that reservation; a
  final release of the reserved id ends it; heartbeats on a reserved id keep
  it past `LEASE_TTL_MS`.
- Unit: runner with a fixture job type that sets `background` (in
  `runner.fixtures.ts`) — every `withInferenceSlot` call for its run,
  feedback included, carries `priority: 'background'`; a non-background
  type's calls do not. `setResult` is written before `markRunFinished`.
- Unit: `inferenceQueue` — `release()` sends `reserve: true`; the take-back
  sends `replaces` with the released id. `takeBack` sets `turn.reqId =
  nextReqId()` first today, so it must keep the old id before that line. Invoke mocks use `invokeRouter`.
- The hand test of chat-versus-card-job timing runs in phase 04, the first
  phase that ships a background type.

## Commit
`feat(jobs): background inference priority and validated run results for Home cards`

## Rollback
Revert the commit. `result_json` stays as an unused nullable column. With the
queue change reverted every ticket is foreground and no reservations exist,
which is today's behaviour.
