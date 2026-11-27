# Phase 01 — Speech model setting and whisper VAD

**Depends on:** nothing · **Enables:** phase 02 (the listener relies on a whisper-server
that filters out non-speech) and phase 03 (the frontend's `ensureWhisperReady` picks the
model).

## Goal
Every voice input gets two improvements before constant listening exists.

**Speech model setting.** Settings → Audio → **Speech model** picks whisper base.en (the
default) or large-v3-turbo. The turbo file is the one the video tools already download, so
it's never fetched twice.

**Built-in silence filter.** whisper-server starts with `--vad --vad-model <silero>`, so a
clip with no speech returns empty text instead of made-up words. This ships on its own:
push-to-talk gets more accurate and stops inventing "Thank you." from silence.

## Files touched
- `src-tauri/src/models.rs`: add the Silero VAD constants and the
  `whisper_vad_model_path` / `whisper_vad_model_download` commands, built like
  `whisper_video_model_path` / `whisper_video_model_download`.
- `src-tauri/src/whisper.rs`: `start` takes `vad_model_path: Option<&str>` and adds the VAD
  args. It remembers the model and VAD paths it started with, and doesn't restart if called
  again with the same paths while Ready. The `start_whisper` command gains a
  `vad_model_path: Option<String>` argument.
- `src-tauri/src/lib.rs`: register the two new commands.
- `src/lib/ipc/gen/*` and `src/lib/ipc/commands.ts`: regenerate with
  `./scripts/export-ipc-types.sh`.
- `src/lib/stores/settings.ts`: add `speechModel: 'base.en' | 'large-v3-turbo'`, defaulting
  to `'base.en'`.
- `src/lib/components/settings/AudioSection.svelte`: add a **Speech model** `<select>` under
  "Audio input (microphone)", with a `title` tooltip giving the sizes and that turbo is
  multilingual.
- `src/lib/audio/voiceCapture.svelte.ts`: `ensureWhisperReady` resolves the model path from
  `speechModel` and the VAD path, downloading either if missing, and passes both to
  `start_whisper`. It's exported so phase 03 can call it.
- `src/lib/e2e/installMocks.ts`: mock the two new commands.
- `src/lib/audio/voiceCapture.test.ts` (new): tests for `ensureWhisperReady`.
- `docs/guide/settings.md`: one bullet for **Speech model** under "## Audio".

## Steps
1. In `models.rs`, add:
   - `WHISPER_VAD_MODEL = "ggml-silero-v6.2.0.bin"`, `WHISPER_VAD_SIZE = 885_098`,
     `WHISPER_VAD_SHA256 = "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"`
     (the LFS oid from the Hugging Face API, 2026-11-18).
   - The URL `https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin`.
   - The file goes in `models/whisper/`.
   - Use the same `.partial`, size check and hash check as `whisper_video_model_download`.

   v6.2.0 was smoke-tested against the bundled whisper-server v1.9.2 on 2026-11-18. It
   loaded as `silero-16k` version 6.2.0, and 3 s of silence returned `{"text":""}`.
2. In `WhisperServer`, add `started_with: Mutex<Option<(String, Option<String>)>>`.
   - `start(app, model_path, vad_model_path)` returns `Ok(())` early when `started_with`
     matches and the status is Ready. Otherwise it stops, starts and records the paths.
   - When `vad_model_path` is `Some`, add the args `--vad --vad-model <path>`. The defaults
     are fine: threshold 0.5, minimum speech 250 ms.
   - `VideoWhisper` (port 8768) always passes `None` and is otherwise unchanged.
3. `start_whisper` gets the `vad_model_path: Option<String>` argument. Run
   `./scripts/export-ipc-types.sh`.
4. Add `speechModel` to the `Settings` interface and defaults in `settings.ts`.
5. In `AudioSection.svelte`, add the select:
   - Options: "Fast (base.en, English)" and "Accurate (large-v3-turbo, multilingual)".
   - On change it calls `updateSettings({ speechModel })`. The model loads the next time
     voice input starts, because `ensureWhisperReady` restarts whisper-server when the path
     differs.
6. Rewrite `ensureWhisperReady` in `voiceCapture.svelte.ts`:
   - Model: `speechModel === 'large-v3-turbo'` uses `whisper_video_model_path` /
     `whisper_video_model_download`; otherwise `get_whisper_model_path` /
     `download_whisper_model`.
   - VAD: `whisper_vad_model_path`, downloading with `whisper_vad_model_download` if missing.
     If the VAD download fails, `console.warn` and pass `null` so voice input still works.
   - Always call `start_whisper({ modelPath, vadModelPath })`. The Rust side does nothing if
     it's already Ready with the same paths, which replaces the old early
     `get_whisper_status` Ready return.
   - Then poll for Ready as today. Export the function.
7. Mock `whisper_vad_model_path` (returns a path) and `whisper_vad_model_download` in
   `installMocks.ts`.
8. Add to `docs/guide/settings.md` under "## Audio": "**Speech model**: Fast is quicker;
   Accurate understands more languages and long dictation better, a 1.6 GB download shared
   with the video tools." Keep the table formatting compact and don't run Prettier on the
   guide.

## Build gate
- `cd src-tauri && cargo fmt -- --check && cargo clippy --all-targets -- -D warnings && cargo test`
- `npm run check && npm run lint && npm run test`
- `./scripts/export-ipc-types.sh` leaves no diff
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Rust unit tests in `whisper.rs`:
  - The args built with `Some(vad)` contain `--vad` and `--vad-model <vad>`.
  - The args with `None` contain neither. Factor the arg building into
    `fn server_args(port, model, vad) -> Vec<String>` so it can be tested.
- Vitest in the new `src/lib/audio/voiceCapture.test.ts` (no runes in the test, so not
  `.svelte.test.ts`) for `ensureWhisperReady`, mocking `invoke`:
  - `speechModel: 'large-v3-turbo'` asks for `whisper_video_model_path`.
  - A failed VAD download still calls `start_whisper` with `vadModelPath: null`.
- In the dev app:
  - Push-to-talk works.
  - Holding F2 in silence for 3 s gives the "No speech detected" toast instead of made-up
    text.
  - Switching Settings → Audio → Speech model to Accurate and then using push-to-talk
    restarts whisper-server on turbo (Settings → Logs shows the turbo model path).

## Commit
`feat(voice): add a speech model setting and filter silence with whisper's VAD`

## Rollback
Revert the commit. Settings with a leftover `speechModel` key are harmless, since unknown
keys are ignored. The downloaded `ggml-silero-v6.2.0.bin` stays in `models/whisper/` unused.
It's safe to leave partly applied only if `start_whisper`'s signature and the regenerated
IPC types land together.
