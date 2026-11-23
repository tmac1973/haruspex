---
title: Read and mark a video's transcript
description: The transcript beside a video in an editor window — transcribing a clip, following the words as it plays, marking words to cut or replace, and sending the edit list to the chat.
---

# Read and mark a video's transcript

Open a video in an editor window (see the `viewers` page) and tick **Transcript** under it. The clip's words show beside the player, each with its time.

## Get a transcript

If the clip was transcribed before (by asking "transcribe ep012", or with `transcribe_audio`), its transcript shows at once. Otherwise press **Transcribe**; the pane shows how far it has got. Long recordings take a few minutes. The transcript is kept, so the next time it opens at once. The transcription model is set in Settings → Video editing → Transcription.

## Follow and move around

- The word playing now is highlighted as the video plays.
- Click a word to play from it.
- Click in the transcript, then use ← / → to step a word at a time and Space to play or pause.

## Mark words to cut or replace

- Click a word, then Shift-click another to select the words between.
- **Cut** (or Delete) strikes them through.
- **Replace…** (or Enter) asks for the words to say instead. They are underlined.
- Each edit is listed under the words with its time; click the time to play from there, and **Undo** removes it.
- **Voice** picks the saved voice the new words are spoken in (Settings → Audio → Saved voices; see the `speech` page).

The pane never changes the clip or the project. **Save** keeps the edit list in the folder's `.haruspex/edits/` folder, next to the transcript, as `<clip>.edits.json`.

If the clip is transcribed again later, an edit list made on the old transcript shows greyed with **Discard**, since its times may no longer match.

## Send the edits to the chat

**Send to chat** saves the list and puts `/fix-speech apply <edits file>` in the input box of the most recent Chat or Code session working in this folder, or in a new Chat set to it, and brings the main window forward. Nothing is sent until you press Enter there.

## What it doesn't do

- Cut or replace anything by itself: the `fix-speech` skill does that in the chat.
- Edit the transcript's words, or tell speakers apart.
- Show a transcript for a clip in another folder than the window's.
