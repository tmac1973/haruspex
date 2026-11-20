# Bundled melt and Shotcut projects — Project Overview

## Problem

The video tools render with melt (MLT's command-line player), and Haruspex
doesn't ship it. A user has to install Kdenlive just so melt is present, even
if they never open Kdenlive. ffmpeg and ffprobe already ship with the app
(`haruspex-ffmpeg`, `haruspex-ffprobe`), so melt is the last thing the video
tools need from outside.

The cut is always written as a `.kdenlive` project. Shotcut also uses MLT, its
`.mlt` project format is plain MLT XML, and many users (Tim included) prefer
it. Right now someone who uses Shotcut gets a project they can't open in the
editor they use.

## Goals

- melt ships with Haruspex on all five release targets (Linux x86_64 and
  aarch64, macOS arm64 and x86_64, Windows x86_64) as
  `haruspex-melt-<triple>`, with the MLT modules and the trimmed Qt 6 it
  needs. It renders any project Kdenlive or Shotcut saves, `qtblend` track
  compositing included.
- ffmpeg is rebuilt as shared LGPL libraries that `haruspex-ffmpeg`,
  `haruspex-ffprobe` and MLT's avformat module all use. It stays LGPL, with no
  x264/x265.
- Video editing works with no editor installed: Settings → Video editing →
  on is enough to cut and render.
- melt is chosen the way ffmpeg is: Auto (bundled, then PATH, then an editor's
  install), Bundled, System, or Custom, in Settings → Video editing.
- The model can create and edit Shotcut projects (`.mlt`) with everything it
  does to `.kdenlive` today: cut, intro/outro, trims, crossfades, loudness,
  transcript and silence edits, the timeline map behind chapters and captions,
  and keeping the user's own edits when it re-reads a file they saved.
- Settings → Video editing → Editor picks the format for new projects:
  Shotcut (the default) or Kdenlive. The model can override it per call. An
  existing project keeps its own format, recognised by its extension.
- While Settings → Video editing is on, the model's own Code tab and Shell
  commands find the bundled `ffmpeg`, `ffprobe` and `melt` on PATH.

## Non-goals

- Converting a project between Kdenlive and Shotcut. The model can build a
  new cut in the other format from the same clips, but effects and the user's
  edits don't carry over.
- Downloading melt on demand. It ships in the installer, the same as ffmpeg.
- Repackaging Shotcut's or Kdenlive's own binaries.
- Driving a running Shotcut window, a preview player, or a Video tab.
- Movit (GPU) rendering. Shotcut projects saved in GPU mode (`movit.*`
  services) are reported as unsupported instead of being rendered wrongly.
- Effects, titles or compositing written by the model in either format,
  beyond what the Kdenlive tools write today. User-added ones are kept.
- Putting the bundled tools on PATH while Video editing is off, or for
  anything outside the Code tab and Shell (MCP servers, jobs).

## Users & primary flow

The user is a creator who edits in Shotcut and has nothing else installed.

1. They install Haruspex and turn on Settings → Video editing. The section
   shows ffmpeg, ffprobe and melt all found as bundled. Editor is Shotcut.
2. In Chat, with their series folder as the working folder: "Make ep12 from
   the clips, intro and outro as usual."
3. The model probes the clips and writes `ep12/ep12.mlt`: intro, the clips in
   order with trims, crossfades, outro, and loudness normalisation.
4. The model renders it in the background with the bundled melt. A progress
   card shows, and a follow-up turn reports and checks the result.
5. The user opens `ep12.mlt` in Shotcut, moves a clip, adds a title, and
   saves. They ask the model to cut the long pause in clip 3. The model
   re-reads the saved `.mlt`, keeps the title and the move, makes the cut,
   and renders again.
6. A Kdenlive user who sets Editor to Kdenlive gets today's behaviour, with
   rendering that no longer needs Kdenlive installed.
7. In the Code tab, the model can run `ffmpeg -i clip.mp4 …` or `melt …` in its
   own commands and gets the bundled copies.

## Constraints

- Tauri 2 sidecar rules: every binary is `haruspex-<tool>-{triple}` (the deb
  and rpm `/usr/bin` collision rule guarded in `runtimes.rs`). MLT's modules,
  data and Qt go in a resources folder of their own, apart from
  `binaries/libs/` and `binaries/sd-libs/`, because their sonames could clash
  with the system's or llama.cpp's.
- Licensing: Haruspex is GPL-3.0-or-later, so MLT's GPL modules (qt6,
  plusgpl) are fine to ship. ffmpeg stays LGPL with no GPL or nonfree parts.
  The licence texts for ffmpeg, MLT and Qt ship in `binaries/media/LICENSES/`
  inside every package, and the `media-<tag>` release notes list them.
