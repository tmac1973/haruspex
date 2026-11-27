# Phase 07 — Background music generation

**Depends on:** 04, 05, 06 · **Enables:** nothing later depends on it

## Goal

`generate_music` and `edit_music` take `background: true` and run through the
phase 06 runner on both music backends: toolchest's ACE-Step instances and
the ACE server. Both are job-based, so both reattach after a restart.

## Files touched

- `src/lib/music/backend.ts` — the `MusicBackend` interface gains
  `submit` / `follow`, as image did.
- `src/lib/music/toolchest/backend.ts` — split `run` (l.121-160) into
  `submit` (create the job and return `{ jobId }`) and `follow`
  (`followJob`, then `keep()`).
- `src/lib/music/ace/backend.ts` — split `runJob` (l.86-118) into `submit`
  (return `{ taskId }`) and `follow`. Replace its own poll loop with
  `followJob` from `#lib/toolchest/jobs.ts`, which takes the path, read and
  cancel arguments it needs. Add an optional `cancel` hook to
  `FollowOptions` so ACE's `POST ROUTES.cancel` replaces the default
  `DELETE`.
- `src/lib/toolchest/jobs.ts` — the `cancel` hook in `FollowOptions`.
- `src/lib/tasks/followers.ts` — the `music` follower.
- `src/lib/agent/tools/music-gen.ts`, `music-edit.ts` — the `background`
  parameter; `runMusic` split into running and `musicResultText`.
- `src/lib/tasks/noticeText.ts` — music notices.
- `src/lib/components/tasks/MusicTaskResult.svelte` (new) — an audio player
  for the stored song.
- `src/lib/components/tasks/TaskCard.svelte` — use `MusicTaskResult`.
- `docs/guide/music.md` — generate music in the background.

## Steps

1. Interface, mirroring phase 06:

   ```ts
   submit(req: MusicRequest, opts): Promise<unknown>;
   follow(handle: unknown, opts): Promise<StoredSong>;
   ```

   `generate` = `follow(await submit(…))` on both backends.
2. Spec: `{ op: 'generate' | 'edit', backend, server: { url, instance? },
   request: MusicRequest, sourceAudioId?, title, save, conversationId?,
   codeSessionId? }`. `server` is used as in phase 06, and the runner never checks the live
   Settings → Music. An edit's
   source song is its audio-cache id, resolved when the tool runs.
3. Tools: same `background` parameter (offered only to Chat and Code
   turns, as in phase 06), start text and description line as phase 06.
4. Follower, in phase 06's order: `task_update({ state: 'running' })` →
   `submit` → `task_update({ handle })` → `follow`, which
   reports progress through `musicProgressOf` (toolchest) and ACE's own
   phase. `keep()` / `audio_store_url` stores the song with the owner's ids.
   Done `result: { audioId, url, title, durationSecs, savedLine }`.
5. Reattach: as in phase 06. A server that no longer knows the job fails the
   task with “The server no longer has this job.”
6. Music has no app-side lock: both backends queue on the server.
7. `noticeFor(music)` returns `musicResultText` (the text the blocking tool
   returns today). No images.
8. `MusicTaskResult` plays the `haruspex-audio:` URL with the player the
   `audio` artifact already uses.
9. Guide: a “Generate in the background” section in `docs/guide/music.md`.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`

## Test plan

- Unit:
  - `followJob` with the `cancel` hook calls it instead of `DELETE`.
  - The ACE backend's existing tests pass on `followJob`.
- Unit:
  - The music follower runs a fake backend to Done and stores with the
    owner's ids.
  - Reattach follows a handle.
  - Cancel ends Cancelled.
- Unit:
  - The tool with `background: true` returns the start text.
  - Blocking is unchanged.
  - The notice text equals the blocking result text.
- Manual, on toolchest:
  - Ask for a three-minute song in the background. The card shows the
    queue position and progress.
  - Quit, relaunch, and it reattaches.
  - The song plays in the card and in the notice turn's reply.

## Commit

`feat(music): generate and edit songs in the background`

## Rollback

Revert the commit. Leftover tasks can be deleted with `DELETE FROM
background_tasks WHERE kind = 'music'`. The ACE backend returns to its own poll loop.
