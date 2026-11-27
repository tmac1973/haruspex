# Phase 02 — Per-clip fit, frame-accurate trims and the 720p/24 format

**Depends on:** nothing · **Enables:** 03 (the Placement-field pattern), 09
(assembling mixed generated and existing clips, dropping seam frames), 14

## Goal

Let a project mix clips of different shapes cleanly and cut on exact frames.
Each main-track clip gets a fit mode (letterbox, fill, or a custom crop region)
stored on its `Placement` and written as the editors' own MLT filters; trims
and cuts accept frame numbers as well as seconds; and a 720p / 24 fps project
format joins the presets so generated clips need no scaling.

## Files touched

- `src-tauri/src/video/timeline.rs` — `Placement.fit: Fit` with
  `enum Fit { Letterbox (default), Fill, Crop { x, y, w, h } }` (fractions 0–1 of
  the source frame), serde default so old data parses.
- `src-tauri/src/video/shotcut/edit.rs` — write/read a `crop` filter for `Fill`
  (`center=1`, `use_profile=1`) and for `Crop` (`left/right/top/bottom` in
  source pixels), marked `haruspex:ours` like the gain filter.
- `src-tauri/src/video/kdenlive/edit.rs` — the same filters with their
  `kdenlive_id`, read back in `current`.
- `src-tauri/src/video/project.rs` — `ProjectOp::Fit { index, fit }`;
  `ProjectOp::Trim` and `CutItemSpec` take optional `in_frame` / `out_frame`
  that override the seconds; `CutItemSpec.fit`.
- `src-tauri/src/mlt/profile.rs` — preset `720p24` (1280×720, 24/1).
- `src/lib/video/types.ts` — add `720p24` to `VIDEO_PRESETS`.
- `src/lib/video/args.ts` — parse `fit` (`"letterbox"|"fill"|{x,y,w,h}`),
  `in_frame`, `out_frame` for `video_cut` items and `video_edit`.
- `src/lib/agent/tools/video.ts` — schema: `video_edit` op `fit`; `video_cut`
  item `fit`, `in_frame`, `out_frame`; `video_project_read` summary shows a
  clip's fit when not letterbox.
- `src/lib/components/settings/VideoEditingSection.svelte` — the new Format option.
- Rust tests beside each file; `src/lib/video/args.test.ts`.
- `docs/guide/video-cut.md` — "Fill, letterbox or crop a clip"; frame trims
  one line. `docs/guide/video-editing.md` — the 720p/24 format.

## Steps

1. Add `Fit` to `timeline.rs` with serde `#[serde(default)]` on `Placement.fit`.
2. Shotcut writer: in the per-clip chain where `gain_filter_for` inserts
   filters (`shotcut/edit.rs` ~433–504), add `fit_filter_for(fit, source size)`
   before the gain filter. `Letterbox` writes nothing (MLT's default scales
   to fit with bars). Reader: a `haruspex:ours` crop filter maps back to `Fit`.
3. Kdenlive writer and reader: same placement in `kdenlive/edit.rs` next to
   `gain_filter`, with `kdenlive_id` `crop` so Kdenlive shows it in the
   effect stack.
4. `project.rs`: `ProjectOp::Fit` sets the clip's `fit` and goes through
   `edit_text()` like other ops (backup, melt check, reopen). A clip split by
   `RemoveRanges` keeps its fit on both pieces (it is a `Placement` field,
   copied with the rest).
5. Frame trims: in `ProjectOp::Trim` and `cut()`, when `in_frame`/`out_frame`
   are given, use them directly as `Placement.in_frame`/`out_frame`
   (`out_frame` inclusive, as today); otherwise convert seconds with
   `Fps::frames` as today. Refuse a frame past the clip's last frame.
6. Add `720p24` to `mlt/profile.rs` and `VIDEO_PRESETS`.
7. Update the tool schemas and `args.ts`; run `./scripts/export-ipc-types.sh`.
8. Update the guide pages.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo fmt -- --check` · `cargo clippy` · `cargo test` · export-ipc-types
leaves no diff.

## Test plan

- Rust round trips for both editors: write a project with one clip of each
  fit, reopen, `current()` returns the same fits; the file passes `melt_loads`.
- A 9:16 fixture in a 16:9 project: render a one-second piece with `Fill` and
  check with `ffprobe` that the output is 16:9 with no bars (frame edge pixels
  not black).
- `Trim` with `in_frame: 1` drops exactly one frame (summary length shrinks by
  1/fps).
- Hand: open a project with all three fits in Shotcut and Kdenlive; the crop
  filter shows on the clip in each.

## Commit

`feat(video): per-clip fit and crop, frame-accurate trims, 720p24 format`

## Rollback

Revert the commit. Projects written with a fit keep a crop filter marked
`haruspex:ours`; the previous code ignores filters it does not know, so they
still open and render (with the crop applied by MLT).