- Size: about 70–80 MB uncompressed per platform, 30–40 MB compressed, added
  to the installer. Only the modules the two editors' projects use get built:
  core, avformat, xml, plus, plusgpl, qt6, normalize and kdenlive. No
  frei0r, movit, opencv, sdl, jack or ladspa.
- MLT is pinned to a tag (7.40.0, the version Kdenlive 26.08 uses), in the
  build script and the fetch script together, the same way `FFMPEG_TAG` is.
- Built in CI by the existing `Build ffmpeg` workflow, renamed `Build media
  tools`, and published to a `media-<tag>` release with SHA256SUMS. Dev setup
  downloads it, and CI stubs the files for `tauri-build`.
- The AppImage env scrub (`env_util::sanitize_appimage_env`) and the orphan
  registry apply to the bundled melt as they do now.
- macOS: the app is ad-hoc signed (`signingIdentity: "-"`, no
  notarisation), so every bundled dylib and Qt plugin is ad-hoc signed too,
  or arm64 refuses to load it.
- The user guide (`video-editing`, `video-render`, `settings-tools`, `code`,
  `shell`) is updated in the same commit as each change, and each page
  stays under 6 KB.

## Success criteria

- On a clean VM for each of the five targets with no Kdenlive, Shotcut or
  ffmpeg installed, Settings → Video editing shows all three tools as
  bundled, and a two-track project with `qtblend` renders to an MP4 that plays
  and has both tracks composited.
- A `.mlt` the model writes opens in Shotcut without warnings and plays the
  same as the render. A `.kdenlive` it writes still opens in Kdenlive 26.08.
- A `.mlt` saved by Shotcut with user edits (a moved clip, a text filter, an
  extra track) keeps all of them after a model edit and a re-render.
- Every video tool test that runs on Kdenlive fixtures has a Shotcut
  equivalent, and they pass in `cargo test` with the bundled melt.
- `deb` and `rpm` packages install alongside the distro's `mlt` and `ffmpeg`
  packages without a file conflict.
- With Video editing on, `which melt ffmpeg ffprobe` in a new Code tab
  command or a new Shell session names the shim folder; with it off, they
  don't. A Shell session already open keeps the PATH it started with.
- What this adds to the installer (melt, `media/`, and the change in
  ffmpeg/ffprobe size) is no more than 45 MB compressed on any target.

## Decisions

- **Qt in the bundled melt** → Bundle MLT's qt6 module with a trimmed Qt 6
  (offscreen platform), so `qtblend` projects from either editor render.
- **Where melt comes from** → Built in our own workflow, with ffmpeg rebuilt
  as shared LGPL libraries for both ffmpeg and MLT. Not repackaged from
  Shotcut.
- **Delivery** → Shipped in the installer, like ffmpeg.
- **Which melt renders by default** → Bundled first (Auto: bundled, PATH,
  editor), with Bundled / System / Custom choices in Settings → Video editing.
- **Format for new projects** → Settings → Video editing → Editor, defaulting
  to Shotcut. The model can override it per call, and existing projects keep
  their format.
- **Shotcut feature scope** → Full parity with today's Kdenlive tools.
- **Bundled tools on the model's PATH** → Yes for Code tab and Shell
  commands, but only while Settings → Video editing is on.
- **Release targets** → All five, the same as ffmpeg.
- **Converting between formats** → Non-goal.
