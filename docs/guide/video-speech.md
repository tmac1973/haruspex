---
title: Transcripts, chapters and captions
description: Transcribing video footage, cutting silences and retakes by what was said, writing YouTube chapters and an SRT caption file, and the transcription model.
---

# Transcripts, chapters and captions

The assistant can transcribe an episode's footage and use what was said to cut it, mark chapters and write captions. Setting up the video tools and making the project are on the `video` page.

## Transcribe the footage

Ask "transcribe ep012". Each clip with sound is transcribed with timestamps, in that clip's own time; the step shows which clip and how far it has got. **Stop** cancels between pieces. A long recording takes a few minutes.

Transcripts are kept in the episode's `.haruspex/transcripts/` folder, so asking again is instant until a clip changes. The sound is extracted once to `.haruspex/audio/`.

### The transcription model

Settings → Video → **Transcription** shows the model. Until you download one, it is voice input's whisper base.en: fast, English only, and it misses words. **Download large-v3-turbo (1.6 GB)** gets a more accurate one that knows more languages; ask to transcribe again with the new model afterwards. **Delete** removes it.

Transcription runs its own copy of whisper-server on port 8768, so voice input keeps working. It stops five minutes after the last transcription.

## Cut silences and retakes

- "Cut the silences longer than two seconds from ep012" cuts each one, leaving a quarter second of quiet at each side. Without a clip number it does every clip.
- "Cut the retake at 4:10 in clip 2" cuts a stretch the assistant finds in the transcript. A clip cut in the middle becomes two pieces on the main track; each keeps the clip's effects.
- "Where are the silences in the OBS recording?" lists them without cutting.

The cuts go into the Kdenlive project like any other edit, and you can undo one there. Clips joined by a crossfade made in Kdenlive can't be cut this way; see the `video` page.

## Write chapters

Ask "add chapters to ep012". The assistant reads the cut's speech in the video's time and picks where each topic starts. YouTube needs the first chapter at 0:00, at least three, and each ten seconds or longer; Haruspex checks those before saving. The chapters go in `<project>.chapters.txt` in the episode folder, ready for the video's description.

## Write captions

Ask "write captions for ep012". The SRT is made from the clips' transcripts, mapped into the cut, so removed parts have none. It is saved next to the newest render (`renders/ep012-…srt`), or next to the project before there is one. Lines are at most 42 characters, two to a caption, and each caption stays up for at most seven seconds.

Haruspex doesn't upload captions. Add the file in YouTube Studio → Subtitles.

## What it doesn't do

- It doesn't tell speakers apart.
- It doesn't fix the transcript's mistakes: edit the captions file to correct them.
- It doesn't caption clips that weren't transcribed; the assistant says which.
