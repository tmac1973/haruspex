---
title: Spoken audio
description: Hearing answers read aloud, having the assistant speak text into an audio file for a voiceover or a game, the voices, and where the files are kept.
---

# Spoken audio

Haruspex speaks with Kokoro, a voice model that runs on your computer. Nothing you have read aloud or made into speech leaves it, and nothing needs setting up.

## Hear an answer read aloud

Click the speaker icon on an answer, or press `F3`. It starts after the first sentence and carries on while the rest is made. Click the icon again, or press `F3`, to stop.

Settings → Audio → **Text-to-speech voice** picks the voice, and **Audio output** picks the speaker. **Read tables by subject** reads a table column by column instead of row by row.

## Make an audio file of speech

Ask in Chat or the Code tab: "read this intro as a voiceover", "say these three lines in a man's voice for my game". The assistant writes the text for the ear, then the `generate_speech` tool speaks it into a WAV file that plays in the answer. A minute of speech takes a few seconds.

- **Voice:** any of the voices in Settings → Audio. The assistant picks one when you describe it ("a deep male voice"); otherwise it uses yours.
- **Speed:** from half to twice the normal pace. Ask for "slower" or "a bit faster".
- **Length:** up to about 15 minutes in one file (12,000 characters). For longer, ask for it in parts.
- **Save it:** with a working folder in Chat, or in the Code tab, ask for it to be saved ("save it as audio/intro.wav"). In Chat you are asked before a file is replaced. `save_generated` saves one made earlier.

To hear a draft first, ask for the script before the audio: changing the text and making it again is quick.

## Where the files are kept

Spoken audio goes in the audio cache with songs. A file that belongs to a chat or a Code session stays until you delete that chat or session. Settings → Music → **Audio cache** shows the space used, and **Clear unused audio** deletes what nothing plays.

## What it doesn't do

- Only WAV files. Convert to MP3 yourself if you need one.
- One voice per file. Ask for each character's lines separately.
- Most voices are American English. Text in other languages is read with English sounds.
- No copying a real person's voice.
- Not in the Shell tab, in subtasks, or in jobs.
