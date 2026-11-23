---
name: save-my-voice
description: Save a voice — the user's own, or one they may use — from a recording in the working folder, so generate_speech can speak in it — picking a clean stretch from the word times, the consent question, and a test line. Use when the user asks to save, copy or clone a voice, or to make a voice from a recording.
metadata:
  haruspex-needs: video
  haruspex-tools: voice_from_clip
---

# Saving a voice

A saved voice is 5–30 seconds of one person speaking, kept with what they
say. A llama.cpp speech server then speaks new words in that voice. A good
clip matters more than anything else: one voice, no music, no noise, whole
sentences.

## 1. Consent is the user's call

Save the user's own voice, or anyone's they say they may use, such as a
friend who agreed. `voice_from_clip` asks the user to confirm that before
it saves, with a warning; that question is the check. Don't refuse or
question them about whose voice it is, and don't ask for proof.

## 2. Find the recording

Use the file the user named. If none, look in the working folder for
recordings of them talking (a video or a sound file) and ask which one.
If there's nothing, ask them to record a minute of themselves reading
something aloud, in a quiet room, and to put it in the working folder.

## 3. Pick the stretch

Run `transcribe_audio` on the file, with `language` if it isn't English.
From the lines, pick 10–20 s that:

- is one person, talking at their normal pace;
- is whole sentences, starting and ending at a pause;
- has no music, laughing, coughing, or a second voice;
- isn't the first few seconds, where people often sound stiff.

Then run `transcribe_audio` again with `words` for that stretch. Set
`from` to the start of its first word and `to` to the end of its last, so
the clip doesn't cut a word in half.

## 4. Save it

Call `voice_from_clip` with the file, `from`, `to`, and `name` (the user's
name, or what they asked for). The user is asked to confirm; if they don't,
stop there.

The result gives what the clip says, as whisper heard it. Compare it with
the transcript. If it's wrong, tell the user to correct it in Settings →
Audio → Saved voices, since the server uses those words to learn the voice.

## 5. Test it

The voice only speaks when Settings → Audio → Speech engine is a llama.cpp
speech server. Your tools list says "Speech comes from a llama.cpp server"
when it is. If it isn't, tell the user the voice is saved, and that to use
it they set Settings → Audio → Speech engine to **llama.cpp server** with a
server that has a speech model. Stop there.

Otherwise, run `generate_speech` with one or two sentences the user didn't
say in the clip, in the new voice. Put the player in your answer and ask
them to listen. Don't say how it sounds, because you can't hear it.

If they say it doesn't sound like them, pick another stretch (cleaner, or
closer to 20 s) and save it under a new name. Saved voices can be deleted
in Settings → Audio → Saved voices.

## After

Say the voice's name, the file and times it came from, and how to use it:
"say this in my voice", the `narrate` skill, or the `fix-speech` skill on a
transcript's edits.
