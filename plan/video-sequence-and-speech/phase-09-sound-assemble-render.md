# Phase 09 — Sound, assembly, render and report

**Depends on:** 02 (fit, frame trims, 720p24), 03 (speed, holds, gain ranges
on `CutItemSpec`), 04 (spec types), 05 (pipeline), 07 (clips), 08 (check
results) · **Enables:** the finished job; 11
(narration in saved voices reuses this stage)

## Goal

Finish the run: make the music beds and narration the spec names, assemble
every clip and existing section into one Shotcut or Kdenlive project with the
chosen joins, keep the clips' own sound when asked, render it with the
existing render path, check it, and write `REPORT-sequence.md`. Add the
`video-sequence` guide page.

## Files touched

- `src/lib/agent/jobs/types/video-sequence/sound.ts` — music beds and
  narration.
- `src/lib/agent/jobs/types/video-sequence/assemble.ts` — builds a `CutSpec`
  and calls `video_project_cut`.
- `src/lib/agent/jobs/types/video-sequence/render.ts` — `video_render_start`,
  waits for the render task, reads its check.
- `src/lib/agent/jobs/types/video-sequence/report.ts` — `renderSequenceReport`.
- `src/lib/agent/jobs/types/video-sequence/pipeline.ts` — replace the last
  placeholders.
- `src/lib/music/extend.ts` — the extend request builder, moved out of
  `src/lib/agent/tools/music-edit.ts` (which imports it); songs run through
  `runMusicJob` in `src/lib/agent/tools/_musicJob.ts`.
- Tests: `sound.test.ts`, `assemble.test.ts`, `report.test.ts`.
- `docs/guide/video-sequence.md` — new page: turn it on, write a brief, run
  modes, keyframes, joins, sound, resume, the time it takes, where files go,
  what it doesn't do, what has been tested. Add to `PAGES` in
  `src/lib/guide/pages.test.ts`.
- `docs/guide/job-types.md` — point at the `video-sequence` page.

## Steps

1. Sound stage:
   - Music: for each `MusicBed`, its length is the sum of its sections'
     lengths (joins included). Up to 240 s: one song (instrumental, the bed's
     caption). 240–600 s: a 240 s song extended to length with ACE-Step's
     `repaint` task (`repaintStart` = current length, `repaintEnd` = target),
     the request `music-edit.ts`'s `extend` builds, moved into
     `src/lib/music/extend.ts` so the tool and the job share it, and run
     through `runMusicJob` (`_musicJob.ts`). Longer: songs of up to 600 s
     with the same caption, joined with 2 s crossfades. Save each to
     `<episode>/music/<bed id>-N.mp3`. Skip a bed already done in the progress
     file.
   - Narration: each line through the current speech path
     (`tts_synthesize_to_cache`, voice from the line or the default) into
     `<episode>/narration/<section>-N.wav`.
2. Assemble:
   - Project format: the preset that matches the instance's size and fps
     (`720p24` for LTX-2.3 at 1280×720), else the spec's `preset`, else
     Settings → Video editing → Format. Editor from the job config.
   - Items in order: each generated clip (`in_frame: 1` when
     `trimFirstFrame`), each existing section (its in/out, its fit, default
     `fill` when its aspect differs), each transition clip.
   - Joins: `cut` → nothing; `crossfade` → `crossfade_secs` on the next item
     (default 1 s); `transition` → the transition clip sits between, with hard
     cuts on both sides.
   - Clip sound: kept when `clip_sound` is true (normalised as today);
     otherwise `gain_ranges: [{ from_secs: 0, to_secs: <clip length>,
     gain_db: -70 }]` on each generated clip's `CutItemSpec` (phase 03).
   - Audio: music beds at their first section's start (`lufs` default −30
     under narration or clip sound, −14 alone); narration at section start +
     `at_secs`.
   - Write the project as `<episode>/<episode name>.mlt` or `.kdenlive` through
     `video_project_cut` (backup and melt check included).
3. Render: start `video_render_start`, wait for its task to finish, and keep
   its check (loudness, length, sound).
4. Report: sections, clips (seed, flagged checks), joins, sound, the project
   and render paths, the check, the time taken, and any notes from validation.
   Write `REPORT-sequence.md` in the episode folder and set it as the run
   result.
5. Guide page and `job-types.md` link.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo test`. The Guide check needs the new page.

## Test plan

- Unit: the fox plan assembles to 25 items with `in_frame: 1` on
  continuations and the transition between sections; `clip_sound: false`
  adds a full-length gain range per clip; a 300 s bed makes one song and one
  extend; a 900 s bed makes two songs crossfaded.
- Hand (the success criteria): the fox brief, Unattended, LTX-2.3, a piano
  bed — one ~2-minute render in `renders/`, the project opens in Shotcut;
  a variant with an existing clip from the folder as the middle section
  renders without size or frame-rate errors.

## Commit

`feat(jobs): Video sequence sound, assembly, render and report`

## Rollback

Revert the commit; runs end after Generate with clips on disk and no project.
