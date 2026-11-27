# Phase 06 — Background image generation, with reattach

**Depends on:** 04, 05 · **Enables:** background music (07) and video
generation (08), which reuse the runner

## Goal

`generate_image`, `edit_image` and `upscale_image` take `background: true`.
The tool records a task and returns at once, and the main window's task runner
does the generation on whichever image backend is selected (toolchest,
ComfyUI, the bundled sd-server or Lemonade). When it ends, the owner's notice
turn carries the same text a blocking call would have returned, and the
picture is attached when the model can see.

Server-side jobs (toolchest, ComfyUI) record their job reference, so a restart
reattaches to them. sd-server and Lemonade tasks run one at a time, and if the
app closes mid-task they fail with a notice.

## Files touched

- `src/lib/tasks/runner.svelte.ts` (new) — the task runner. It runs only in
  the main window.
- `src/lib/tasks/runner.test.ts` (new).
- `src/lib/tasks/followers.ts` (new) — the registry of followers by kind
  (`image` now; `music` and `video` in later phases).
- `src/lib/image/backend.ts` — the `ImageBackend` interface gains an optional
  `submit` / `follow` pair beside `generate`.
- `src/lib/image/toolchest/backend.ts` — `submit` (create the job and return
  `{ jobId }`) and `follow(handle)` (`followJob`, then download), split out of
  `runJob`.
- `src/lib/image/comfyui/backend.ts`, `src/lib/image/comfyui/client.ts` —
  `submit` (queue the prompt and return `{ promptId }`) and `follow(handle)`
  (WebSocket progress plus the history poll), split out of `run`.
- `src/lib/image/local/backend.ts`, `src/lib/image/lemonade/backend.ts` — no
  `submit`/`follow`. The runner calls `generate`.
- `src-tauri/src/image_engine.rs`, `src-tauri/src/lemonade.rs` — a
  per-engine lock around generation requests (step 5a).
- `src/lib/image/forTool.ts` — `upscaleForTool` split the same way for the
  ComfyUI upscaler.
- `src/lib/agent/tools/image-gen.ts`, `image-edit.ts`, `image-upscale.ts` —
  the `background` parameter; the description lines.
- `src/lib/agent/tools/image-gen.ts` — `answerWithImage` split into
  `storeToolImage` (store and register) and `imageResultText` (the text), so
  the runner builds the same text.
- `src/lib/tasks/noticeText.ts` — image notices, with the picture attached.
- `src/lib/components/tasks/ImageTaskResult.svelte` (new) — a thumbnail that
  opens the image viewer.
- `src/lib/components/tasks/TaskCard.svelte` — use `ImageTaskResult` for
  `image`.
- `src/lib/stores/chat.svelte.ts`, `src/lib/stores/code.svelte.ts` — a notice
  turn's user message carries image parts.
- `src/routes/+layout.svelte` — start the runner in the main window.
- `docs/guide/images.md`, `docs/guide/image-editing.md` — ask for an image in
  the background.

## Steps

1. `ImageBackend` additions:

   ```ts
   submit?(req: ImageRequest, opts: GenerateOptions): Promise<unknown>; // JSON handle
   follow?(handle: unknown, opts: GenerateOptions): Promise<ToolImage[]>;
   ```

   `generate` on toolchest and ComfyUI becomes `follow(await submit(…))`, so
   blocking calls go through the same code.
2. The task `spec` for `image`:
   - `{ op: 'generate' | 'edit' | 'upscale', backend: <backend id at start>,
     server: { url, instance? }, request: ImageRequest, sourceHash?: string,
     alt, save: SaveTarget | null, conversationId?, codeSessionId?,
     visionSupported }`
   - `server` is the server URL and toolchest instance in force at start.
     Submitting and reattaching both use it, never the current settings, so a
     job is always followed on the server that has it. API keys aren't
     stored in the spec; they're read from the secret store for that URL
     when the follower runs.
   - The runner never checks the live Settings → Image: a task runs on the
     backend and server its spec names, even if the setting changed since.
     If that backend is no longer reachable (sd-server stopped, server gone),
     the task fails with the backend's own error.
   - An edit's or upscale's source image is resolved to its image-cache hash
     when the tool runs, so the spec holds no data URLs.
3. Where it's offered: the `background` parameter is in the tool schema
   only when the turn has a Chat or Code owner (`ctx.conversationId` or
   `ctx.codeSessionId`) and isn't a Shell turn or a scheduled job. In the
   Shell and in jobs the tools are as today, with no parameter, so
   `taskOwner(ctx)` is never called without an owner.

   Tool behaviour with `background: true`:
   - Validate the arguments exactly as for a blocking call.
   - `task_create({ kind: 'image', owner: taskOwner(ctx), label, follower:
     'frontend', spec })`.
   - Return the `{kind:'task'}` artifact and: “Started in the background (task
     <id>). You'll get a notification turn here when it finishes — do NOT poll
     for it; continue with other work or wrap up.”
   - Description line for the parameter: “Set background to true for a batch
     or anything slow; the result arrives later as a notification.”
