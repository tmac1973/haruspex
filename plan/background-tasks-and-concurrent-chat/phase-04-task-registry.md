# Phase 04 — The background-task registry, with video tasks moved onto it

**Depends on:** 01, 02 · **Enables:** the task UI (05), background image (06),
music (07) and video generation (08)

## Goal

One registry for background work, owned by a Chat conversation or a Code
session.
- Rust owns the records: a `background_tasks` SQLite table, an in-memory
  index, and a change event that every window sees.
- It also owns the notices that are waiting for their owner, so neither
  tasks nor notices are lost on a reload or restart.
- The existing video render and YouTube upload tasks move onto it.
  `taskWatch.ts` is replaced by registry-driven notices, and the model gets
  generic `task_status` / `task_cancel` tools.
- Nothing new runs in the background yet. That starts in phase 06.

## Files touched

- `src-tauri/src/tasks/mod.rs` (new) — the `BackgroundTask` type, the
  `BackgroundTasks` state, the event, and the launch sweep.
- `src-tauri/src/tasks/commands.rs` (new) — the task commands.
- `src-tauri/src/db/tasks.rs` (new) and `src-tauri/src/db/mod.rs` — the
  table, migration and queries.
- `src-tauri/src/db/conversations.rs`, `src-tauri/src/db/code_sessions.rs` —
  deleting an owner deletes its tasks and cancels running ones.
- `src-tauri/src/video/tasks.rs`, `src-tauri/src/video/commands.rs` — renders
  and uploads report through `BackgroundTasks`. The `VideoTasks` map stays
  only as the holder of cancel channels and the one-render / one-upload rule.
- `src-tauri/src/lib.rs` — manage `BackgroundTasks`, register the commands,
  remove `video_task_status` / `video_task_list` / `video_task_cancel`, and
  run the launch sweep.
- `src/lib/ipc/gen/*` — regenerated.
- `src/lib/tasks/store.svelte.ts` (new) — the event-mirrored task list,
  `getTasks(owner?)`, `getTask(id)`.
- `src/lib/tasks/notices.ts` (new) — replaces `src/lib/video/taskWatch.ts`:
  owner handlers, `takeNotices(owner)`, `isTaskNotice`.
- `src/lib/tasks/noticeText.ts` (new) — the notice text for each kind (the
  video text moves here from `taskWatch.ts`).
- `src/lib/tasks/types.ts` (new) — the per-kind `result` types.
- `src/lib/video/taskWatch.ts`, `src/lib/video/tasks.svelte.ts` — deleted;
  callers move to `#lib/tasks/…`.
- `src/lib/agent/tools/video.ts`, `src/lib/agent/tools/youtube-upload.ts` —
  record the task through the registry; remove `video_render_status` /
  `video_render_cancel`.
- `src/lib/agent/tools/tasks.ts` (new) — `task_status` and `task_cancel`.
- `src/lib/agent/tools/index.ts` — register them.
- `src/lib/stores/chat.svelte.ts`, `src/lib/stores/code.svelte.ts` — deliver
  registry notices instead of video notices.
- `src/lib/components/video/VideoTaskCard.svelte` — read from
  `#lib/tasks/store.svelte.ts`. Its generic replacement comes in phase 05.
- `src/routes/+layout.svelte` — `initTasks()` replaces `initVideoTasks()`.
- `docs/guide/video-render.md` — the status and cancel tools are renamed;
  tasks survive a restart as failed notices.

## Steps

1. Rust type, `#[ts(export)]` in `src-tauri/src/tasks/mod.rs`:

   ```rust
   pub struct BackgroundTask {
       pub id: String,
       pub kind: TaskKind,          // VideoRender | YoutubeUpload | Image | Music | Video
       pub owner: String,           // "chat:<id>" | "code:<id>"
       pub label: String,
       pub state: TaskState,        // Pending | Running | Done | Failed | Cancelled
       pub follower: TaskFollower,  // Rust | Frontend
       pub percent: Option<f32>,
       pub eta_secs: Option<u64>,
       pub phase: Option<String>,
       pub queue_position: Option<u32>,
       pub spec: serde_json::Value,           // what to run; Frontend tasks only
       pub handle: Option<serde_json::Value>, // the server's job reference
       pub result: Option<serde_json::Value>, // kind-specific; Done only
       pub error: Option<String>,
       pub log_tail: Option<String>,
       pub started_ms: u64,
       pub ended_ms: Option<u64>,
       pub notice_delivered: bool,
   }
   ```

   All three enums are `#[serde(rename_all = "snake_case")]`, so TS and the
   DB see `'video_render'`, `'youtube_upload'`, `'image'`, `'music'`,
   `'video'`; `'pending'`, `'running'`, `'done'`, `'failed'`, `'cancelled'`;
   and `'rust'`, `'frontend'`. `TaskState::Done` carries no payload. The kind-specific result (a video
   render's path and `RenderCheck`; an upload's URLs and visibility) goes in
   `result` as JSON with a TS type per kind in `src/lib/tasks/types.ts`.
2. Table `background_tasks`:
   - columns: `id` PK, `kind`, `owner`, `label`, `state`, `follower`,
     `spec` TEXT, `handle` TEXT, `result` TEXT, `error`, `log_tail`,
     `started_ms`, `ended_ms`, `notice_delivered`
   - an index on `owner`
   - `percent` / `eta_secs` / `phase` / `queue_position` are memory-only:
     they're lost on restart and repopulated by the follower.
3. `BackgroundTasks` (managed state) keeps an `Arc<Mutex<HashMap<id,
   BackgroundTask>>>` loaded from the DB at launch. Every change writes
   through to SQLite, except progress-only changes. It emits `task://changed`
   with the full task, throttled to 500 ms per task for progress, as video
   does today.
