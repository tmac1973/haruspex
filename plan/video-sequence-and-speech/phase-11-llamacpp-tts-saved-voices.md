# Phase 11 — A llama.cpp speech backend and saved voices

**Depends on:** 09 (narration uses the speech path), 10 (word times pick a
clean stretch to cut a voice from) · **Enables:** 14 (replacements in the
speaker's voice)

## Goal

Add a second speech backend beside Kokoro: any llama-server v0.8.0+ that
serves `/tts`, reached directly or through llama-toolchest, with a reference
voice. Saved voices are reference clips the user adds in Settings → Audio, or
asks the assistant to cut from their footage, each confirmed with a consent
checkbox under a strong warning. `generate_speech` and the Video sequence
narration can use them. Kokoro stays the default and the read-aloud voice.

## Files touched

- `src/lib/stores/settings.ts` — `speechBackendKind: 'kokoro' | 'llama-server'`,
  `speechServerBaseUrl`, `speechServerApiKeyId`, `speechServerModelId`;
  `GenerationServer.kind` adds `'llama-server'` so Saved servers lists it.
- `src/lib/toolchest/kind.ts` — a `speech` kind: list models whose meta says
  `speech: true` (through `probeInferenceServer`, not a webview fetch).
- `src-tauri/src/speech_server.rs` — `speech_server_synthesize { base_url,
  key_id, model, text, voice_id?, seed?, speed? } → StoredSpeech`: POST
  `/tts` (multipart with `speaker_ref` when a voice is given, else JSON),
  read the WAV, store it in the audio cache like `tts_synthesize_to_cache`;
  pass `seed`/`speed` only when set. The result carries a SHA-256 of the WAV
  so a caller can tell two takes apart.
- `src-tauri/src/voices.rs` — saved voices in `<app data>/voices/<id>/`:
  `reference.wav` (mono, 24 kHz, 5–30 s) and `voice.json { id, name, source:
  'file'|'clip', source_path?, from_secs?, to_secs?, consented_at }`.
  Commands `voices_list`, `voice_add_file { path, name, consent }`,
  `voice_add_clip { path, from_secs, to_secs, name, consent }` (extracts with
  ffmpeg), `voice_delete`, `voice_read_bytes`. `consent` must be true or the
  command fails.
- `src-tauri/src/lib.rs` — register the commands.
- `src/lib/audio/voiceConsent.ts` — the warning text constant.
- `src/lib/components/settings/AudioSection.svelte` — **Speech engine**
  (Kokoro / llama.cpp server with ServerAddress, key and model) and **Saved
  voices** (list with play and delete, **Add from file…**). Adding shows the
  warning and the checkbox; **Add** is disabled until it is ticked.
- `src/lib/agent/tools/speech-gen.ts` — with the llama-server backend,
  `voice` accepts a saved voice name; new `seed`; the tool result shows the
  take's WAV hash and length; Kokoro voices still work
  when Kokoro is chosen. Register `voice_from_clip` (category `'video'`):
  path, from, to, name; it calls `askUserQuestion` with the warning and
  **This is my voice, or I have permission** / **Cancel**, and only on the
  first answer calls `voice_add_clip`.
- `src/lib/agent/jobs/types/video-sequence/sound.ts` — narration uses the
  chosen speech backend and a saved voice when the line names one.
- Tests: `voices.rs`, `speech_server.rs` (against a local fake HTTP server),
  `speech-gen.test.ts`, `AudioSection` store tests.
- `docs/guide/speech.md` — speech engines, saved voices, and the warning;
  replace "No copying a real person's voice" with the consent rule.
  `docs/guide/settings.md` — the two new Settings → Audio sections.
- `src/lib/ipc/gen/*` — export-ipc-types.

## Steps

1. The warning text, used in Settings, the tool's question and the guide:
   "Only use your own voice, or a voice you have clear permission to use.
   Copying someone's voice without their consent is not allowed, can be
   illegal, and has led to lawsuits." Keep it in one constant in
   `src/lib/audio/voiceConsent.ts`.
2. Settings fields, Saved servers kind, and the `speech` model list.
3. `voices.rs`: store, convert to mono 24 kHz with the bundled ffmpeg, refuse
   clips under 5 s or over 30 s, refuse `consent: false`. `voice_add_clip` is
   confined to the working folder.
4. `speech_server.rs`: the `/tts` call, with the key resolved by key id as
   the other toolchest calls do; a 404 says the server needs llama.cpp
   v0.8.0 or newer.
5. Wire `generate_speech`: when `speechBackendKind === 'llama-server'`, route
   to `speech_server_synthesize`; the voice list in its schema is the saved
   voices. Read-aloud (F3) and the speaker icon stay on Kokoro.
6. `voice_from_clip`: the model picks a stretch with phase 10's word times
   (10–20 s of continuous speech, no music); the tool's question shows the
   path and range and the warning.
7. Narration in the sequence job uses the same route.
8. Guide pages; export-ipc-types.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo fmt -- --check` · `cargo clippy` · `cargo test` · export-ipc-types
leaves no diff.

## Test plan

- Rust: `voice_add_*` with `consent: false` fails and writes nothing; a 3 s
  clip is refused; `speech_server_synthesize` sends `speaker_ref` only with a
  voice, and a 404 gives the version message.
- TS: `voice_from_clip` does nothing when the answer is **Cancel**;
  `generate_speech` routes by backend.
- Hand: add a Qwen3-TTS GGUF by hand on llama-toolchest's Models page (the
  catalog entry is an upstream ask; `/tts` serves a hand-added model today), save a voice from your own
  recording, "say 'this is a test' in my voice" plays in that voice;
  Settings → Audio's **Add** stays disabled until the box is ticked.

## Commit

`feat(speech): llama.cpp /tts speech engine and consent-gated saved voices`

## Rollback

Revert the commit. Saved voices stay in `<app data>/voices/` unused; Kokoro is
the only engine again.
