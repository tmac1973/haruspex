# Phase 01 — Build shared ffmpeg, MLT and Qt in CI

**Depends on:** nothing · **Enables:** 02 (fetching and bundling the build)

## Goal

Make the workflow that builds our LGPL ffmpeg also build melt. ffmpeg becomes
shared libav* libraries, MLT 7.40.0 is built with only the modules the two
editors' projects use, and a trimmed Qt 6 runtime goes with it. The output is
one archive per target, published to a `media-<tag>` release with SHA256SUMS.
The app doesn't change in this phase, so it can land and its CI run before
anything uses the result.

## Files touched

- `scripts/build-ffmpeg.sh` → renamed `scripts/build-media.sh`. Builds ffmpeg
  with `--enable-shared --disable-static` (all of today's LGPL flags kept),
  then MLT, then collects Qt. Writes `dist/media-<triple>.tar.xz`
  (`media-<triple>.zip` on Windows).
- `.github/workflows/build-ffmpeg.yml` → renamed `build-media.yml`, named
  `Build media tools`. Same five-target matrix. Release tag `media-<tag>`.
- `scripts/media-versions.sh` (new) → the one place `FFMPEG_TAG=n8.1.3`,
  `MLT_TAG=v7.40.0` and `MEDIA_TAG` (`<ffmpeg>-mlt<mlt>-<n>`, e.g.
  `n8.1.3-mlt7.40.0-1`) are set. Sourced by the build and fetch scripts.
- `CLAUDE.md` → the sidecar table and the ffmpeg paragraph name the new
  workflow, script and release.

## Steps

1. Move the tags into `scripts/media-versions.sh` and source it from
   `build-media.sh`.
2. ffmpeg: keep every configure flag from `build-ffmpeg.sh`, swap static for
   `--enable-shared --disable-static`, and set the install prefix to
   `$STAGE`. No rpath is baked in: the deb/rpm, AppImage, macOS and Windows
   layouts put the binaries and the resources in different places, so phase
   02 sets the library path at every spawn, the way `sidecar_util::
   with_library_paths` already does for llama-server. On macOS, set every
   dylib's install name to `@rpath/<name>` so `DYLD_LIBRARY_PATH` resolves
   it. Keep the existing `-buildconf` check in the workflow that refuses a GPL
   or nonfree build.
3. Qt 6: take it from each runner's package manager, not a source build.
   Ubuntu runners use the `qt6-base-dev`, `qt6-svg-dev` and `libqt6opengl6-dev`
   packages. macOS uses Homebrew `qt`. Windows uses MSYS2 MINGW64
   `mingw-w64-x86_64-qt6-base` and `-qt6-svg`. Collect only the libraries
   `libmltqt6` links against (`ldd` / `otool -L` / `ntldd`), stopping at libc,
   libstdc++, libgcc, X11, xcb, GL, fontconfig and freetype on Linux, which
   the desktop already has (the same line `build-ffmpeg.sh` draws today).
   Plugins copied: `platforms/offscreen` and `imageformats/{jpeg,png,svg,webp}`.
4. MLT: run CMake on `MLT_TAG` with `-DMOD_AVFORMAT=ON -DMOD_QT6=ON
   -DMOD_PLUS=ON -DMOD_PLUSGPL=ON -DMOD_XML=ON -DMOD_NORMALIZE=ON
   -DMOD_KDENLIVE=ON` and every other `MOD_*` set to OFF (frei0r, movit,
   opencv, sdl2, jackrack, ladspa, rtaudio, rubberband, vidstab, vorbis, xine,
   decklink, gdk, glaxnimate, oldfilm, openfx, rnnoise, resample, sox). The
   `kdenlive` module is a few hundred KB of LGPL filters Kdenlive adds when a
   user changes a clip's speed or freezes a frame, so it stays in. Audio
   resampling comes from the avformat module's `swresample`. Point it at
   the staged ffmpeg and Qt with `CMAKE_PREFIX_PATH`. On Windows and macOS
   set `-DRELOCATABLE=ON`, so melt finds its modules relative to itself.
5. Lay the archive out the way phase 02 unpacks it:
   ```
   haruspex-ffmpeg-<triple>[.exe]
   haruspex-ffprobe-<triple>[.exe]
   haruspex-melt-<triple>[.exe]
   media/lib/        libav*, libsw*, libmlt*, Qt libs (DLLs on Windows)
   media/mlt/        MLT modules (lib/mlt-7)
   media/mlt-data/   MLT data (share/mlt-7: profiles, presets, metadata)
   media/qt-plugins/ platforms/, imageformats/
   media/LICENSES/   ffmpeg LGPL, MLT LGPL+GPL, Qt LGPL, each library's notice
   ```
6. In the workflow, add a smoke test for each target that can run natively
   (Linux x86_64, macOS arm64, Windows): unpack the archive, set the
   library path (`LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH` / `PATH`) to
   `media/lib`, `MLT_REPOSITORY=media/mlt`, `MLT_DATA=media/mlt-data`,
   `MLT_PROFILES_PATH=media/mlt-data/profiles`,
   `MLT_PRESETS_PATH=media/mlt-data/presets`,
   `QT_PLUGIN_PATH=media/qt-plugins` and `QT_QPA_PLATFORM=offscreen` (the
   table phase 02's `media_env` encodes), and render
   `melt color:red out=50 -consumer avformat:smoke.mp4 vcodec=mpeg4` plus a
   two-track `qtblend` XML checked into `scripts/fixtures/qtblend-smoke.mlt`.
   Fail the job if the output doesn't exist or is under 1 KB.
7. Publish job: same as today's, with the tag changed to `media-$MEDIA_TAG`,
   every archive listed in SHA256SUMS, and release notes that list the
   ffmpeg, MLT and Qt versions and licences.
8. Strip every binary and library (`strip --strip-unneeded` on Linux,
   `strip -x` on macOS, `-s` at link on Windows). On macOS, ad-hoc sign every
   Mach-O file in the archive (`codesign --force -s -`), matching the app's
   `signingIdentity: "-"`.
9. Fail the job if what the archive adds over today's static ffmpeg pair is
   over 45 MB compressed: the compressed size of `haruspex-melt` plus
   `media/`, plus the new ffmpeg and ffprobe, minus the size of the
   `ffmpeg-n8.1.3` release's pair for that target. The workflow writes each
   target's number to the job summary.

## Build gate

- The `Build media tools` workflow passes on all five targets, smoke tests
  included, from a `workflow_dispatch` run on the branch.
- `shellcheck scripts/build-media.sh scripts/media-versions.sh`.

## Test plan

- Download the Linux x86_64 archive onto Tim's Fedora machine, unpack it to a
  scratch folder, and with the env set by hand, render
  `src-tauri/src/video/kdenlive/fixtures/mix-26.08.kdenlive`. Check the MP4
  plays with picture and sound.
- `ffmpeg -buildconf` from the archive shows `--enable-shared` and no
  `--enable-gpl`.
- `melt -query transitions` lists `qtblend`, `luma`, `mix`.
  `melt -query filters` lists `volume`, `avfilter.alimiter`, `panner`,
  `audiolevel`, `brightness`.
- Record the compressed size of each archive in the PR (commit) message.

## Commit

`build(media): build shared ffmpeg, mlt and qt for bundling`

## Rollback

Revert the commit. The old `ffmpeg-n8.1.3` release and `fetch-ffmpeg.sh` stay
untouched until phase 02, so nothing that ships depends on this phase.