4. Commands (domain-first names):
   - `task_create(kind, owner, label, follower, spec) -> BackgroundTask`
   - `task_update(id, patch)`: state, handle, progress fields, result, error,
     log_tail. Only for `Frontend` tasks; Rust followers update in-process.
   - `task_list(owner: Option<String>)`: every task, or one owner's. Includes
     tasks that ended within the last 30 days.
   - `task_cancel(id)`: for `Rust` tasks, fires the cancel channel. For
     `Frontend` tasks, emits `task://cancel` with the id, for the runner in
     phase 06.
   - `task_take_notices(owner) -> Vec<BackgroundTask>`: ended tasks with
     `notice_delivered = false`, marked delivered in the same transaction.
     Marking on take is deliberate: a crash between the take and the notice
     turn loses that notice, but the task's card still shows the result, and
     it can never be delivered twice.
   - `task_open(id)` replaces `video_task_open`.
5. Launch sweep, after the DB opens:
   - `Rust`-followed tasks still `Pending`/`Running` become `Failed` with
     error “Ended when the app closed.” and `notice_delivered = false`, so the
     owner gets a notice.
   - `Frontend` tasks are left alone for the phase 06 runner, and until it
     exists nothing creates them.
   - Delete ended tasks older than 30 days.
6. Owner deletion: `delete_conversation` and the Code session delete call
   `BackgroundTasks::remove_owner(owner)`, which cancels running tasks and
   deletes the rows. For `Frontend` tasks, cancelling emits `task://cancel`
   before the rows go. `task_update` on an id that no longer exists returns
   a `TaskGone` error, which the phase 06 runner treats as a cancel.
7. Video: `start_render` / `start_upload` call `BackgroundTasks::create`
   (`follower: Rust`) instead of inserting into their own map, and their
   progress/finish paths call `BackgroundTasks::update`. `VideoTasks` keeps
   only `HashMap<id, oneshot::Sender>` for cancelling and the
   one-at-a-time-per-kind rule.
8. TS store `src/lib/tasks/store.svelte.ts` mirrors the list the way
   `inferenceQueue.svelte.ts` mirrors the queue: listen to `task://changed`
   and seed from `task_list`. When a task first enters an ended state, call
   `notices.noteEnded(task)`.
9. `src/lib/tasks/notices.ts`:
   - `taskOwner(ctx)` moves here from `taskWatch.ts`, renamed from
     `videoOwner`; `video.ts`, `youtube-upload.ts` and the task tools call it.
   - Handlers per owner, plus the `chat:*` wildcard. Chat conversations live
     only in the main window, so only the main window registers `chat:*`
     and delivers Chat notices. Other windows mirror the store for their
     cards but take no Chat notices.
   - A Code session registers its handler when it is loaded into a window. A
     task that ends for a session that isn't loaded has no handler; its
     notice stays in the DB until the session is opened and takes it at load.
   - `noteEnded` calls the owner's handler.
   - Owners call `takeNotices(owner)` (→ `task_take_notices`) when they're
     idle.
   - At startup, each store calls `takeNotices` for its owners once it's
     loaded, so notices left over from before a restart are delivered.
   - `isTaskNotice(text)` recognises the opening of every notice kind.
10. `noticeText.ts`: `noticeFor(task): { text: string; images: string[] }`.
    Video kinds move `buildVideoNotice` here unchanged. `images` is empty
    until phase 06. Several notices for one owner join into one turn,
    separated by blank lines.
11. Chat (`deliverNotices` from phase 02) and Code (`flushWatchNotifications`
    at `code.svelte.ts:672`) call `takeNotices(owner)` where they called
    `takeVideoNotices`. The order in Code stays watches → task notices →
    subtasks.
12. Tools in `src/lib/agent/tools/tasks.ts`:
    - `task_status(id?)`: a short line per task the current owner has,
      running or ended in the last day.
    - `task_cancel(id)`: asks the user through `ctx.askUser` (as
      `video_render_cancel` does), then `task_cancel`.
    - Both are offered only when the owner has at least one task.
    - Remove `video_render_status` / `video_render_cancel` and update the
      video tool descriptions that mention them.
13. Run `./scripts/export-ipc-types.sh`.
14. Guide: in `docs/guide/video-render.md`, rename the tools and add that a
    render cut short by quitting is reported when the app next opens.

## Build gate

- `cd src-tauri && cargo test && cargo clippy && cargo fmt -- --check`
- `./scripts/export-ipc-types.sh`, leaving no diff
- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`

## Test plan

- Rust:
  - create → update → done → `task_take_notices` returns it once.
  - The launch sweep fails `Rust` running tasks and leaves `Frontend` ones.
  - Deleting an owner removes its tasks.
  - The 30-day prune works.
- Rust: the video render path writes progress and its final state through
  `BackgroundTasks` (adapt the existing `video/tasks.rs` tests).
- TS:
  - The store mirrors events.
  - `noteEnded` calls the right handler.
  - `noticeFor` builds video text identical to today's (port
    `taskWatch.test.ts`).
- TS: `task_cancel` asks before cancelling, and `task_status` lists only the
  owner's tasks.
- Manual:
  - Start a render, quit the app mid-render, and relaunch. The conversation
    gets a “failed: Ended when the app closed.” notice turn.
  - A completed render still notifies as before in Chat and Code.

## Commit

`feat(tasks): a background-task registry, with video renders and uploads on it`

## Rollback

Revert the commit. The `background_tasks` table stays, unused, which is
harmless. The removed `video_task_*` commands and tools come back with the
revert. Don't partly apply: the video Rust path and the TS notice delivery
change together.
