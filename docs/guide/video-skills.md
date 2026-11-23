---
title: Skills for video and voice
description: The shipped skills for video and speech — cut-video, clean-up-talk, fix-speech, make-sequence and save-my-voice — what each does, where it stops to ask, and what it needs.
---

# Skills for video and voice

These skills chain the video and speech tools into whole tasks. Each needs the video tools: Settings → Video editing → **Let the assistant edit videos**, with ffmpeg, ffprobe and melt found. They work in Chat and the Code tab, with a working folder. Type `/` and the skill's name to run one yourself, or ask and the assistant loads the one that fits. See the `media-skills` page for how skills are offered, and the `skills` page to edit or switch one off.

| Skill | What it's for |
|---|---|
| `cut-video` | raw clips to a finished, rendered video |
| `clean-up-talk` | filler words, false starts and retakes out of talking footage |
| `fix-speech` | applying the transcript viewer's edits in your saved voice |
| `make-sequence` | an idea for a long generated video into a Video sequence job |
| `save-my-voice` | your voice saved from a recording, for the speech tools |

## Finish a video: cut-video

`cut-video` takes an episode from raw clips to a finished video, in order, and stops where you need to decide:

1. It lists the clips, saying which are mixed formats or have no sound, and transcribes them.
2. It makes the cut, then **stops** for you to look. Close the project in Shotcut or Kdenlive before it goes on.
3. It cuts out silences, and lists the retakes it finds in the transcript. It **asks** which to cut, and cuts only those.
4. It writes chapters for a longer video, renders in the background, and checks the render's loudness, length and sound.
5. It writes captions next to the render, and offers moments for a thumbnail.

It never uploads. See the `video-editing`, `video-speech` and `video-render` pages for each step.

## Tighten up talking: clean-up-talk

Ask "take the ums and false starts out of ep012". It works on a project that already has the talking clips on its main track. It reads the transcript for filler ("um", "you know"), false starts, repeated words and retakes, and finds each one's words with their times. Whisper often leaves "um" out of the text, so a long gap in the middle of a sentence is listed as a possible filler.

It shows a numbered list of cuts, with the words either side and the time saved, and **stops** for you to pick: all, none, or by number. Each cut runs from just after the last word kept to just before the next, so no word is cut in half. The picture jumps at each cut; a cutaway in the editor hides it.

## Replace words in your voice: fix-speech

`fix-speech` applies the edits you mark in the transcript viewer: it cuts the struck words, and speaks each retyped phrase in your saved voice, fitted into the gap. **Send to chat** in the viewer starts it. See the `speech-replacement` page.

## Plan a long generated video: make-sequence

Ask "make a two-minute video of a fox through the four seasons". It asks, one at a time, what the brief still needs: the length, the sections, the look, how sections join, clips or pictures to use, music, narration, and anyone speaking. It says roughly how long the run will take, then opens a Video sequence job in the Jobs tab. Nothing runs until you check the models there and press **Run**. See the `video-sequence` page.

It needs a video model in Settings → Video generation as well.

## Save your voice: save-my-voice

Ask "save my voice from ep012/raw/cam.mp4". It transcribes the recording, picks 10–20 s of you speaking in whole sentences with no music, and saves the voice once you confirm it is yours or one you may use. It checks the words the voice was saved with, and with a llama.cpp speech server it speaks a test line in the new voice. With Kokoro it saves the voice and says to switch Settings → Audio → Speech engine. See the `speech` page.

It saves anyone's voice you say you may use, such as a friend who agreed: you confirm that when it asks, and it doesn't check further.

## What they don't do

- They don't upload, and they don't run in jobs or subtasks.
- `clean-up-talk` doesn't change the sound of the words left in.
- `make-sequence` doesn't start the job: you do.

## What has been tested

`cut-video` was run with Qwen3.8-Flash on three clips with a retake. `clean-up-talk`, `make-sequence` and `save-my-voice` are new and have not yet been run with a model.
