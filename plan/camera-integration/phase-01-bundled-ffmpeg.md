# Phase 01 — Bundled LGPL ffmpeg sidecar

**Depends on:** nothing · **Enables:** every camera phase (capture, probe,
watcher), and video tools that work with no system ffmpeg

## Goal

Ship our own LGPL build of `ffmpeg` and `ffprobe` with the app as
`haruspex-ffmpeg-{triple}` / `haruspex-ffprobe-{triple}`, and make the existing
binary lookup prefer it after a Settings override. Cameras need ffmpeg on a
machine with no terminal; the video tools gain the same benefit. `melt` lookup
is unchanged.

## Files touched

- `.github/workflows/build-sidecars.yml` — new `ffmpeg` job: builds ffmpeg
  (pinned to tag `n8.1.3`) per target triple with the LGPL configure
  below and uploads `haruspex-ffmpeg-<triple>[.exe]` /
  `haruspex-ffprobe-<triple>[.exe]` as a release asset of the sidecars release
  the other built sidecars use.
- `scripts/build-ffmpeg.sh` — new: the configure + make used by CI, runnable
  locally on Linux.
- `scripts/fetch-ffmpeg.sh` — new, modelled on `scripts/fetch-uv.sh`:
  downloads our artifact for the host triple into `src-tauri/binaries/`,
  verifies SHA-256 against a per-triple table at the top of the script, writes a `.version` file.
- `scripts/dev-setup.sh` — call `fetch-ffmpeg.sh` alongside node/uv.
- `src-tauri/tauri.conf.json` — add both to `bundle.externalBin`.
- `scripts/ci-placeholder-sidecars.sh` — create stub files for the two new
  `externalBin` entries (used by CI and `platforms.yml`).
- `src-tauri/src/video/binaries.rs` — add a `Bundled` source between the
  override and PATH in `candidates()` (`:231`) for ffmpeg and ffprobe; melt
  unchanged.
- `src-tauri/src/runtimes.rs` — extend the sidecar-naming test's list with the
  two names.
- `src/lib/components/settings/VideoEditingSection.svelte` — status line shows
  "bundled" as the source when that's what resolved.
- `src-tauri/src/video/binaries.rs` `VideoBinariesStatus` / ts-rs export —
  include the source kind; run `./scripts/export-ipc-types.sh`.
- `docs/guide/video-editing.md` — ffmpeg now ships with Haruspex; melt still
  comes from Kdenlive or Settings → Video editing.
- `CLAUDE.md` — add the two binaries to the sidecar table.

## Steps

1. Write `scripts/build-ffmpeg.sh` with `--disable-gpl --disable-nonfree
   --enable-version3 --disable-doc --disable-ffplay --enable-static
   --disable-shared`, with `libmp3lame` (LGPL) enabled, all native decoders,
   demuxers and parsers on, network protocols `rtsp,rtp,tcp,udp,http,https`
   (TLS via the platform: `--enable-securetransport` on macOS, `schannel` on
   Windows, `--enable-openssl` is not used; Linux uses `--enable-gnutls`
   statically linked), encoders `png,mjpeg,pcm_s16le,flac,aac,libmp3lame`,
   muxers `image2,image2pipe,wav,flac,mp3,adts,null`, filters on (scene
   `select`, `astats`, `ebur128`, `scale`), and devices `v4l2,alsa,pulse`
   (Linux), `avfoundation` (macOS), `dshow` (Windows).
2. Runners: `ubuntu-24.04` (x86_64 Linux), `ubuntu-24.04-arm` (aarch64
   Linux), `macos-latest` for both macOS triples (x86_64 cross-compiled with
   `--enable-cross-compile --arch=x86_64 --extra-cflags=-arch x86_64`),
   `windows-latest` for Windows. Build in CI for `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
   `x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-pc-windows-msvc`
   (Windows built natively on a `windows-latest` runner inside MSYS2's
   MINGW64 environment, output named with the msvc triple as the other
   sidecars are). Record SHA-256 of each artifact.
3. `fetch-ffmpeg.sh` maps the host triple to the asset, downloads, checks the
   hash, `chmod +x`, and writes `haruspex-ffmpeg-<triple>.version` with the
   ffmpeg tag.
4. In `binaries.rs`, resolve the bundled path the way other sidecars are
   resolved at runtime (next to the app executable via the Tauri sidecar
   path helper already used for `haruspex-node`), and insert it after the
   override. A bundled candidate still must answer `-version` within 5 s.
5. Add the source (`override | bundled | path | kdenlive`) to the resolved
   binary struct and to `VideoBinariesStatus`; regenerate IPC types.
6. Update the settings status line, guide page and CLAUDE.md table.

## Build gate

- `npm run check`, `npm run lint`, `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff
- `node scripts/guide-check.mjs < /dev/null`
- The `build-sidecars` workflow produces all five artifacts.

## Test plan

- Unit: `binaries.rs` candidate order puts override → bundled → PATH →
  Kdenlive; a bundled binary that fails `-version` is skipped.
- Unit: runtimes naming test covers the new names.
- Manual (Linux): with `/usr/bin/ffmpeg` moved aside, Settings → Video editing
  reports ffmpeg/ffprobe as bundled; `video_frames` and `video_transcribe`
  work on a sample MP4.
- Manual: `haruspex-ffmpeg -hide_banner -buildconf` shows no `--enable-gpl`.
- Manual: `haruspex-ffmpeg -rtsp_transport tcp -i rtsp://…/ch0 -frames:v 1
  out.jpg` works against the Thingino D1.

## Commit

`feat(video): bundle an LGPL ffmpeg and ffprobe and prefer them after the override`

## Rollback

Revert the commit: the lookup falls back to PATH/Kdenlive as before. The
release assets can stay published; nothing else references them.
