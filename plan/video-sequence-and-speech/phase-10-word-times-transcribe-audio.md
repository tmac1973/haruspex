# Phase 10 — Word-level timestamps and transcribing any audio file

**Depends on:** nothing · **Enables:** 11 (cutting a voice from a stretch of
speech), 13 (the word-timed transcript viewer), 14 (cuts by word, scoring
takes)

## Goal

Give every transcript word-level times, and let the assistant transcribe any
audio file in the working folder, not only an episode's clips. Captions,
retake cuts and filler removal all get more precise, and generated speech can
be checked against the words it was meant to say.

## Files touched

- `src-tauri/src/whisper.rs` — `Word { start, end, text }` (ts-exported);
  `Segment.words: Vec<Word>` (serde default); `parse_verbose` reads each
  segment's `words`; `transcribe_segments` sends `split_on_word=true` and
  asks for word timestamps.
- `scripts/dev-setup.sh` — the whisper.cpp pin, only if step 1 finds the
  pinned commit does not return per-word times.
- `src-tauri/src/video/transcribe.rs` — cache key gains a format version
  (`v2`) so old segment-only caches are redone once; `Transcript` carries the
  words through; `timeline_transcript` maps words into cut time too.
- `src-tauri/src/video/commands.rs` — new command `audio_transcribe { path,
  language? } → Transcript` for any audio or video file inside the working
  folder (same `VideoWhisper` lease and chunking).
- `src/lib/agent/tools/video-transcribe.ts` — `video_transcribe` gains
  `words: { from, to }` to return a stretch with each word's time (the plain
  report stays segment lines); register `transcribe_audio` (category
  `'video'`): path, optional language, optional `words`.
- Tests: `whisper.rs` (parse with and without `words`), `transcribe.rs`,
  `video-transcribe.test.ts`.
- `docs/guide/video-speech.md` — word times and "Transcribe any audio file".
- `src/lib/ipc/gen/*` — export-ipc-types.

## Steps

1. Check the bundled whisper-server: POST a fixture to `/inference` with
   `response_format=verbose_json`, `split_on_word=true` and
   `token_timestamps=true`, and look for per-word entries in each segment.
   If the pinned whisper.cpp does not return them, move the pin in
   `scripts/dev-setup.sh` to the first upstream commit that does, rebuild,
   and check again before the next step.
2. Parse `words` into `Segment.words`, trimming whitespace and dropping
   empty tokens; a segment without words keeps an empty list.
3. Bump the transcript cache format to `v2` in `cache_path`.
4. `audio_transcribe`: path checked against the working folder; extract
   16 kHz mono with `audio_wav`; transcribe in the same chunks; cache under
   `<working folder>/.haruspex/transcripts/`.
5. Tool changes and guide; export-ipc-types.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo fmt -- --check` · `cargo clippy` · `cargo test` · export-ipc-types
leaves no diff.

## Test plan

- Rust: `parse_verbose` on a recorded whisper-server answer with words gives
  increasing word times inside each segment; on an answer without words,
  empty lists; a `v1` cache file is ignored.
- Live (`#[ignore]` test like the existing transcribe test): a fixture
  sentence gives one word per spoken word, each within its segment.
- TS: `transcribe_audio` refuses a path outside the working folder;
  `words: {from, to}` returns only that stretch.
- Hand: "transcribe ep012" then "cut the 'um' at 0:42": the cut lands on the
  word.

## Commit

`feat(speech): word-level timestamps and transcribe any audio file`

## Rollback

Revert the commit. `v2` cache files are ignored by the old code (different
name), which transcribes again.
