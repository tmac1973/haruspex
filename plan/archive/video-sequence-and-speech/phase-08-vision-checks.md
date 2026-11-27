# Phase 08 — Vision checks on seams and drift

**Depends on:** 04 (progress `check` field), 05 (job config, tools, prompts,
pipeline), 07 (generated clips) · **Enables:** 09
(the report lists flagged clips)

## Goal

When the job's model can see images and **Vision checks** is on, look at each
generated clip against what it should continue from and what its section
should look like, and make a failing clip once more on a new seed. A clip that
fails twice is kept and flagged, so a long run never stalls on a judgement.

## Files touched

- `src/lib/agent/jobs/types/video-sequence/check.ts` — the stage.
- `src/lib/agent/jobs/types/video-sequence/tools.ts` — `SUBMIT_CLIP_CHECK_TOOL
  = 'submit_clip_check'` with `{ ok: boolean, problem?: string }`.
- `src/lib/agent/jobs/types/video-sequence/prompts.ts` — the check prompt.
- `src/lib/agent/jobs/types/video-sequence/generate.ts` — call the check after
  each clip (so a retry happens before the next clip chains from it).
- `src/lib/agent/jobs/types/video-sequence/pipeline.ts` — the Check stage
  summarises results instead of running them.
- `src-tauri/src/video/commands.rs`, `src-tauri/src/video/frames.rs` —
  `FrameRequest` gains `images: Vec<{ path, label }>`: PNG files placed as
  tiles before the clip frames in `contact_sheet`; export-ipc-types.
- `check.test.ts`; a `frames.rs` test for a sheet with image tiles.

## Steps

1. Skip the whole stage when `vision_checks` is off or `ctx.visionSupported`
   is false; note it once in the report.
2. After a clip is saved (phase 07 step 6), build one contact sheet with the
   `video_frames` command (with the new `images` field): the start image it was given, the clip's
   frames at 0 %, 50 % and 100 %, and the section keyframe (when there is
   one), labelled.
3. Run one job turn with the sheet, the clip's prompt and style, and
   `forceFinalTool: SUBMIT_CLIP_CHECK_TOOL`. The prompt asks two questions:
   does the first frame continue the start image (same subject, place and
   light, no jump), and does the clip still match the keyframe's subject and
   look. Nothing else.
4. `ok: false`: regenerate the clip once with a new seed (same start and end),
   check again. A second failure keeps the newer clip and records
   `check: {ok: false, problem}`.
5. The Check stage (after Generate) lists flagged clips; Attended asks
   **Keep going**, **Redo flagged** (one more try each), **Stop**.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo test` · export-ipc-types leaves no diff.

## Test plan

- Unit (fake model and videogen): `ok: true` → no retry; `ok: false` → one
  retry and a recheck; two failures → flagged and the run continues; vision
  off → no turns at all.
- Hand: on a vision model, force a bad seam by editing one clip's prompt to
  another subject; the check flags it and the retry is made.

## Commit

`feat(jobs): Video sequence vision checks on seams and drift`

## Rollback

Revert the commit; generation runs without checks as in phase 07.
