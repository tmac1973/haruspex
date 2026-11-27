# Phase 15 — Speaking clips and sections (Wan2.2 S2V)

**Depends on:** 01 (capability parsing, multipart inputs), 02 (frame trims),
04 (spec, clip plan, progress, estimate), 05 (job config and pipeline), 06
(keyframes), 07 (generate stage), 08 (checks), 09 (sound and assembly), 11
(speech engine and saved voices for the lines) · External: llama-toolchest
v2.64.0 or newer, with the Wan2.2 S2V set (tmac1973/llama-toolchest#686) ·
**Enables:** talking presenters in generated videos, and speaking clips in
Chat

## Goal

Use llama-toolchest's Wan2.2 S2V set, which turns a portrait and a speech
track into a video of that person speaking. `generate_video` takes an `audio`
input. The Video sequence spec gets a **speaking** section: a portrait and
lines of text. A new Speech stage speaks the lines before the clip plan is
built. The job then makes one S2V window per stretch of speech, always from
the same portrait, and places the same audio under the picture so the lips
and the sound line up.

## Files touched

- `src/lib/toolchest/models.ts` — read the `audio` capability (an audio
  *input*) and `meta.video.fixed_fps` into `VideoLimits.fixedFps`.
- `src-tauri/src/audio_cache/commands.rs` — command `audio_cache_import { path,
  conversation_id?, code_session_id? } → { hash, mime }`: copy a file from the
  working folder into the audio cache (the same store `audio_store_url`
  writes), linked to the chat or session when given.
- `src-tauri/src/video/commands.rs` — `video_mux_audio { video, audio, out }`
  (`ffmpeg -i video -i audio -map 0:v -map 1:a -c:v copy -c:a libopus
  -shortest`); `audio_join { parts: { path, from_secs, to_secs }[], out }` (slices of one
  or more WAVs joined end to end into one WAV);
  `audio_silences { path, min_secs } → SilenceRange[]`, calling
  `video::silence::detect` (−35 dB) on any audio file in the working folder.
  export-ipc-types.
- `src/lib/videogen/types.ts` — `VideoRequest.audio?: { hash }` (a file in the
  audio cache).
- `src/lib/videogen/toolchest.ts` — send `audio` as a multipart file part from
  the audio cache by hash (the same no-bridge upload `start_image` uses, with
  an audio-cache source added to `toolchestUpload`). An instance with
  `fixedFps` is asked at that rate. A request with `audio` sends no length
  unless the caller gave one, so the server follows the audio. The error
  codes `audio_required`, `start_image_required`, `bad_audio` and
  `over_limit` become plain messages.
- `src/lib/agent/tools/video-gen.ts` — `audio` argument: a sound file in the
  working folder (imported with `audio_cache_import`), or speech or a song
  made in the conversation (already in the cache). On an instance with the
  `audio` capability, `start_image` and `audio` are both required. Without
  `seconds`, the clip is as long as the audio. Audio longer than the
  instance's longest clip (`maxFrames / fixedFps`, 5.1 s on the S2V set) is
  refused before upload, with that limit and a note to split the speech at
  pauses. The tool refuses `audio` on any other instance. `fitClip` uses
  `fixedFps`.
- `src/lib/agent/tools/_videoJob.ts` — the chat tool's task: when the request
  has `audio`, store the clip with that audio muxed in as Opus
  (`video_mux_audio`), so it plays with sound in the chat. sd.cpp builds from
  6cd0ef1 put the driving audio in the WebM as PCM, which the webview may not
  play, and older builds make silent video; the mux replaces either. The job
  calls `generateVideo` directly (phase 07) and does not mux.
- `src/lib/sequence/spec/types.ts`:
  - A third `Section` kind: `{ kind: 'speaking', id, portrait?: string,
    portrait_prompt?, prompt, lines: { id, text, voice? }[], window_join?:
    'cut'|'crossfade' }`. `prompt` describes the setting and motion.
    `window_join` defaults to `cut`.
  - `StartRef` gains `portrait(section)`.
  - `ClipPlanItem` gains `audio?: { parts: { file, line_hash, from_secs,
    to_secs }[], out }`, where `out` is the window's WAV path and `line_hash`
    is the line WAV's hash from the progress file. A line spoken again has a
    new hash, so the item changes and phase 04's merge resets its clip.
  - Line ids must be unique in the spec.
- `src/lib/sequence/spec/validate.ts` — the context gains `speaking?: {
  limits, capabilities }` (the job's speaking instance). A speaking section
  needs it, with the `audio` capability. Duplicate line ids are an error. It needs a portrait (a user path, or
  a keyframe from the image backend), else it is an error naming the section.
  When `fixedFps` differs from the project's fps, it adds a note ("S2V makes
  16 fps; the project is 24 fps"). The project fps comes from
  `projectFormat` (below), passed in the context as `projectFps`.
- `src/lib/sequence/spec/format.ts` — `projectFormat(spec, instance,
  settings)`, phase 09's rule (the preset matching the instance's size and fps,
  else the spec's `preset`, else Settings → Video editing → Format) moved out
  of `assemble.ts` so the validator and assembly share it.
- `src/lib/sequence/spec/plan.ts` — `planClips(spec, limits, speech?,
  speakingLimits?)`. It stays pure: no IPC. The
  new `speech` argument maps line ids to `{ file, secs, hash, silences }`. Without
  it, a speaking section is planned from an estimate (below), marked
  `estimated`. With it, the section is planned into windows.
- `src/lib/sequence/spec/estimate.ts` — speaking sections count their windows.
  Before the Speech stage, a line's length is estimated at 150 words a minute.
- `src/lib/sequence/spec/progress.ts` — `speech: Record<line id, { file,
  secs, hash, text, voice }>` and `windows: Record<window id, { file, parts_key }>`, where `parts_key` is
  a hash of the window's `parts` (line hashes included).
- `src/lib/agent/jobs/types/video-sequence/definition.ts` — a **Speech** stage
  between Spec and Keyframes in `SEQUENCE_STAGES`.
- `src/lib/agent/jobs/types/video-sequence/config.ts`, `Editor.svelte` —
  `speaking_instance_id` (optional; the list shows only video instances with
  `audio`).
- `src/lib/agent/jobs/types/video-sequence/speech.ts` — the Speech stage.
- `src/lib/agent/jobs/types/video-sequence/keyframes.ts` — speaking sections
  without a `portrait` get a portrait keyframe ("<style>, portrait of
  <subject>, facing the camera, <prompt>") at `keyframes/<section>.png`.
- `src/lib/agent/jobs/types/video-sequence/generate.ts` — `portrait(section)`
  resolves to the section's `portrait` path, else `keyframes/<section>.png`.
  Window items go to the speaking instance with `audio` (the window's slice,
  imported with `audio_cache_import`).
- `src/lib/agent/jobs/types/video-sequence/check.ts` — speaking windows are
  checked against the portrait only (same person). There is no seam check,
  since windows don't continue each other.
- `src/lib/agent/jobs/types/video-sequence/assemble.ts` — each window is
  trimmed to its audio's length in frames (phase 02's `out_frame`). A
  window clip's own sound is muted (`gain_range` −70 dB over the clip),
  since the window's slice carries the same speech. The
  window's audio slice goes on an audio track at the window's cut time
  (−14 LUFS, as speech). Joins between windows follow `window_join` (a
  crossfade is 0.3 s). Speaking audio counts as narration for the music level
  (−30 LUFS under it). The project format is never chosen from the speaking
  instance.
- Tests: `plan.speaking.test.ts`, `validate.test.ts` and `progress.test.ts`
  cases, `video-gen.test.ts` cases, `speech.test.ts`, `assemble.test.ts`
  cases, Rust tests for the four commands.
- `docs/guide/video-generation.md` — "Make someone speak". `docs/guide/
  video-sequence.md` — speaking sections.

## Steps

1. Capability parsing, `audio_cache_import`, the `audio` request part,
   `fixedFps`, the error messages, and the tool argument rules. A request
   without `seconds` sends no length; the server rounds the audio's length up
   to `4n + 1` frames at 16 fps. The tool checks the audio's length first, so
   a long track fails with a clear note instead of `over_limit` after the
   upload.
2. `video_mux_audio`, `audio_join` and `audio_silences`; muxing in
   `_videoJob.ts`.
3. Spec types, validator context and rules, and the config field. The
   speaking instance is separate from `video_instance_id`, so one job can mix
   I2V sections and speaking sections.
4. The checkpoint at the spec (phase 05) shows speaking windows as "about N
   windows", from the 150-words-a-minute estimate.
5. Speech stage (after Spec, before Keyframes):
   - Speak each line through the speech path (phases 09 and 11) into
     `<episode>/narration/<section>-line-NN.wav`. Phase 09's narration files
     are `<section>-N.wav`, so the `line-` part keeps the two apart.
   - Record each line's `{ file, secs, hash, text, voice }` in the progress
     file. A line already recorded, whose file is present and whose text and
     voice match the record, is not spoken again. So a re-run gives the same lengths and keeps the same
     windows.
   - Read each line WAV's silences with `audio_silences`. Then build the clip
     plan with `planClips(spec, limits, speech, speakingLimits)`.
   - For each window item, make its WAV with `audio_join` (its `parts`, to
     its `out`) unless the progress file lists it with the same `parts_key`
     and the file is present. Every later stage uses this
     plan, and the progress merge (phase 04) keys on its items.
6. `planSpeaking` (inside `planClips`): pack consecutive lines into windows of
   at most the instance's longest clip (`maxFrames / fixedFps`). A single line
   longer than that is split at the longest silence nearest the middle,
   repeating until each piece fits. Each piece is at least 1 s. The window
   limit comes from `speakingLimits`. Each window item is `{ start:
   portrait(section), audio: { parts, out:
   '<episode>/narration/<section>-win-NN.wav' }, trimFirstFrame: false }`;
   the Speech stage writes the WAVs (step 5).
7. Transitions next to a speaking section: `lastFrameOf(last clip of A)` is the
   last window's clip when A speaks. `firstFrameOf(B)` is B's portrait when B
   speaks.
8. Generate: every window starts from the section portrait. S2V's start image
   is an identity reference, not a frame the output keeps, so last-frame
   chaining is not used, and seams between windows show. Progress, resume,
   retries and Attended's stop after the first window work as for other
   clips (phase 07). The window count is real from the Speech stage on;
   after the first window, the time left is estimated from its wall time
   (about 11 min for a 3 s window at 832×480 on an R9700).
9. Check and assemble as listed.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo fmt -- --check` · `cargo clippy` · `cargo test` · export-ipc-types
leaves no diff. The Guide check needs the two pages.

## Test plan

- Unit:
  - An instance with `audio` refuses `generate_video` without a start image,
    and a non-S2V instance refuses `audio`.
  - A request with `audio` and no `seconds` sends no `frames` or `seconds`.
  - A 6 s track on an instance with 81 frames at 16 fps is refused before
    upload, naming 5.1 s.
  - `over_limit` and `bad_audio` from the server become plain messages.
  - Three lines of 4, 6 and 9 s with a 10 s window limit become two windows,
    [4 + 6] and [9].
  - A 25 s line splits at silences into pieces of 10 s or less.
  - Every window's `start` is `portrait(section)`.
  - A re-run with all lines recorded speaks nothing and plans the same
    windows; a changed line text or voice speaks that line again, remakes
    its window WAV and resets that window's clip, even when the new take has
    the same length.
  - The [4 + 6] window has two `parts`, one from each line WAV.
  - Duplicate line ids fail validation.
  - Assembly trims each window to its audio, mutes the window clip's own
    sound, places the slice at the window's time, and puts music at −30 LUFS
    under it.
- Rust:
  - `audio_join` of two slices gives their summed length within 10 ms.
  - `video_mux_audio` output has one video and one audio stream.
  - `audio_silences` finds a 0.5 s gap in a fixture.
  - `audio_cache_import` refuses a path outside the working folder.
- Hand (toolchest v2.64.0, the `s2v` instance on asmodean or compute2):
  - In Chat, "make this portrait say 'hello, welcome to the channel'" plays
    with the voice and moving lips, on an sd.cpp build both before and after
    6cd0ef1 (silent and PCM results).
  - A sequence of a snow section, a speaking section of three lines in a
    saved voice, and a forest section renders with the speech in sync, and
    with the S2V windows at 16 fps in a 24 fps project.

## Commit

`feat(video): speaking clips and sections with Wan2.2 S2V`

## Rollback

Revert the commit. Specs with a speaking section then fail validation with
"unknown section kind", and other specs are unaffected. The Speech stage
disappears. Muxed clips already saved keep their sound.
