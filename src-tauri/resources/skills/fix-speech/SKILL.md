---
name: fix-speech
description: Apply a speech edit list from the transcript viewer to an episode's project — cut the struck words, and speak each retyped phrase in the speaker's saved voice, fitted into the cut. Use when the user runs /fix-speech apply <edits file>, or asks to apply the transcript edits, fix what was said, or replace words in a recording with their saved voice.
metadata:
  haruspex-needs: video
  haruspex-tools: video_speech_edits
---

# Fixing speech

The user marked words in the transcript viewer: struck ones to cut, and
retyped ones to say again in their own saved voice. The list is a file in
`.haruspex/edits/`. `video_speech_edits` reads it, knows where each edit
sits in the project, and makes the change itself when you `apply` it. Your
part is the voice and the takes.

## 1. Read the list

Call `video_speech_edits` with `path`: the file the user named. If it says
the list was made on an older transcript, or an edit can't be placed,
**stop** and tell the user why in one sentence each. Don't guess times.

## 2. Make the cuts

For each `cut` edit, call `video_speech_edits` with `path` and `apply`: its
id. Read the result before the next: positions move after every change.

## 3. Make each replacement

**Voice.** Use the edit's voice, else the list's. If there is none, ask the
user once which saved voice to use, then store it with `set_voice`. If
there are no saved voices, or Settings → Audio → Speech engine is Kokoro,
**stop**: a saved voice needs a llama.cpp speech server. Point the user to
Settings → Audio → Saved voices, or offer `voice_from_clip` on a stretch of
their own speech. Never pick a voice for someone else's words.

**Takes.** Up to three tries:

1. `generate_speech` with the new words, the voice, `seed` (a new number
   each try), and `path`: `<episode>/speech/<edit id>.wav` (the episode is
   the folder above `.haruspex/` in the list's path; add `overwrite: true`
   after the first try).
2. `transcribe_audio` the take, with `language` if it isn't English.
3. If its words match the new words (ignore case and punctuation), keep it
   and stop trying. Otherwise try again.

After three, keep the closest take. If two takes have the same hash
("take …" in the result), the server ignores the seed: stop trying for
this edit and say so in the report.

**Place it.** Call `video_speech_edits` with `apply`: the id, and `take`:
the take's path. It mutes the old words and puts the take on an audio
track: fitted to the gap when the lengths are close, else with the
picture trimmed or held so the speech after it stays in sync.

## 4. Report

For each edit, one line: what was cut or said, whether the take was fitted
or the picture changed, and the take's transcript when it didn't match.
Say once that the mouth still moves to the old words in replaced stretches,
and suggest rendering (`video_render`) and watching it in the video tab.
