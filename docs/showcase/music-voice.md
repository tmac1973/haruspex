---
title: Music & voice
description: Make and change songs, hear answers read aloud, record voiceovers, save your own voice, and talk to the assistant instead of typing.
---

## Make a song

Ask for a song with a length, mood or your own lyrics. The assistant writes the style tags and lyrics, and the song plays in the answer.

Tab: Chat
Required settings: Settings → Music → Music backend (a llama-toolchest or ace-server you run)

Prompt:

> A 45-second lo-fi track about rain on a tin roof.

Example output:

The assistant says what it made: style tags such as "lo-fi, mellow, piano, soft drums, slow", the lyrics with `[verse]` and `[chorus]` tags, the length and the seed. A player appears in the answer.

<!-- media: Chat answer with style tags, lyrics and the song player -->

Read more: music, media-skills

## Change a song

Restyle, redo a stretch, extend, trim, or add or pull out an instrument. Works on a song it made, or an audio file you drop on the message box.

Tab: Chat or Code
Required settings: Settings → Music → Music backend; a base model such as ACE-Step 1.5 XL base for instrument changes

Prompt:

> Redo 0:30 to 0:45 with a guitar solo, then add 30 seconds at the end.

Example output:

The original is kept, and the new version plays as a new song in the answer.

<!-- media: two song players, the original and the changed version -->

Read more: music, media-skills

## Make music for a game

Ask for a loop and the assistant saves it where your code loads its music.

Tab: Code
Required settings: Settings → Music → Music backend

Prompt:

> Background music for the title screen at assets/bgm.mp3, an instrumental loop.

Example output:

The song plays on the step and is written to `assets/bgm.mp3`: an instrumental loop with no intro or outro. An existing file is kept unless you ask to replace it.

<!-- media: Code tab step with the song player and the saved file path -->

Read more: music, media-skills

## Hear an answer read aloud

Click the speaker icon on an answer, or press `F3`. It runs on your computer and starts after the first sentence.

Tab: Chat
Required settings: None

Prompt:

> Explain how a heat pump works, in a few paragraphs.

Example output:

Press `F3` and the answer is read aloud in the voice from Settings → Audio → Text-to-speech voice. Press `F3` again to stop.

<!-- media: answer with the speaker icon active while it is read aloud -->

Read more: speech

## Make a voiceover

The assistant writes the text for the ear, shows it with the voice it picked, and waits for your OK before recording a WAV file.

Tab: Chat or Code
Required settings: None

Prompt:

> /narrate a 30-second voiceover for my bakery's opening video, warm female voice

Example output:

The script appears first, in short sentences, with the chosen voice. After your OK the WAV plays in the answer; for a set length it is measured and recorded again faster or slower to fit.

<!-- media: narrate skill showing the script, then the WAV player -->

Read more: speech, media-skills

## Save your own voice and use it

Save a clean 5–30 s clip of yourself, then ask for speech in your voice. Only use your own voice, or one you have clear permission to use.

Tab: Chat or Code
Required settings: Settings → Audio → Speech engine → llama.cpp server; Settings → Audio → Saved voices

Prompt:

> Save my voice from ep012/raw/cam.mp4, then say "welcome back to the workshop" in my voice.

Example output:

The assistant picks 10–20 s of you speaking with no music and asks you to confirm it is your voice. Once saved, it speaks the line in that voice into a WAV that plays in the answer.

<!-- media: confirmation prompt for the saved voice, then the test line player -->

Read more: speech, video-skills

## Talk instead of typing

Hold the microphone button, or hold `F2`, and speak. Let go and what you said is sent. It runs on your computer.

Tab: Chat, Code or Shell
Required settings: None

Prompt:

> What's a good name for a grey cat?

Example output:

The words you said are sent as a message, and the assistant answers as if you had typed them.

<!-- media: holding the microphone button, then the transcribed message in Chat -->

Read more: voice

## Dictate a long message

Turn on constant listening with `Shift + F2`. Each phrase is added to the chat box when you pause; say "send it" to send, or "delete that" to remove the last phrase.

Tab: Chat, Code or Shell
Required settings: None

Prompt:

> Let's plan the garden for next spring… we want tomatoes along the fence… delete that… beans along the fence and tomatoes by the shed… send it

Example output:

The box fills a phrase at a time: "delete that" removes the phrase about tomatoes, and "send it" sends the rest, leaving the words "send it" out. Listening carries on for the next message.

<!-- media: chat box filling during constant listening, with the glowing microphone ring -->

Read more: voice
