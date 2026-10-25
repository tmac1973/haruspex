# Video editing — Project Overview

## Problem

Making a YouTube video from recorded footage is mostly mechanical: put the clips
in order, trim the ends, add the usual intro and outro, even out the audio,
render, write a title, description and chapters, and upload. Today Haruspex
can't help with any of it. The model has no way to read video files, build an
edit or render one, so the work happens by hand in Kdenlive.

Many users record everything in OBS with one set of settings. Others mix screen
recordings, phone clips and camera footage with different resolutions, frame
rates and codecs. Both need to work.

## Goals

- From Chat, the user names a folder of clips and asks for a video. The model
  builds a cut and renders an upload-ready MP4.
- First version of the cut: clips in order, trimmed in/out points, a saved intro
  and outro, optional crossfades, and audio loudness normalised for YouTube.
- The cut is a stock Kdenlive project (`.kdenlive`) in the video's folder,
  rendered with melt. The user can open it in Kdenlive, change it and save, and
  the model keeps editing that same file. Both work on one timeline.
- Renders run in the background with progress and Cancel. The conversation gets
  a follow-up turn when one finishes, so the model can report and check the
  output.
- Transcript editing: whisper transcribes the footage with timestamps. The model
  can cut silences and retakes, and write chapters and an SRT caption file.
- Looking at the footage: scene detection, plus frame contact sheets for vision
  models, so the model knows what each clip shows.
- Thumbnails: a 1280×720 image made from a chosen frame or with the image
  backend.
- YouTube upload of the render with title, description (chapters included) and
  thumbnail. Captions are not uploaded: the SRT is saved next to the render for
  the user to add in YouTube Studio. The user confirms every upload in a dialog that shows what will be
  sent and lets them pick private, unlisted or public (private preselected).
- Works on Linux, macOS and Windows.

## Non-goals

- Driving a running Kdenlive window live (D-Bus). Stock Kdenlive doesn't expose
  an editing API, and patched forks are out.
- Bundling ffmpeg or melt with Haruspex. They come from the user's Kdenlive
  install or PATH.
- An ffmpeg-only render path for users without melt.
- A dedicated Video tab, clip-list UI or preview player. The work happens in
  Chat (and Code); Kdenlive is the visual editor.
- Colour grading, effects, title/text overlays, picture-in-picture or other
  multi-track compositing written by the model. The model keeps whatever the
  user adds in Kdenlive, but doesn't author those itself.
- Running in subtasks or unattended Jobs.
- Platforms other than YouTube.
- Scheduled publishing.

## Users & primary flow

The user is a YouTube creator with a folder of raw clips for an episode.

1. In Chat, with the series folder (say ~/Videos/show) picked as the working
   folder: "Make a video from ep12, intro and outro as usual." 
2. The model probes the clips (length, resolution, frame rate, codecs, audio)
   and, as asked, transcribes them or looks at frames.
3. The model writes `ep12.kdenlive` in the folder: intro, clips in order with
   trims, optional crossfades, outro, and loudness normalisation. It summarises
   the cut in the chat.
4. The model starts a render. It renders at the project's format, which is
   the Settings → Video preset unless the model chose another for this video. A progress card
   shows percent and time left, with Cancel. Chat stays usable.
5. When the render finishes, a follow-up turn reports the file, its length and
   size, and checks it (duration matches the cut, audio present, loudness).
6. Optionally: the user opens `ep12.kdenlive` in Kdenlive, adjusts it, saves,
   and asks for more changes or a new render. The model re-reads the saved file
   and keeps the user's edits.
7. Optionally: the model writes chapters, captions and a description, makes a
   thumbnail, and asks to upload. The upload dialog shows the file, title,
   description, thumbnail and a visibility choice. Nothing is sent until the
   user confirms.

## Constraints

- Stack: Tauri 2 (Rust) + SvelteKit 5. Tools are registered in
  `src/lib/agent/tools/`; subprocesses are run from Rust.
