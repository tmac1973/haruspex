---
title: Replace words in a recording with your own voice
description: Cutting words out of a recording and saying new ones in your saved voice — saving the voice, marking edits on the transcript, the fix-speech skill, how a new take is fitted, and the limits.
---

# Replace words in a recording with your own voice

You can strike words out of a recording and retype others, and Haruspex speaks the new words in your own voice and edits the project to match. It uses the transcript viewer and the `fix-speech` skill.

Only use your own voice, or a voice you have clear permission to use. Copying someone's voice without their consent is not allowed, can be illegal, and has led to lawsuits.

## 1. Save your voice

Replacements need a saved voice and a llama.cpp speech server: Settings → Audio → Speech engine → **llama.cpp server**, then Settings → Audio → Saved voices. You can also ask "save my voice from 0:41 to 0:55 of ep012/raw/cam.mp4"; the assistant asks you to confirm it is your voice first. See the `speech` page.

## 2. Mark the edits

Open the recording in an editor window, tick **Transcript**, and transcribe it if it has no transcript yet. Strike words to cut (**Cut**) and retype words to say instead (**Replace…**). Pick your voice under **Voice**. See the `transcript-viewer` page.

## 3. Apply them

Press **Send to chat**. The folder's chat opens with `/fix-speech apply <edits file>` in its box; press Enter. The skill then:

- cuts each struck word out of the project, with a few hundredths of a second either side so no breath is left;
- speaks each new phrase in your voice, transcribes the take, and tries again (up to three times) until it says the words you typed;
- mutes the old words and puts the take on an audio track under the picture;
- reports what it did, and suggests rendering.

The project must already have the recording on its main track (see the `video-cut` page). Nothing changes the recording itself.

## How a new take fits

- **Close to the old words' length** (from 0.85 to 1.25 times): the take is sped up or slowed down to fit exactly, with its pitch kept, and nothing else moves.
- **Much shorter**: the spare end of the gap is cut out of the picture.
- **Much longer**: the picture holds its frame at the gap's end for the extra time.

Either way the speech after it stays in sync. Retyping in the viewer asks for **auto** (Haruspex picks); the edit list can force **fit** or **cut**.

## What it doesn't do

- Move the mouth: in a replaced stretch, the lips still say the old words.
- Work without a saved voice, or with Kokoro, which can't copy a voice.
- Apply an edit that spans two clips in the project, or words already cut out; it says which.
- Run as a job. It runs in Chat or the Code tab.
