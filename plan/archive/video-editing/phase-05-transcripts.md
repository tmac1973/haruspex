# Phase 05 — Transcripts: silence and retake cuts, chapters, captions

**Depends on:** 01 (folder rules, ffmpeg), 02 (project edits), 03 (renders the
caption file sits beside), 04 (gains re-applied to split pieces) · **Enables:** 06 and 07 (`timeline_map.rs`), 08 (chapters in the upload
description)

## Goal

The model can transcribe an episode's footage with timestamps, find silences,
and cut silences and retakes out of the main track. It can also write YouTube
chapters and an SRT caption file from the cut. Transcription uses whisper
large-v3-turbo when the user has downloaded it in Settings → Video, and the
installed base.en until then. A separate whisper-server instance does the work,
so voice input is never interrupted.

## Files touched

- `src-tauri/src/sidecar_util.rs` — add `ports::WHISPER_VIDEO = 8768`.
- `src-tauri/src/lib.rs` — register the four new commands and the three model
  commands.
- `src-tauri/src/video/mod.rs` — declare `transcribe`, `silence`, `subtitles`.
- `src-tauri/src/video/kdenlive/mod.rs` — declare `timeline_map`.
- `CLAUDE.md` — add 8768 (whisper-server for video transcription, while
  transcribing) to the localhost ports table.
- `src-tauri/src/models.rs` — add `get_whisper_video_model_path`,
  `download_whisper_video_model` and `delete_whisper_video_model` for `ggml-large-v3-turbo.bin` from
  `ggerganov/whisper.cpp` on Hugging Face, with the same partial-file, LFS-hash
  check and `download-progress` events as `download_whisper_model`.
- `src-tauri/src/whisper.rs` — add `start_video_instance(model)` /
  `stop_video_instance()` on port 8768, and `transcribe_file(path, offset)`.
  The latter posts a WAV path's bytes with `response_format=verbose_json`, has
  no 30 s timeout (per-request timeout 15 min) and returns segments.
- `src-tauri/src/video/transcribe.rs` — new: audio extraction, chunking at
  silences, transcription and the transcript cache.
- `src-tauri/src/video/silence.rs` — new: ffmpeg `silencedetect` wrapper.
- `src-tauri/src/video/kdenlive/timeline_map.rs` — new: maps source times on
  main-track items to timeline times and back, mixes included.
- `src-tauri/src/video/kdenlive/edit.rs` — new ops `remove_ranges` and
  `remove_silences`.
- `src-tauri/src/video/subtitles.rs` — new: SRT writer and the chapters
  validator/writer.
- `src-tauri/src/video/commands.rs` — `video_transcribe`, `video_silences`,
  `video_write_captions`, `video_write_chapters`; extend
  `video_project_summary` with an optional timeline transcript.
- `src/lib/ipc/gen/*` — regenerated (`Transcript`, `Segment`, `SilenceRange`,
  `Chapter`, new `ProjectOp` variants).
- `src/lib/stores/settings.ts` — no new field; the model choice is "turbo when
  downloaded".
- `src/lib/components/settings/VideoSection.svelte` — a "Transcription model"
  row: shows base.en or large-v3-turbo, a Download button (1.6 GB) with
  `DownloadProgressBar`, and Delete (`delete_whisper_video_model`).
- `src/lib/agent/tools/video.ts` — add `video_transcribe`, `video_silences`,
  `video_captions`, `video_chapters`; `video_edit` gains the two new ops;
  `video_project_read` gains `transcript?: boolean`.
- `src/lib/agent/tools/video.test.ts` — extend.
- `docs/guide/video.md` — add "Cut silences and retakes", "Chapters and
  captions", and the transcription model.

## Steps

1. **Model download.** Mirror `download_whisper_model` for
   `ggml-large-v3-turbo.bin`, hardcoding its size (1,624,555,275 bytes) and
   LFS sha256
   (`1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69`, read
   from the Hugging Face API on 2026-10-25) the way base.en's are. Store it in
   `models/whisper/`. Delete removes the file, and a running video instance
   is stopped first.
2. **Video whisper instance.** `start_video_instance` launches
   `haruspex-whisper-server` with `--model <turbo or base.en> --host 127.0.0.1
   --port 8768`, reusing `sidecar_util::start_sidecar` and `poll_health`. It
   starts on the first `video_transcribe` and stops 5 minutes after the last
   one finishes, or on app exit. Voice input keeps using 8766.
3. **Audio extraction.** `ffmpeg -nostdin -i <clip> -map 0:a:<audio_index> -vn
   -ac 1 -ar 16000 -c:a pcm_s16le <episode>/.haruspex/audio/<sha1 of path+size+
   mtime>.wav`, reused while the source is unchanged.
4. **Chunking.** Run `silencedetect=noise=-35dB:d=0.4` on the WAV. Choose chunk
   boundaries at the silence midpoint nearest each 300 s mark (fall back to
   the 300 s mark when no silence lies within ±30 s). Extract each chunk with
   `-ss/-to` into a temp WAV, send it, and add the chunk offset to every
   segment time.
