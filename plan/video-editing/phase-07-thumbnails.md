# Phase 07 — Thumbnails

**Depends on:** 01 (folder rules), 02 (`default_project`, backups), 03
(renders, as a frame source), 05 (timeline mapping), 06 (`extract_frame`) · **Enables:** 08 (the thumbnail sent with the upload)

## Goal

The model can make a YouTube thumbnail for an episode: a 1280×720 JPEG under
2 MB, either from a frame of the footage, the cut or a render, or generated
with the image backend chosen in Settings → Image. It's saved in the episode
folder and shown in the chat. Haruspex draws no text on it: an image model can
put text in a generated thumbnail, and frame thumbnails stay as they are.

## Files touched

- `src-tauri/src/video/thumbnail.rs` — new: fit-and-crop to 1280×720 and JPEG
  encoding under 2 MB, from PNG/JPEG bytes.
- `src-tauri/src/video/mod.rs` — declare `thumbnail`.
- `src-tauri/src/video/commands.rs` — `video_thumbnail_from_frame`,
  `video_thumbnail_from_image`.
- `src-tauri/src/lib.rs` — register both.
- `src/lib/ipc/gen/*` — regenerated.
- `src/lib/agent/tools/video.ts` — the `video_thumbnail` tool.
- `src/lib/agent/tools/video.test.ts` — extend.
- `docs/guide/video.md` — add "Make a thumbnail".

## Steps

1. **Fit and encode (`thumbnail.rs`).** Scale the source to cover 1280×720
   and centre-crop (Lanczos3), or letterbox when `fit: 'contain'` is asked
   for. Encode as JPEG starting at quality 90 and step down by 5 until the
   file is under 2,000,000 bytes, with a floor of 60. Write to
   `<episode>/<project stem>.thumbnail.jpg`, or `<episode>/<name>.jpg` when a
   name is given, via `resolve_episode`. Keep the previous file as
   `.haruspex/backups/<name>-<timestamp>.jpg`.
2. **From a frame.** `video_thumbnail_from_frame { episode, source, at_secs,
   fit?, name? }`, where `source` is a clip path, a render path, or `project`
   with a timeline time mapped by Phase 05's mapper. It calls Phase 06's
   `extract_frame` at full width, then step 1.
3. **From an image.** `video_thumbnail_from_image { episode, png_base64, fit?,
   name? }` runs step 1 on bytes the frontend produces.
4. **`video_thumbnail` tool.**
   - Schema: `{ episode, project?, from: 'frame' | 'generate', source?, at?,
     prompt?, fit?, name? }`. The default file name uses the project from
     Phase 02's `default_project`. When there is no project, it uses the
     episode folder's name: `<episode>/<episode name>.thumbnail.jpg`.
   - `frame` needs `source` and `at`. `generate` needs `prompt` and calls
     `generateOneImage({ prompt, width: 1344, height: 768, signal, onProgress
     })` from `src/lib/image/generateOne.ts`, then passes the PNG to
     `video_thumbnail_from_image`. 1344×768 is a 16:9-ish size the supported
     image models produce well.
   - When Settings → Image has no backend, `generate` is refused with "Image
     generation is off. The user can choose a backend in Settings → Image."
     and `frame` still works.
   - The result is the saved path, size and dimensions. The thumbnail is
     attached as an `image` artifact, and pushed to `ctx.pendingImages` when
     the model has vision, so it can check its own work.

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
  - Cover/crop and contain geometry for 4:3, 16:9, 9:16 and 21:9 inputs.
  - A noisy 4K PNG ends under 2 MB at quality ≥60.
  - The backup is written when replacing.
  - Paths outside the episode are refused.
- Vitest:
  - Argument validation per mode.
  - `generate` refused when the image backend is off.
  - Pending image added only with vision.
- Manual, Linux:
  - "Make a thumbnail from 3:12 in ep010": a 1280×720 JPEG in the episode
    folder, shown in the chat.
  - With ComfyUI + Ming selected, "generate a thumbnail with the title
    SPRONGLEHUMP 10": the image is saved at 1280×720.

## Commit

`feat(video): make YouTube thumbnails from frames or the image backend`

## Rollback

Revert the commit. Thumbnails already saved are ordinary JPEGs.
