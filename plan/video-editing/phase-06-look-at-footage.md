# Phase 06 — Scene detection and frame contact sheets

**Depends on:** 01 (ffmpeg, folder rules, the `video` category), 02 (project
reading), 05 (`timeline_map.rs` for timeline times) · **Enables:** 07 (frame
extraction for thumbnails)

## Goal

The model can see what's in the footage. `video_scenes` lists the shot changes
in a clip, and `video_frames` returns one contact sheet of up to 16 frames
(from a clip, or from the cut at timeline times) so a vision model can look at
it. That lets it pick where to trim, describe chapters, and choose a thumbnail
frame. Models without vision don't get `video_frames`.

## Files touched

- `src-tauri/src/video/frames.rs` — new: single-frame extraction (shared with
  Phase 07) and contact sheet composition with the `image` crate (already a
  dependency).
- `src-tauri/src/video/scenes.rs` — new: ffmpeg scene-score detection.
- `src-tauri/src/video/mod.rs` — declare `frames`, `scenes`.
- `src-tauri/src/video/commands.rs` — `video_scenes`, `video_frames`.
- `src-tauri/src/lib.rs` — register both.
- `src/lib/ipc/gen/*` — regenerated (`SceneCut`, `FrameRequest`,
  `ContactSheet`).
- `src/lib/agent/tools/video.ts` — `video_scenes`, and `video_frames` with
  `requiresVision: true`.
- `src/lib/agent/tools/video.test.ts` — extend.
- `docs/guide/video.md` — add "Let it look at the footage".

## Steps

1. **Frame extraction (`frames.rs`).** `extract_frame(path, at_secs,
   max_width)` runs `ffmpeg -nostdin -ss <at> -i <file> -frames:v 1 -vf
   scale='min(<max_width>,iw)':-2 -f image2pipe -c:v png -`. The input-side
   `-ss` gives fast seeking. Rotation metadata is honoured by ffmpeg's
   autorotate. Returns PNG bytes; 10 s timeout per frame.
2. **Contact sheet.**
   - `contact_sheet(frames)` tiles up to 16 frames, each scaled to 480 px
     wide, in a grid of `ceil(sqrt(n))` columns.
   - A 2 px gap separates frames, and each gets a small index number (1…n)
     drawn in its top-left corner with a built-in 5×7 pixel font. The font is
     a hand-written bitmap table, not a font file, which avoids font lookup on
     every OS.
   - Encoded as JPEG quality 80.
   - The result keeps `index → (source path, source secs, timeline secs?)`.
3. **Scene detection (`scenes.rs`).**
   - `ffmpeg -nostdin -i <file> -vf "select='gt(scene,<threshold>)',showinfo"
     -an -f null -`, with stderr parsed for `pts_time`.
   - The threshold defaults to 0.3. Only scene cuts more than 1 s apart are
     kept, and the list is capped at 200 with a note.
   - Cached in `<episode>/.haruspex/scenes.json` by path, size, mtime and
     threshold.
   - Progress comes from `-progress pipe:2`'s `out_time_ms` against the
     duration.
4. **`video_scenes` tool.** `{ episode, path, threshold? }` blocks with
   progress and is cancellable via `ctx.signal`. It returns `mm:ss` times and
   the shot count.
5. **`video_frames` tool.**
   - Takes `{ episode, path?, times?: string[], every_secs?: number, project?,
     timeline_times?: string[] }`. Exactly one mode is allowed:
     - `path` + `times`: given source times.
     - `path` + `every_secs`: evenly spaced, at most 16.
     - `project` + `timeline_times`: mapped through `timeline_map.rs` to
       source frames.
   - Builds the sheet and pushes it to `ctx.pendingImages` as `{ path:
     '<episode>/frames', dataUrl }`. It refuses when `ctx.visionSupported ===
     false` or `MAX_PENDING_IMAGES` is reached.
   - Also attaches it as an `image` artifact so the user sees it.
   - The result text lists `n: time` for each tile.
6. **Registration.** `video_frames` has `requiresVision: true`; `video_scenes`
   is available to every model.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff.
- `npm run test` and `cargo test` also pass on mactest and wintest
  (`ssh haruspex-mac`, `ssh haruspex-win`).

## Test plan

- Rust:
  - Grid layout maths for 1, 5 and 16 frames.
  - Bitmap index digits render, checked against expected pixels.
  - `showinfo` parsing from recorded stderr.
  - The minimum gap and cap.
  - Mode validation errors.
  - Timeline-time mapping uses Phase 05's mapper.
- Integration (ignored, needs ffmpeg): generate a test video with
  `testsrc` + `color` segments joined at known times. Scene detection finds
  each join within 0.1 s, and `extract_frame` at 2.0 s returns the expected
  colour.
- Vitest:
  - `video_frames` is hidden for a non-vision model.
  - Pending-images refusal at the cap.
  - Result text formatting.
- Manual, Linux, with a vision model: "look at ep010 every two minutes and
  tell me where the gameplay starts". The sheet shows in the chat, and the
  model's answer matches the footage.

## Commit

`feat(video): scene detection and frame contact sheets for vision models`

## Rollback

Revert the commit. No project or settings data depends on it; the scenes cache
can be deleted.
