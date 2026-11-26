---
title: Spoken audio
description: Hearing answers read aloud, having the assistant speak text into an audio file for a voiceover or a game, the voices and speech engines, saving your own voice, and where the files are kept.
---

# Spoken audio

Haruspex speaks with Kokoro, a voice model that runs on your computer. Nothing you have read aloud or made into speech leaves it, and nothing needs setting up. Speech the assistant makes can instead come from a llama.cpp server, which can speak in a voice you saved.

## Hear an answer read aloud

Click the speaker icon on an answer, or press `F3`. It starts after the first sentence and carries on while the rest is made. Click the icon again, or press `F3`, to stop.

Settings → Audio → **Text-to-speech voice** picks the voice, and **Audio output** picks the speaker. **Read tables by subject** reads a table column by column instead of row by row.

## Make an audio file of speech

Ask in Chat or the Code tab: "read this intro as a voiceover", "say these three lines in a man's voice for my game". The assistant writes the text for the ear, then the `generate_speech` tool speaks it into a WAV file that plays in the answer. A minute of speech takes a few seconds.

- **Voice:** any of the voices in Settings → Audio, or a saved voice with a llama.cpp server. The assistant picks one when you describe it ("a deep male voice"); otherwise it uses yours.
- **Speed:** from half to twice the normal pace. Ask for "slower" or "a bit faster".
- **Length:** up to about 15 minutes in one file (12,000 characters). For longer, ask for it in parts.
- **Save it:** with a working folder in Chat, or in the Code tab, ask for it to be saved ("save it as audio/intro.wav"). In Chat you are asked before a file is replaced. `save_generated` saves one made earlier.

## Use a llama.cpp speech server

Settings → Audio → **Speech engine** → **llama.cpp server** sends the speech audio files the assistant makes, and video narration, to a llama-server v0.8.0 or newer that serves `/tts`, or to llama-toolchest. Give its address and key, press **Probe**, and pick the speech model. On llama-toolchest, Download Models → **Get speech models** has Qwen3-TTS 1.7B Base, which copies a saved voice. Reading answers aloud (`F3`, the speaker icon) stays on Kokoro.

Each request makes a new take: ask again, or with another seed, for a different one. The same seed does not give the same take again, so keep one you like. The server can't change pace itself, so a slower or faster take is stretched afterwards with the pitch kept.

## Save your own voice

Only use your own voice, or a voice you have clear permission to use. Copying someone's voice without their consent is not allowed, can be illegal, and has led to lawsuits.

- **From a file:** Settings → Audio → Saved voices → **Add from file…**, name it, tick the box, and press **Add**. **Add** stays off until the box is ticked.
- **From your footage:** ask "save my voice from ep012/raw/cam.mp4", or run `/save-my-voice`. The assistant picks 10–20 s of you speaking with no music, from the transcript's word times, and asks you to confirm it is your voice first.

A clean 5–10 s of one person speaking is enough; clips under 5 s or over 30 s are refused. Haruspex transcribes what the clip says, and Settings → Audio shows the words: correcting them copies the voice more closely. Then ask "say 'this is a test' in my voice". Saved voices stay on this computer in the app's data folder; **Delete** removes one.

## Have it write and record: the narrate skill

The `narrate` skill can load by itself the first time the assistant makes speech, or type `/narrate` and what you want. It:

- writes the script for listening (short sentences, numbers as they are said, no lists), shows it with the voice it picked, and **stops** for your OK. Give the exact words ("read this: …") to skip that;
- keeps one voice for each character, and makes game lines one file each, named for what the code calls them and saved where it loads sounds;
- for a set length ("a 30-second voiceover"), measures what it made and records it again faster or slower to fit;
- with a llama.cpp server, speaks in the saved voice you name ("in my voice"), and for another take records again with a new seed into a second file, keeping both for you to pick;
- saves a voiceover next to the video, and with the video tools on puts it under the picture in the Shotcut or Kdenlive project at the time you say (see the `video-cut` page).

See the `media-skills` page for how skills are offered, and the `video-skills` page for `save-my-voice`.

## Where the files are kept

Spoken audio goes in the audio cache with songs. A file that belongs to a chat or a Code session stays until you delete that chat or session. Settings → Music generation → **Audio cache** shows the space used, and **Clear unused audio** deletes what nothing plays.

## What it doesn't do

- Only WAV files. Convert to MP3 yourself if you need one.
- One voice per file: each character's lines are made separately.
- Most voices are American English. Text in other languages is read with English sounds.
- No copying a voice without its owner's consent: Haruspex saves a voice only after you confirm it is yours or you may use it.
- Kokoro can't speak in a saved voice; only a llama.cpp server can.
- Not in the Shell tab, in subtasks, or in jobs.
