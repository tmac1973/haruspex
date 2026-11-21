# Phase 02 — Ship the media build and run it

**Depends on:** 01 · **Enables:** 03 (choosing the bundled melt), 04 (PATH
wrappers)

## Goal

Dev setup, CI and the installers carry the phase 01 archive. Every place that
runs the bundled ffmpeg or ffprobe (video tools, cameras, the audio cache)
gives it the environment its shared libraries need. The bundled
`haruspex-melt` ships and runs, though nothing picks it yet. Video tools and
cameras keep working because ffmpeg is now dynamic.

## Files touched

- `scripts/fetch-ffmpeg.sh` → renamed `scripts/fetch-media.sh`. Sources
  `media-versions.sh`, downloads `media-<triple>` from the `media-<tag>`
  release, checks SHA256SUMS, and unpacks it into `src-tauri/binaries/`
  (three binaries, plus `binaries/media/`). The `.version` stamp names
  `MEDIA_TAG`. Failure behaviour is unchanged: a sum mismatch is fatal, a
  missing tool or download warns and skips.
- `scripts/dev-setup.sh` → calls `fetch-media.sh`, and the placeholder loop
  includes `haruspex-melt`.
- `scripts/ci-placeholder-sidecars.sh` → adds `haruspex-melt` and the
  `media`, `media/lib`, `media/mlt`, `media/mlt-data`, `media/qt-plugins`
  directories.
- `src-tauri/tauri.conf.json` → `externalBin` gains `binaries/haruspex-melt`.
  `resources` gains `binaries/media/` (the whole tree, the way
  `binaries/node-modules/` is listed).
- `src-tauri/src/media_env.rs` (new) → `media_dir(app)` finds
  `binaries/media/` through `sidecar_util::resource_roots`.
  `is_bundled(path, app)` says whether a path is one of our three binaries.
  `apply(cmd, app)` sets the library path (prepended through
  `sidecar_util::library_path_env`), plus `MLT_REPOSITORY`, `MLT_DATA`,
  `MLT_PROFILES_PATH`, `MLT_PRESETS_PATH`, `QT_PLUGIN_PATH`,
  `QT_QPA_PLATFORM=offscreen`, and `QT_QPA_FONTDIR` left as it is.
  `media_command(path, app)` builds a `tokio::process::Command`, calls
  `env_util::sanitize_appimage_env` on it first (as `video::prepare_child`
  does today), and then applies the media env only when `is_bundled`. That
  way the AppImage scrub can't remove the library path we set. Renders keep
  recording melt in the orphan registry exactly as `tasks.rs` does now: only
  how the `Command` is built changes.
  `vars(app) -> Vec<(&'static str, OsString)>` is the single table both
  `apply` and phase 04's wrappers are built from.
- `src-tauri/src/lib.rs` → `mod media_env;`.
- `src-tauri/src/video/mod.rs` → `prepare_child` is removed. Its one job,
  the AppImage scrub, moves into `media_env::media_command`, which every
  spawn now uses.
- `src-tauri/src/camera/*.rs`, `src-tauri/src/audio_cache/commands.rs`,
  `src-tauri/src/video/*.rs` → the ~20 `Command::new(ffmpeg|ffprobe|melt)`
  sites build through `media_env::media_command`.
- `src-tauri/src/runtimes.rs` → the sidecar-prefix test's `wanted` list gains
  `binaries/haruspex-melt`.
- `scripts/link-sidecar-libs.sh` → no change. `media/lib` stays out of
  `target/debug/`, the same as `sd-libs`, because `media_env` points at it
  directly.
- `CLAUDE.md` → sidecar table row for `haruspex-melt`, and the `ffmpeg`
  paragraph now covers melt and the `media/` folder.
- `.github/workflows/release.yml` → its ffmpeg fetch step calls
  `fetch-media.sh`.

## Steps

1. Write `fetch-media.sh` from `fetch-ffmpeg.sh`. Unpack into a temp dir
   first, then move it into place, so a half-finished extract never leaves
   `binaries/media/` mixed between versions. Delete `fetch-ffmpeg.sh`.
2. Add `media_env.rs` with unit tests: `apply` sets each variable to a path
   under the given media dir, and the library path puts `media/lib` first.
   `is_bundled` is true for a resolved `haruspex-ffmpeg` and false for
   `/usr/bin/ffmpeg`.
3. Route every spawn through `media_command`. Find them with
   `grep -rn 'Command::new' src-tauri/src/{camera,audio_cache,video}`, and
   add an `env_util`-style comment saying system ffmpeg never gets our
   library path.
4. Update `tauri.conf.json`, the CI placeholders, and dev setup.
5. Check the deb/rpm, AppImage, macOS `.app` and Windows NSIS layouts with a
   `workflow_dispatch` run of `release.yml` on the branch, listing
   `binaries/media/` inside each package.

## Build gate

- `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test` (from
  `src-tauri/`).
- `npm run check`, `npm run lint`, `npm run test`.
- `./scripts/export-ipc-types.sh` leaves no diff (no IPC change is expected).

## Test plan

- `cargo test` video and camera suites pass against the bundled dynamic
  ffmpeg (`video::tasks` has a real render test).
- Fresh `./scripts/dev-setup.sh --skip-build` in a new worktree fetches the
  media archive, and `npm run tauri dev` starts with Settings → Video editing
  showing bundled ffmpeg and ffprobe.
- A camera snapshot and a USB camera clip work in the dev app.
- Build the rpm, install it on Fedora next to the `mlt` and `ffmpeg` packages:
  no file conflict, and the installed app's camera snapshot works.
- `haruspex-melt -version`, run through `media_command` in a test, prints MLT
  7.40.0.

## Commit

`feat(video): ship melt and shared ffmpeg in the media bundle`

## Rollback

Reverting restores `fetch-ffmpeg.sh` and the static `ffmpeg-<tag>` release,
which stays published. The phase isn't safe to leave half applied: if the
spawn sites aren't all routed through `media_command`, the dynamic ffmpeg
fails to start. Either the whole commit is in, or none of it.
