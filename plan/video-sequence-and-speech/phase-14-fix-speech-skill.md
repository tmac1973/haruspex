# Phase 14 — The fix-speech skill

**Depends on:** 02 (frame trims), 03 (speed, holds, gain ranges), 10 (word
times, `transcribe_audio`), 11 (saved voices), 12 (the video tab), 13 (edit
lists) · **Enables:**
the transcript-driven speech replacement end to end

## Goal

Ship a `fix-speech` skill that applies a transcript edit list to the
episode's project: cut struck words, and speak each replacement in a saved
voice, keep the take that said the words, mute the original span and place
the take — fitting it to the span or shifting the timeline as demofixrr's
**auto** mode does. A small tool reads and maps the edit list so the model
never does time arithmetic by hand.

## Files touched

- `src-tauri/resources/skills/fix-speech/SKILL.md` — the skill (below), with
  `metadata: { haruspex-needs: video, haruspex-tools: video_speech_edits }`.
- `src/lib/agent/tools/video-speech-edits.ts` — tool `video_speech_edits`
  (category `'video'`): reads an edits file, checks it against the clip's
  transcript, and maps each edit onto the project: which main-track clip
  holds it, the span in that clip's source time and in cut time, the span's
  length, and the speech around it. With `mark_done: [ids]` it adds them to
  the file's `done` list; with `set_voice: <name>` it writes the file's
  `voice`.
- `src/lib/video/edits.ts` — `mapEdits(edits, summary)` used by the tool.
- `src/lib/video/fitCut.ts` — `planReplacement(spanSecs, takeSecs, mode)` →
  `{ mode: 'fit', speed }` when `0.85 ≤ span/take ≤ 1.25` (or forced fit),
  else `{ mode: 'cut', trimSecs | holdSecs }`.
- Tests: `video-speech-edits.test.ts`, `fitCut.test.ts`.
- `docs/guide/speech-replacement.md` — new page (add to `PAGES`): saved
  voice first, transcribe, mark edits, apply, what fit and cut do, the lip
  sync limit, the consent warning.
- `docs/guide/media-skills.md` — one table row for `fix-speech`, pointing at
  the new page; trim the page's longest section so it stays under 6 KB.

## Steps

1. `fitCut.ts` and `mapEdits`, with tests.
2. `video_speech_edits` tool. An edit whose span crosses two clips is
   reported as an error for that edit, with the reason.
3. The skill's instructions, in order:
   1. Call `video_speech_edits` for the file; stop and say why if it is stale.
   2. Cuts: `video_edit` `remove_ranges` with the mapped spans, each widened
      by 30 ms on both sides and snapped to frames.
   3. For each replacement:
      - Voice: the edit's `voice`, else the edits file's `voice`, else ask once
        and store the answer with `video_speech_edits` `set_voice`. With no saved voice, stop and point at
        Settings → Audio → Saved voices (and `voice_from_clip`).
      - Takes: `generate_speech` with the new text and voice, up to 3 times
        with different seeds; after each, `transcribe_audio` the take and stop
        as soon as its words match the new text (ignoring case and
        punctuation). Otherwise keep the closest. When two takes have the same
        WAV hash (a server that ignores `seed`), stop making takes for that
        edit and say so in the report.
      - Save the take to `<episode>/speech/<edit id>.wav`.
      - `planReplacement` (through the tool's result): **fit** → mute the
        span with `video_edit` `gain_range` (−70 dB) and place the take on an
        audio track at the span's cut time with `speed`; **cut** shorter →
        `remove_ranges` the spare tail of the span, mute the rest, place the
        take; **cut** longer → mute the span, `video_edit` `hold` with `at_secs` =
        the span's end (splits the clip there and holds that frame) for the
        extra time, place the take.
   4. `video_speech_edits` with `mark_done`.
   5. Report each edit: what was cut or said, fit or cut, the take's
      transcript, and that the mouth still moves to the old words.
4. Guide pages.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo test` (the shipped-skill seeding test picks up the new skill). The
Guide check needs the new page.

## Test plan

- Unit: `planReplacement` boundaries (0.85, 1.25, forced modes);
  `mapEdits` on a project where the clip was trimmed and split; a stale file
  is refused.
- Hand (success criterion): on a real recording with a saved voice on
  llama-toolchest Qwen3-TTS, strike a word and retype a phrase in the viewer,
  **Send to chat**, run it; the render plays in the video tab, the struck
  word is gone, the new phrase is in the saved voice, and speech after it
  stays in sync. Run once on a remote model and once on Qwen3.8-Flash.

## Commit

`feat(skills): fix-speech applies transcript edits with a saved voice`

## Rollback

Revert the commit; the shipped-skill record keeps a user's edited copy and
removes an unedited one on the next update. Projects already edited keep
normal clips, audio tracks and filters.
