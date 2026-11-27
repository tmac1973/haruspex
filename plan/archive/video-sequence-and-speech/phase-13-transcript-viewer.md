# Phase 13 — Transcript viewer and edit list

**Depends on:** 10 (word-timed transcripts), 11 (saved voices for the Voice
picker), 12 (the video tab) · **Enables:**
14 (the skill applies the saved edit list)

## Goal

Beside a clip in the video tab, show its word-timed transcript: click a word
to seek, see the current word follow playback, strike words to cut, and
retype a span to replace it. The viewer never changes the clip or the
project; it saves an edit list beside the transcript, and **Send to chat**
puts `/fix-speech apply <edits file>` in the folder's conversation.

## Files touched

- `src/lib/video/edits.ts` — the edit-list type and helpers:
  `SpeechEdits { version: 1, clip: string, transcript_hash: string,
  voice?: string, edits: Edit[], done: string[] }` — `transcript_hash` is
  the SHA-256 of the transcript's words (text, start, end) as JSON; `voice`
  is the saved voice for this clip's replacements; `Edit = { id, kind: 'cut', from, to, words } | { id,
  kind: 'replace', from, to, old, new, mode: 'auto'|'fit'|'cut', voice? }`;
  path: the `edits/` folder beside the `transcripts/` folder that holds the
  clip's cached transcript (`<episode>/.haruspex/edits/<clip stem>.edits.json`,
  where `<episode>` is the folder `video_transcribe` cached it under); read, write, merge
  overlapping edits, and `stale(edits, transcript)`.
- `src/lib/components/TranscriptPane.svelte` — the pane: words as spans with
  times; current-word highlight from the video's `timeupdate`; click seeks;
  select words then **Cut** (strike) or **Replace…** (inline text field);
  an edit's chip has **Undo**; **Transcribe** when the clip has none yet
  (calls `video_transcribe` for that clip with the editor window's folder as
  the episode, and shows progress); a **Voice** picker of saved voices; **Save** and
  **Send to chat**.
- `src/lib/components/VideoViewer.svelte` — a **Transcript** toggle that
  opens the pane beside the player.
- `src-tauri/src/video/commands.rs` — `video_transcript_for { path } →
  Option<{ transcript, cache_path }>` (reads the cache without transcribing;
  `cache_path` fixes where the edits file goes); export-ipc-types.
- `src/lib/editor/chatBridge.ts` — `sendToChat({ folder, text })`: emits
  `editor://send-to-chat` to the main window.
- Main window listener (beside `listenInMainWindow` in
  `src/lib/code/windows.ts`'s pattern, in `src/lib/editor/chatBridge.ts`):
  finds the most recent Chat or Code session whose working folder contains
  `folder`, else creates a new Chat with that folder; prefills its composer
  with the text; raises the main window. Nothing is sent.
- Tests: `edits.test.ts`, `chatBridge.test.ts`, `TranscriptPane` component
  test (word click → seek event; select + cut → edit saved).
- `docs/guide/viewers.md` — "Read and mark a transcript" (or a new
  `transcript-viewer.md` page if `viewers.md` passes 6 KB; add it to `PAGES`).

## Steps

1. Edit-list module and its tests.
2. `video_transcript_for` and the pane's load: transcript from the cache;
   edits file when present; a stale edits file (transcript hash changed) is
   shown greyed with **Discard**.
3. Pane interactions as listed; keyboard: Space plays/pauses, ← / → step a
   word, `Delete` cuts the selection, `Enter` on a selection opens Replace.
   Add them to `src/lib/shortcuts.ts` and the `shortcuts` guide page.
4. Save writes the edits file through `fs_write` inside the episode folder.
5. Send to chat: save first, then `sendToChat` with
   `/fix-speech apply <path>`, where `<path>` is the edits file's absolute
   path (built from `cache_path`) made relative to the chosen conversation's
   working folder.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo test` · export-ipc-types leaves no diff · the shortcuts test.

## Test plan

- Unit: overlapping edits merge; a replace across a cut splits correctly;
  `stale` detects a changed transcript.
- Component: clicking a word emits a seek to its start; select two words and
  Cut writes one `cut` edit with both.
- Hand: open an OBS recording, transcribe it from the pane, strike an "um",
  retype a phrase, **Send to chat** — the folder's Chat opens with the
  command in its box.

## Commit

`feat(editor): word-timed transcript viewer with an edit list`

## Rollback

Revert the commit; edits files already saved stay in `.haruspex/edits/`
unused.
