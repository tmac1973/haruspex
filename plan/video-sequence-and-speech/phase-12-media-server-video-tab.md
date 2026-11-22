# Phase 12 — Loopback media streaming and a video tab

**Depends on:** nothing · **Enables:** 13 (the transcript viewer plays beside
the video), closes #755

## Goal

Play large video files in the app. A small Rust HTTP server on 127.0.0.1
serves files with Range support, behind a per-launch token, only from folders
an editor window has open and from the audio cache. Editor windows get a video
tab, and a finished render's task card plays the render in place.

## Files touched

- `src-tauri/src/media_http.rs` — the server: binds `127.0.0.1:0` at startup
  with `axum` (already a dependency, used by the Remote control server); route
  `GET /m/<token>/<root id>/<rel path>` with `Range`, `HEAD`, the right
  `Content-Type`, and no CORS headers. A root is registered by id; nothing
  else is served. The proxy config never applies (loopback).
- `src-tauri/src/lib.rs` — start it; commands `media_url { root, rel_path }`
  and `media_root_register { path } → id`, `media_root_release { id }`.
- `src/lib/editor/document.svelte.ts` — `FileViewer` adds `'video'`
  (`mp4|mov|mkv|webm|m4v`); `src-tauri/src/fs_tools/editor.rs`
  `VIEWABLE_EXTS` and `src/lib/editor/fileTree.ts` `kindOf` in step.
- `src/lib/components/VideoViewer.svelte` — `<video>` with the media URL,
  the player's own full-screen button (#754 pattern), and a bar with length,
  size and codecs (from `video_probe`).
- `src/routes/editor/+page.svelte` — the `'video'` branch; register the
  window's folder as a media root on open, release on close.
- `src/lib/components/tasks/TaskCard.svelte` — on a finished render task, a `VideoPlayer` on the finished render via a media
  root for its `renders/` folder; **Open** and **Show in folder** stay.
- Tests: `media_http.rs` (range, token, root confinement),
  `document.svelte.test.ts` for `viewerFor`.
- `docs/guide/viewers.md` — "Watch a video"; drop "Play video" from what
  they don't do. `docs/guide/video-render.md` — the card plays the render.

## Steps

1. Use `axum` 0.8 (already in `src-tauri/Cargo.toml`); no new dependency.
2. Token: 32 random bytes hex, made at startup, kept in memory only.
3. Path check: the relative path is joined to the root and canonicalised;
   anything outside the root is 404.
4. `Range: bytes=a-b` → 206 with `Content-Range`; no range → 200 streamed.
5. Video tab and render card as listed.
6. Check playback of an H.264 MP4 and a VP9 WebM on WebKitGTK, WebView2 and
   WKWebView (mactest/wintest). On Linux without `gst-libav`, the viewer
   says MP4 needs it (as the audio viewer does for `.m4a`).

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo fmt -- --check` · `cargo clippy` · `cargo test` · export-ipc-types
leaves no diff.

## Test plan

- Rust: wrong token → 404; `../` escape → 404; a range request returns the
  exact bytes; an unregistered root → 404.
- Hand: open a 2 GB OBS recording in a video tab and seek to the end at once;
  a finished render plays on its card; full screen works; checked on Linux,
  Windows and macOS.

## Commit

`feat(editor): stream media over loopback, a video tab, renders play in place`

## Rollback

Revert the commit; the server is not started and videos open as before
(not at all in viewers, **Open** on render cards).
