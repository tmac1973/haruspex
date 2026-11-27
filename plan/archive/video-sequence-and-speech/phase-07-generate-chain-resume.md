# Phase 07 — Generate: chaining clips, transitions and resume

**Depends on:** 01 (stills, `end_image`), 04 (clip plan, progress file), 05
(pipeline), 06 (keyframes) · **Enables:** 08 (checks), 09 (assembly)

## Goal

Run the clip plan on the chosen toolchest video instance: one clip at a time,
each continuation starting from the true last frame of the clip before, with
`end_image` for re-anchors and transitions; save every clip into the episode
folder; record progress so a re-run continues from the next missing clip,
including following a toolchest job that was mid-flight when Haruspex closed.

## Files touched

- `src/lib/agent/jobs/types/video-sequence/generate.ts` — the stage.
- `src/lib/agent/jobs/types/video-sequence/resume.ts` — `Resume` support:
  the run report row's **Resume** action starts a new run of the same job.
- `src/lib/agent/jobs/types/video-sequence/pipeline.ts` — replace the
  Generate placeholder.
- `src/lib/components/jobs/JobRunDetail.svelte` — show **Resume** on an
  interrupted, failed or cancelled Video sequence run (it calls the type's
  `canResume` and `enqueue` with trigger `'manual'`).
- `src/lib/agent/jobs/types/types.ts` — optional `canResume?(run, job)` on
  `JobTypeDefinition`.
- `src/lib/videogen/toolchest.ts` — export the pieces the stage needs without
  the chat task wrapper: `generateVideo` and `resumeVideo` already exist;
  add an optional `onHandle(handle)` callback so the stage can store the
  toolchest job handle before polling.
- Tests: `generate.test.ts`, `resume.test.ts`.

## Steps

1. For each `ClipPlanItem` in order, skip it when the progress file lists it
   `done` and its file exists.
2. A `running` item with a stored `handle`: call `resumeVideo(handle)`; if the
   server no longer has the job, reset it to `pending`.
3. Resolve the start image:
   - `keyframe(section)` / `userImage(path)` → that PNG;
   - `lastFrameOf(prevId)` → `video_still_extract` `last` of the previous
     clip's file into `.haruspex/stills/<prevId>-last.png`;
   - `text` → none.
   Resolve `end` the same way (`reanchor` → `keyframes/<section>-r<n>.png`,
   `firstFrameOf(B)` → B's keyframe, user image or `<section>-first.png`).
4. Put the images in the image cache (`image_store_bytes`) and build a
   `VideoRequest` with `style + prompt`, the instance's size and fps, the
   item's frames, a seed (spec seed + item index, or random and recorded),
   `startImage`, `endImage`.
5. Call `generateVideo`; in `onHandle`, write `{status: 'running', handle}` to
   the progress file before waiting. Show progress on the Generate step as
   "clip 7 of 25 — section snow — 62%". After the first clip, call
   `estimateRun(plan, <its wall time>)` and show the time left.
6. On success, save the clip to `<episode>/generated/<id>.webm` (copy from the
   audio cache with the existing `saveCachedAudio` path) and mark it `done`
   with its seed and `hasAudio`.
7. On failure, retry once with a new seed; then mark `failed`, stop the
   stage, and end the run `failed` with the clip named. A re-run resumes from
   it.
8. Attended: after the first clip of each section, show it (the in-app video
   player for audio-cache clips) and ask **Continue**, **Redo it** (new seed,
   optional prompt note written back into the spec), **Stop**.
9. Cancel: stops between clips and cancels the running toolchest job
   (`DELETE`), leaving `done` clips in place.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo test` (if any Rust command signature is touched,
`./scripts/export-ipc-types.sh` too).

## Test plan

- Unit (fake videogen): continuations get the previous clip's last-frame
  still; a re-anchor item sends `end_image`; a transition item sends both; a
  progress file with 5 done clips makes the run start at clip 6; a `running`
  item with a handle is resumed, not restarted; a failure retries once with a
  new seed, then fails the run naming the clip.
- Hand: the fox spec on LTX-2.3 for the first section only (edit the spec to
  10 s per section); quit Haruspex during clip 2; reopen, press **Resume** —
  clip 1 is kept and clip 2 finishes.

## Commit

`feat(jobs): Video sequence generation with clip chaining and resume`

## Rollback

Revert the commit; the stage goes back to its placeholder and **Resume** is
gone. Clips already saved stay in `generated/`.