4. The runner (`runner.svelte.ts`) starts from `+layout.svelte` only when the
   window label is `main`:
   - On start and on every `task://changed`, it picks up `frontend` tasks in
     `pending` and runs each through its kind's follower. `running` tasks
     found at start are reattached (step 6).
   - It keeps an `inFlight: Map<id, AbortController>` and skips any task
     already in it, so a task is never dispatched twice. Entries are removed
     when the follower settles.
   - Tasks run concurrently. Toolchest and ComfyUI queue on the server.
     sd-server and Lemonade can't queue, so their generation requests take a
     per-engine lock in Rust (step 5a). Background tasks and blocking calls
     from every window wait on the same lock.
   - When `task_update` reports that the task no longer exists (its owner
     was deleted), the runner aborts that follower and drops it from
     `inFlight`.
   - It listens for `task://cancel` and aborts that task's `AbortController`.
     The existing abort paths send `DELETE` to toolchest and `cancelPrompt` to
     ComfyUI.
   - Progress goes to `task_update` (percent, phase, queue_position),
     throttled to once a second.
5. The image follower:
   - **Toolchest / ComfyUI:** `task_update({ state: 'running' })` with no
     handle first, then `submit`, then `task_update({ handle })`, then follow.
     Recording `running` before submitting means a crash can never submit a
     job twice: on relaunch, a `running` task with no handle fails (step 6).
     A crash between submit and recording the handle leaves one job the app
     doesn't follow. It runs to the end on the server, which deletes it, and
     that's accepted.
   - **sd-server / Lemonade:** `task_update({ state: 'running' })`, then
     `generate`.
   - On success: `storeToolImage` with the owner's conversation/session id,
     write the save target if any, and `task_update({ state: 'done', result: {
     hash, width, height, model, seed, notes, savedLine } })`.
   - On failure or cancel: `failed` with the message, or `cancelled`.
5a. Rust lock: `image_engine_request` (`src-tauri/src/image_engine.rs`) and
    `lemonade_json` / `lemonade_upload` for the generate and edit routes
    (`src-tauri/src/lemonade.rs`) each hold a `tokio::sync::Mutex` (one per
    engine) for the length of the request. Catalogue and status routes don't
    take it. A request cancelled while waiting for the lock is dropped
    without being sent.
6. Reattach at runner start, for each `frontend` task in `running`:
   - With a `handle` and a backend that has `follow`: call `follow(handle)`.
     If the server no longer knows the job (404, or failed polls exhausted),
     fail it with “The server no longer has this job.”
   - Otherwise (sd-server, Lemonade, or no handle yet): fail it with “Ended
     when the app closed.”
7. Notices: `noticeFor` for `image` builds `imageResultText` from `result`.
   When `spec.visionSupported`, it returns the image's
   `haruspex-image:` URL in `images`, which Chat and Code turn into an image
   part on the notice's user message (the same shape `sendMessage` builds
   for pasted images). At most `MAX_PENDING_IMAGES` per notice turn.
8. `ImageTaskResult` shows the thumbnail. Clicking opens the existing image
   viewer.
9. Guide: a “Generate in the background” section in `docs/guide/images.md`
   and a line in `docs/guide/image-editing.md`.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `cd src-tauri && cargo test && cargo clippy && cargo fmt -- --check`
- `./scripts/export-ipc-types.sh`, leaving no diff

## Test plan

- Unit (`runner.test.ts`, with fake backends):
  - A pending task runs, and its progress reaches `task_update`.
  - It ends Done with the result.
  - Cancel aborts and ends Cancelled.
  - Two toolchest tasks run together.
- Rust: two concurrent `image_engine_request` calls run one after the other,
  and a cancelled waiter is never sent.
- Unit: reattach follows a toolchest handle to Done. A 404 handle fails with
  “no longer has this job”. A running sd-server task fails with “Ended when
  the app closed.”
- Unit:
  - Tool with `background: true` creates a task and returns the start text.
  - `background: false` is unchanged (the existing image-gen tests pass).
- Unit: `noticeFor(image)` text equals the blocking result text, and images
  are attached only when vision is supported.
- Manual, on toolchest:
  - Ask for “four variations in the background”. Four cards appear and the
    turn ends.
  - Chat in another conversation meanwhile.
  - Each image arrives as a notice turn with the picture placed.
- Manual: quit mid-job, relaunch, and the job is reattached and finishes.
- Manual: the same on ComfyUI and on sd-server, where an sd-server task
  interrupted by quitting is reported as failed.

## Commit

`feat(images): generate, edit and upscale in the background`

## Rollback

Revert the commit. Any `image` tasks left in the registry stay `pending` /
`running` with no runner, so clear them with a one-off `DELETE FROM
background_tasks WHERE kind = 'image'`, or leave them: the cards show them
stuck but harmless. The backend `submit`/`follow` split is internal, and the
revert restores `run`/`runJob`.