- melt is required for rendering and ffmpeg/ffprobe for probing, audio
  extraction, frames and loudness measurement. Lookup order: the path set in
  Settings → Video, then PATH, then inside a Kdenlive install (Windows: Kdenlive's
  `bin` folder; macOS: `kdenlive.app/Contents/MacOS`). Settings → Video says
  plainly what's missing.
- The project file must open cleanly in the stock Kdenlive current on each
  platform. On Linux the reference is Kdenlive 26.08 / melt 7.42.
- File access: the conversation's working folder (Chat's folder icon, or the
  Code session's folder) is the series folder. Each episode is a subfolder, and
  the project, renders, transcripts and thumbnails go in the episode folder.
  Intro and outro may be anywhere in the series folder, or at a path set in
  Settings → Video, which is the only thing read from outside it.
- Offered in Chat and Code. Off until Settings → Video finds melt, ffmpeg and ffprobe.
- Output preset is set in Settings → Video (1080p30, 1080p60, 1440p60, 2160p30),
  and the model can override it for a video.
- Uploading publishes content, so every upload needs a confirmation in the app.
  It uses Haruspex's Google OAuth app, verified for Calendar (#388, closed);
  adding youtube.upload needs another verification round.
- Each user-visible piece updates `docs/guide/` in the same PR. New settings,
  tools and the upload dialog follow the UI copy rules.

## Success criteria

- A folder of OBS clips becomes a rendered MP4 from one Chat request, with
  intro, outro, trims, crossfades and normalised audio (integrated loudness
  within 1 LU of -14 LUFS).
- A folder of mixed-format clips (different resolution, frame rate and codec)
  renders to the chosen preset without errors or A/V drift.
- The `.kdenlive` file the model writes opens in stock Kdenlive on Linux, macOS
  and Windows with no warnings. A Kdenlive render of it matches the melt render.
- After the user edits and saves the project in Kdenlive, a model edit keeps
  every change the user made.
- During a render Chat stays responsive, Cancel stops it within a few seconds,
  and a follow-up turn arrives when it finishes.
- Transcript editing removes silences longer than a set threshold, and the
  chapters it writes land within a second of the right spot.
- No upload happens without the user confirming it in the dialog, and the
  dialog's visibility choice is what YouTube shows.
- The test suites pass on Linux, macOS and Windows.

## Decisions

- **Where an edit starts** → In Chat; the tools also work in Code.
- **Footage types** → Mostly matching OBS clips, but mixed sources must work for
  other users.
- **First-version edits** → Trim in/out, intro/outro, crossfades, loudness
  normalising.
- **How Kdenlive fits in** → Two-way: the model and the user edit the same
  `.kdenlive` project.
- **Users with only ffmpeg** → melt is required; no ffmpeg render fallback.
- **File access** → The working folder bounds the tools; nothing outside it is written.
- **Folder layout** → Both: the working folder is a series folder with episode
  subfolders, and Settings → Video can also name intro/outro paths elsewhere.
- **While rendering** → Background render with a progress card, Cancel, and a
  follow-up turn when it finishes.
- **Later pieces in scope** → Transcript editing, looking at the footage,
  YouTube upload, thumbnail generation.
- **Upload visibility** → Chosen per upload in the confirm dialog, private
  preselected.
- **Platforms** → Linux, macOS and Windows now.
- **Finding binaries** → Settings override, then PATH, then inside the Kdenlive
  install.
- **Tabs** → Chat and Code; not subtasks or Jobs.
- **Output format** → A preset picked in Settings → Video, which the model can
  override per video.
- **Writing .kdenlive files** → Start from a shipped empty Kdenlive 26.08
  template and make targeted edits, keeping everything else byte-for-byte.
- **YouTube OAuth client** → Haruspex's existing OAuth app with the
  youtube.upload scope added as a separate sign-in (another verification round).
- **Encoder** → libx264 by default; a hardware encoder offered in Settings →
  Video only when a test encode with it succeeds.
- **Captions on upload** → Not uploaded; youtube.upload only, SRT saved next to
  the render.
- **Edit tools** → A declarative `video_cut` for the whole main track plus small
  ops (trim, remove, move).
- **Transcription model** → Optional whisper large-v3-turbo download in
  Settings → Video; base.en until then.