5. **Transcribe.** Request fields: `response_format=verbose_json`,
   `temperature=0`, and `language=auto` (turbo) or `en` (base.en). Keep
   segments as `{ start, end, text }`; the result shape doesn't use word
   timestamps. Cache as
   `<episode>/.haruspex/transcripts/<clip stem>-<hash8>.json` with the model
   name. A cached transcript from base.en is redone when turbo is now
   available and the model asks with `refresh: true`.
6. **`video_transcribe` tool.**
   - Takes `{ episode, paths?, refresh? }` and blocks with progress
     ("Transcribing obs.mp4, 12:00 of 32:23"). `ctx.signal` cancels the
     in-flight request and stops the instance.
   - Only offered when `interactive`, and refused in subtasks like the other
     video tools.
   - Result: per clip, `[mm:ss] text` lines, capped at 12,000 characters. When
     longer, it says so and points to `video_project_read { transcript: true }`
     and the cache file.
   - When base.en was used, it ends with "Transcribed with base.en; Settings →
     Video can download a more accurate model."
7. **`video_silences` tool.** `{ episode, path, min_secs = 1.5, noise_db = -35
   }` → silence ranges in source time, from `silence.rs` on the cached WAV
   (extracting it first if needed).
8. **New ops.**
   - `remove_ranges { index, ranges: [{ from_secs, to_secs }] }` (source time
     within item `index`) splits the item into the kept pieces. Each piece
     inherits the item's user filters, and Haruspex's gain is re-applied to
     each.
   - `remove_silences { index?, min_secs = 1.5, pad_secs = 0.25 }` runs
     silence detection on the item's source range (or every item when `index`
     is omitted) and removes each silence shrunk by `pad_secs` at both ends.
   - Both return the summary and the time saved.
9. **Timeline mapping (`timeline_map.rs`).** Given the main track, it maps a
   source time on an item to its timeline time, accounting for mix overlaps.
   It also lists which source ranges are visible at each timeline span.
   `video_project_read { transcript: true }` uses it to print the cut's
   transcript in timeline time, `[hh:mm:ss] text`, for the transcribed items.
   Untranscribed items show as `[…] (not transcribed: obs2.mp4)`.
10. **Captions.** `video_captions { episode, project?, render? }` maps every transcribed
    segment through the timeline and drops parts that were cut. It splits
    lines longer than 42 characters into two and caps cues at 7 s. The SRT is
    written next to the given render (`<render stem>.srt`), or next to the
    latest render in `<episode>/renders/`, or as `<episode>/<project stem>.srt`
    when there's no render.
11. **Chapters.** `video_chapters { episode, project?, chapters: [{ title, at }] }`,
    where `at` is a timeline time (`mm:ss` or `hh:mm:ss`). Validate YouTube's
    rules: the first chapter at 0:00, at least 3 chapters, each at least 10 s
    long, ascending. Errors are returned for the model to fix, with no
    clamping. The schema description tells the model to take each `at` from
    the start of the first segment of the chapter in
    `video_project_read { transcript: true }`, which is already in timeline
    time. Write the chapter text block to `<episode>/<project stem>.chapters.txt`
    and return it.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff.
- `npm run test` and `cargo test` also pass on mactest and wintest
  (`ssh haruspex-mac`, `ssh haruspex-win`).

## Test plan

- Rust:
  - Chunk boundary choice from recorded `silencedetect` output.
  - Segment offset merging across chunks.
  - verbose_json parsing from a recorded whisper-server response.
  - Transcript cache keys.
  - `remove_ranges` on goldens: pieces, gains and lengths, with a user effect
    copied to each piece.
  - `remove_silences` padding.
  - Timeline mapping with and without mixes.
  - SRT line splitting and cue caps.
  - Chapter rule violations each give their message.
  - A segment start mapped through a golden with two mixes and a removed range
    lands within one frame of the expected timeline time. That's what makes
    chapters taken from the timeline transcript accurate.
- Integration (ignored, needs whisper-server and the base.en model):
  transcribe a 90 s fixture clip with two pauses. The segments cover the
  speech, and pause times fall in silence ranges.
- Vitest:
  - Tool result capping and the base.en note.
  - The settings download row states.
  - `video_transcribe` cancellation calls stop.
- Manual, Linux:
  - Download turbo in Settings → Video.
  - Use voice input while a transcription runs: both work.
  - On ep010, "cut the silences longer than two seconds": the project is
    shorter and Kdenlive shows the split pieces.
  - "Add chapters and captions": the chapters block validates and the SRT
    lines up with speech in the render, within 1 s at five spot checks. Each
    chapter time in `<project stem>.chapters.txt`, sought to in the render,
    starts within 1 s of the topic the chapter names.

## Commit

`feat(video): transcribe footage, cut silences and write chapters and captions`

## Rollback

Revert the commit. Projects with removed ranges are ordinary split clips. The
turbo model file and `.haruspex/transcripts|audio` can be deleted by hand.
Port 8768 is used only while transcribing, so nothing else depends on it.
