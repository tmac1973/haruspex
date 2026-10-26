# Phase 08 — Toolchest video generation

**Depends on:** 04, 05, 06 · **Enables:** nothing later depends on it

## Goal

A `generate_video` tool for Chat and Code that runs a llama-toolchest video
instance's job. It always runs in the background through the phase 06 runner,
and reattaches after a restart. The finished video is downloaded into a new
app video cache (toolchest deletes outputs after about a day). The cache is
tied to the conversation or session and deleted with it, and a `save_as`
copies the video into the working folder.

## Before starting

The toolchest video API wasn't final when this was planned. This phase
assumes it follows the image/music job lifecycle. Confirm these against the
shipped API and adjust only the names in steps 1–2. The design doesn't change
if they hold:
- How instances advertise video: a `video` capability in the instance list,
  read by `src/lib/toolchest/models.ts`.
- The job create route and request fields: prompt, negative prompt,
  duration/frames, fps, resolution, seed, and an optional init image.
- The job shape: `status` (`queued` / `running` / `succeeded` / `failed` /
  `cancelled`), `phase`, `queue_position`, a progress figure, and the output
  URL and MIME type.
- Cancelling is `DELETE` on the job.

If any of these differ in kind (for example, no job API and a streaming
response instead), stop and re-plan this phase. Don't adapt it inline.

## Files touched

- `src/lib/toolchest/video.ts` (new) — the client: `submitVideoJob`,
  `followVideoJob` (on `followJob`), `readVideoJob`, and `videoProgressOf`.
- `src/lib/toolchest/video.test.ts` (new) — tests against fixtures in
  `src/lib/toolchest/fixtures/`.
- `src/lib/toolchest/models.ts` — read the video capability and models.
- `src-tauri/src/video_cache/mod.rs`, `commands.rs`, `protocol.rs` (new) — a
  video cache modelled on `src-tauri/src/audio_cache/`:
  - `video_store_url(url, api_key, title, conversation_id, code_session_id)`
    downloads into `<app_data>/video_cache/` and returns `{ id, path, mime,
    bytes }`
  - a `haruspex-video:` URI scheme with range support (reuse
    `audio_cache/range.rs`)
  - `video_save(id, dest)` copies into the working folder.
- `src-tauri/src/db/mod.rs`, `src-tauri/src/db/videos.rs` (new) — `videos`,
  `conversation_videos` and `code_session_videos` tables, deleted with the
  owner, as audio does.
- `src-tauri/src/lib.rs` — register the scheme and the commands.
- `src/lib/ipc/gen/*` — regenerated.
- `src/lib/tasks/followers.ts` — the `video` follower.
- `src/lib/agent/tools/video-gen.ts` (new) — the `generate_video` tool,
  registered in `src/lib/agent/tools/index.ts`. It's offered when Settings →
  Video generation selects a toolchest server with a video instance (see
  step 5).
- `src/lib/tasks/noticeText.ts` — video generation notices.
- `src/lib/components/tasks/VideoGenResult.svelte` (new) — a `<video>`
  player for the `haruspex-video:` URL, with Save.
- `src/lib/components/tasks/TaskCard.svelte` — use it.
- `src/lib/stores/settings.ts` — `videoGen: { server: string | null;
  instance: string | null }`, off (`server: null`) by default.
- `src/lib/components/settings/VideoGenSection.svelte` (new) and its test —
  the Settings → Video generation section, mounted beside `MusicSection`.
- `docs/guide/video-generation.md` (new page) — generate a video.

## Steps

1. Client (`src/lib/toolchest/video.ts`): `submitVideoJob(cfg, req)` POSTs
   the job and returns `{ jobId }`. `followVideoJob(cfg, handle, opts)` calls
   `followJob` with `readVideoJob` and reports `videoProgressOf(job)`
   (percent, phase, queue position).
2. Request type `VideoRequest`: `{ prompt, negativePrompt?, seconds, fps?,
   width?, height?, seed?, initImageHash? }`. An init image is uploaded with
   `toolchestUpload` when the job is submitted.
3. Video cache (Rust): a copy of the audio cache's download/store/protocol
   path, kept as its own module since video files are large. It streams the
   download to disk (no buffering in memory) and serves ranges. It has the
   same owner linking and deletion as audio.
4. The follower, in phase 06's order: `task_update({ state: 'running' })` →
   `submit` → `task_update({ handle })` → `follow` →
   `video_store_url` with the owner's ids → the save target if set → Done
   `result: { videoId, url, seconds, width, height, model, seed, savedLine }`,
   where `model` and `seed` come from the finished job (seed falls back to the
   request's). Reattach
   and cancel work as in phase 06.
5. Settings → Video generation (`VideoGenSection.svelte`) is built like
   `MusicSection.svelte`'s toolchest part:
   - a server picker: Off (the default), or one of the toolchest servers
     already configured
   - an instance picker listing that server's instances that advertise
     video, from `src/lib/toolchest/models.ts`. With exactly one, it's
     chosen automatically.

   The spec stores `server: { url, instance }` as phase 06 does, and the
   runner never checks the live Settings → Video generation.
6. Tool `generate_video`:
   - Arguments: prompt, seconds, optional size, seed, init image (a
     conversation image reference), and `save_as`.
   - It always creates a background task (there is no `background`
     parameter) and returns the phase 06 start text.
   - It's registered only for Chat and Code turns, by the same check that
     phase 06 uses for the `background` parameter. The Shell and scheduled
     jobs don't get it.
   - Its description says videos take minutes and arrive as a notification.
7. `noticeFor(video gen)`: “Video ready (<w>×<h>, <seconds> s, <model>,
   seed <n>).”, then a line placing the `haruspex-video:` link in the reply,
   then the saved line. No images.
8. `VideoGenResult` plays the video, with Save (`video_save` through the save
   dialog) and Show in folder when saved.
9. Run `./scripts/export-ipc-types.sh`.
10. Guide: a new `docs/guide/video-generation.md` page (title and description
    frontmatter, under 6 KB) covering setup in Settings → Video generation,
    asking for a video, where it's kept, and what it doesn't do (no editing
    of generated videos; see the `video-editing` page for Kdenlive).

## Build gate

- `cd src-tauri && cargo test && cargo clippy && cargo fmt -- --check`
- `./scripts/export-ipc-types.sh`, leaving no diff
- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`

## Test plan

- Unit (fixtures): the client parses queued, running and succeeded jobs;
  progress mapping works; cancel sends `DELETE`.
- Rust:
  - `video_store_url` streams to disk.
  - Range requests return partial content.
  - Deleting a conversation deletes its videos.
- Unit: the follower runs to Done with a fake client and a fake store;
  reattach and cancel work as in phase 06.
- Manual, against llama-toolchest with video:
  - Ask Chat for a 5-second clip. The card shows the queue and progress, and
    other conversations stay usable.
  - The notice turn places the video, and it plays.
  - Quit mid-job, relaunch, and it reattaches.
  - Ask a Code session for one with `save_as` and the file lands in the
    folder.

## Commit

`feat(video): generate videos on llama-toolchest`

## Rollback

Revert the commit. The video cache tables and the `<app_data>/video_cache/`
folder stay, unused, which is harmless. The folder can be deleted by hand.
Leftover tasks can be cleared with `DELETE FROM background_tasks WHERE
kind = 'video'`.
