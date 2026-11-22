# Long generated videos and speech replacement — Project Overview

## Problem

Haruspex can make one short clip with a llama-toolchest video model and can cut
clips into a Shotcut or Kdenlive project, but it cannot make a long video. A
two-minute piece ("a fox walking in snow for a minute, then a fox in a summer
forest") needs about 24 clips of 5 s on LTX-2.3, each continuing from the last
frame of the one before, plus transitions, existing footage and sound. Today
the model would have to chain two dozen background tasks by hand inside one
chat, over several hours, with nothing to resume from when it fails.

Separately, demofixrr (a standalone Descript-style editor) shows a workflow
Haruspex users want: transcribe a take with word-level times, cut words, and
replace a phrase with new speech in the speaker's own voice. Haruspex has the
pieces for cutting by segment but not by word, its speech is Kokoro only with
fixed voices, and its viewers can neither play video nor show a transcript.

Both gaps rest on the same missing video-tool primitives: frame extraction,
crop/fill, clip speed, hold frame, audio gain over a range, keeping a clip's
own sound, and frame-accurate trims. These are general editing operations, not
features for one workflow.

## Goals

- **Shared video primitives** in `video_edit` / `video_cut` and the Rust video
  module, usable by any skill or job:
  - extract one frame at full size as PNG (the true last frame, or a frame at a
    time) into the episode folder;
  - per-clip fit: fill (crop), letterbox, or a custom crop region;
  - clip speed (video and audio together, or audio-only on an audio track);
  - hold the last (or first) frame of a clip for a set time;
  - gain or mute over a time range of a clip's sound;
  - keep the sound of a generated clip when the model makes it;
  - frame-accurate trims, so a repeated seam frame can be dropped;
  - a 720p / 24 fps project format.
- **`generate_video` takes `end_image`** when the instance supports it.
- **A Video sequence job type** that turns a one-line brief into one rendered
  video:
  - an optional interview stage that asks only what the brief leaves open;
  - the model writes the spec through a forced tool call; the runner checks it
    against the chosen instance's limits and writes it to the episode folder;
  - sections are generated (text-to-video, or from a start image the user
    gives, or from a keyframe still the job makes with the image backend) or
    existing clips from the episode folder;
  - each section is chained clip to clip (last frame → `start_image`);
  - each join is a hard cut, a crossfade, or a generated transition clip
    (last frame of A → first keyframe of B via `end_image`), named in the spec;
  - sound is any mix the spec names: the clips' own sound, a generated music
    bed, narration;
  - optional vision checks on each seam and on drift against the keyframe,
    with one retry on a new seed;
  - assembles a normal Shotcut or Kdenlive project and renders it;
  - Attended (interview, stop at spec + keyframes, stop after each section's
    first clip) and Unattended (no stops) modes;
  - resumes after a restart from the spec and the clips on disk;
  - shows the clip count before generating, and the time left once the
    first clip has been made.
- **Speech replacement**:
  - word-level timestamps from whisper in `video_transcribe`;
  - a `transcribe_audio` tool for any audio file in the working folder;
  - a llama.cpp `/tts` speech backend (any llama-server v0.8.0+, direct or
    through llama-toolchest) beside Kokoro, with a reference voice;
  - saved voices in Settings → Audio: reference clips you add or cut from your
    footage, each with a consent checkbox and a strong warning;
  - a video tab in editor windows (also plays renders, closing #755);
  - a transcript viewer beside it: word-timed text, click to seek, strike
    words or retype a span, saved as an edit list beside the transcript;
  - a shipped `fix-speech` skill that applies an edit list: cuts words, speaks
    replacements in a saved voice, makes several takes, transcribes them to
    pick the one that said the words, mutes the original span and places the
    take.
- **Speaking clips and sections** with llama-toolchest's Wan2.2 S2V set:
  `generate_video` takes an `audio` input (with a portrait), and the sequence
  spec gets a speaking section whose lines are spoken first. One S2V window is
  made per stretch of speech, each from the same portrait, with the same audio
  placed under the picture.
- Guide pages updated in the same PRs as each user-visible change.

## Non-goals

- Lip sync inside a replaced span. That includes remaking the span's picture
  with S2V: a generated face cut into real footage is unlikely to match, so
  it waits until S2V has been tried on real footage.
- Voice fine-tuning (XTTS-style training) or speaker-similarity scoring.
- Getting a voice from the web, or any reference clip without the user's
  consent checkbox.
- Making or proposing jobs from Chat or the Code tab (`propose_job`). v1 only
  keeps the job's options and spec as plain data so that tool is a small
  addition later.
- A generic OpenAI `/v1/audio/speech` backend.
- Changes to llama-toolchest. The speech asks are done
  (tmac1973/llama-toolchest#683: the Qwen3-TTS card, and the `/tts` fields
  documented). Multi-frame continuation is not available
  (tmac1973/llama-toolchest#681): for LTX-2.3 it needs a toolchest route that
  runs a DGL script in sd-server, which is not scheduled; for S2V it needs
  model code in sd.cpp (leejet/stable-diffusion.cpp#2399). Haruspex uses it
  by capability when it lands.
- Applying transcript edits from the viewer without the assistant.
- Video upscaling of generated clips.
- Running the speech replacement as a job; it stays a chat / Code skill.

## Users & primary flow

**Long generated video (Jobs tab):**

1. Open Jobs → new job → **Video sequence**. Pick the episode folder, the run
   mode, the video instance (from Settings → Video generation), and write the
   brief: "2 minutes: a fox walking in snow, then a fox in a summer forest,
   a gentle piano bed".
2. Attended: the job asks the open questions one at a time (join type,
   sound, per-section length, start images, existing clips to mix in).
3. The model writes the spec; the runner validates it, writes
   `<episode>/sequence.json`, and says how many clips it will make.
4. With an image backend, the job makes a keyframe still for each generated
   section without a user start image. Attended stops to show the spec and the
   stills.
5. The job generates each section, clip by clip; Attended stops after each
   section's first clip.
6. With a vision model, each seam is checked; a failed clip is made once more.
7. It makes the music bed and narration the spec names, assembles the project,
   renders, checks loudness and length, and writes a report.

**Speech replacement (Chat or Code tab, video tools on):**

1. Add a saved voice in Settings → Audio (tick the consent box), or ask the
   assistant to cut one from the footage.
2. Ask "transcribe ep012"; open the transcript in an editor window, beside the
   video.
3. Click words to seek; strike words to cut; retype a span to replace it.
   Save.
4. Ask the assistant to apply the edits (or press the viewer's **Send to
   chat**). `fix-speech` cuts the words, makes takes in the saved voice, picks
   the best, mutes the original span, places the take, and reports.
5. Render as usual.

## Constraints

- Stack: SvelteKit 5 runes front end, Tauri 2 Rust back end; video work runs
  through the bundled ffmpeg, ffprobe and melt (`src-tauri/src/video/`,
  `media_env.rs`).
- Projects stay normal Shotcut (`.mlt`) and Kdenlive (`.kdenlive`) files that
  the user can open and change; every new op must load in melt (the existing
  backup-and-validate step) and be visible in both editors where they support
  it.
- The video tools are confined to the working / episode folder.
- Video generation goes through the existing toolchest client
  (`src/lib/videogen/`); jobs survive a restart only from what is on disk.
- The 9B local model is a floor, not the design target: model work in the job
  is split into small structured turns, and the runner does the chaining.
- Licence and consent: the guide and Settings carry a strong warning that
  copying a person's voice without their consent is not allowed.
- Changing a Tauri command or `#[ts(export)]` struct means
  `./scripts/export-ipc-types.sh`; user-visible changes update `docs/guide/`.
- Speaking sections need llama-toolchest v2.64.0 or newer with the Wan2.2
  S2V set (tmac1973/llama-toolchest#686). S2V runs at a fixed 16 fps, makes
  at most 81 frames (about 5.1 s) a clip, and takes about 11 minutes for a
  3 s clip on an R9700. Its start image is an identity reference, so seams
  between windows show. Its clip carries the driving audio as PCM on newer
  sd.cpp builds and is silent on older ones.
- Run time: about 2–4 hours for 2 minutes on LTX-2.3 Full; the job must report
  progress and resume.

## Success criteria

- The fox brief, run Unattended against llama-toolchest LTX-2.3, produces one
  rendered ~2-minute MP4 in `ep…/renders/` with two sections, a join of the
  chosen kind, and the chosen sound, plus a Shotcut project that opens in
  Shotcut.
- Killing Haruspex mid-run and starting the job again continues from the next
  missing clip.
- A sequence that mixes an existing clip from the episode folder with
  generated sections renders without size or frame-rate errors.
- Each new primitive has Rust tests, loads in melt, and has a guide entry.
- On a real recording, `fix-speech` cuts a struck word and replaces a retyped
  phrase in a saved toolchest voice, the render plays in the new video tab, and
  the rest of the clip stays in sync.
- A saved voice cannot be added without the consent checkbox.
- `npm run check`, `npm run lint`, `npm run test`, `cargo test`, `cargo clippy`
  pass.

## Decisions

- **Order of the three parts** → shared primitives, then the Video sequence
  job, then the speech work.
- **Where a sequence run lives** → an episode folder: spec, keyframes, clips,
  project and renders all there; existing clips come from it.
- **Section joins** → hard cut, crossfade, or generated transition; the spec
  names one per join and the interview asks when the brief doesn't.
- **Sound** → any mix the spec names: clips' own sound, a music bed,
  narration.
- **Run modes** → Attended (interview, stop at spec + keyframes and after each
  section's first clip) and Unattended (no stops; interview only if the brief
  is too thin).
- **Self-checking** → optional, with a vision model: seam and drift checks,
  one retry on a new seed, then kept and flagged.
- **Video models** → any toolchest video instance, planned by its capability
  meta; tested on LTX-2.3.
- **Keyframes without an image backend** → optional; a section then opens
  with text-to-video. The user can also give a start image for any generated
  section, and mix in existing video clips.
- **Voice cloning rule** → only clips the user adds or cuts from their own
  footage, with a consent checkbox and a strong warning that copying a voice
  without consent is not allowed.
- **Editing UI for speech** → a transcript viewer in v1.
- **How viewer edits apply** → the viewer saves an edit list; the assistant
  applies it.
- **Playback in the viewer** → a video tab in editor windows, folding in #755.
- **llama-toolchest asks** → issues on that repo, not phases here.
- **Speech backend** → a llama.cpp `/tts` server (direct or via toolchest);
  Kokoro stays the default and the read-aloud voice.
- **Jobs from Chat/Code** → not in v1; job options and spec stay plain data
  so a `propose_job` tool can come later.
- **Wan2.2 S2V** → added after the speech phases as phase 15: an `audio`
  input on `generate_video` and a speaking section kind, with windows made
  from the same portrait rather than chained by last frame. Windows are cut
  along the speech at pauses, and the visible seams are accepted until
  upstream adds motion frames.
- **The `audio` capability** → toolchest's `audio` means an audio input. A
  set's sound output is not in its meta, so Haruspex finds it by probing the
  clip.
- **Qwen3-TTS on llama-toolchest** (from tmac1973/llama-toolchest#683) →
  never send `speed` (it answers 400 for anything but 1.0); stretch takes in
  Haruspex instead. A seed gives another take but does not reproduce one on
  a GPU, so takes are kept as audio. Saved voices keep the reference clip's
  text and send it as `speaker_ref_text` for a closer voice.
