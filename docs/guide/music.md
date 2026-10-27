---
title: Music generation
description: Turning on music generation with llama-toolchest or ace-server, making songs in Chat and the Code tab or in the background, changing a song, the test clip, and where songs are kept.
---

# Music generation

Haruspex can have a server make songs with ACE-Step. It is off by default: nothing happens until you pick a backend in Settings → Music.

## Turn it on

Open Settings → Music → **Music backend** and choose a **Backend**:

- **None** — the default.
- **llama-toolchest** — a llama-toolchest server you run with generation on and an ACE-Step model added.
- **ace-server** — acestep.cpp's own server, which you run yourself.

While it is off, Settings → Music says so if the llama-toolchest your chat model comes from has music models.

### Set up llama-toolchest

If your chat model comes from a toolchest, its address and key are filled in; otherwise enter the **Server address** (`http://host:3000`) and pick an **API key** from Settings → Inference → API Keys. Press **Probe**, then choose one of its music instances as the **Model**. **Instances on the server** lists its enabled instances; Haruspex uses one only while it runs. Starting an instance, or adding a model, happens in llama-toolchest; Haruspex can't start one.

### Set up ace-server

Enter the **Server address** of ace-server itself (`http://host:8083`), not a llama-toolchest in front of it. Press **Probe**. **Model** lists the synthesis models the server loaded; **Server default** uses its first. ace-server has no API key and makes one song at a time; a second request waits without showing its place.

## Check it works

Under **Songs**, **Make a test clip** makes a 10-second instrumental and plays it. The progress line shows your place in the server's queue (llama-toolchest only), then **Composing** and **Synthesizing**. **Stop** cancels it on the server too.

**Default length** is how long a song is when a request doesn't say: 30 seconds unless you change it, from 5 to 240.

## Make a song in Chat

Ask for one: "a 45-second lo-fi track about rain", or give lyrics. The assistant writes style tags and, for vocals, the lyrics. The step shows its progress. It plays in the answer, one player at a time, and starting it stops read-aloud. If the assistant forgets to place it, it is added under the answer. Stopping the reply cancels the song on the server.

You can ask for a length (5 to 240 seconds), tempo, key, time signature, language, or WAV instead of MP3. Each song's seed is noted, so "the same, but faster" keeps the rest.

With a working folder set in Chat, the assistant can also save the song there: ask "save it as rain.mp3", when you ask for it or later. If that file exists you're asked before it is replaced. Without a folder it can't save files.

## Make songs in the background

Ask for a song "in the background" (or several) and the assistant starts it and carries on, so you can keep chatting. Each gets a card with progress and **Cancel**, then a player, and is in the **Tasks** list (see the `chat-conversations` page); the assistant places it in the conversation. If Haruspex closes first, it is picked up when it reopens, as long as the server still has it.

## Change a song you already have

Ask the assistant to work on a song it made in the chat, or an audio file in the working folder (MP3, WAV, FLAC or OGG, up to 10 minutes). The original is kept; the new version plays as a new song.

- **Restyle**: "the same song as smoky jazz". Give the lyrics again to keep the vocals. It can follow the original closely or loosely.
- **Redo a stretch**: "redo 0:30 to 0:45 with a guitar solo".
- **Extend**: "add 30 seconds at the end", or an intro at the start.
- **Add or pull out an instrument**: "add drums", "give me just the vocals", or fill in a band around a part. It knows vocals, backing vocals, drums, bass, guitar, keyboard, percussion, strings, synth, effects, brass and woodwinds.

A new song can also borrow another's sound: "a ballad in the voice of that last song".

Instrument changes need a base model, such as ACE-Step 1.5 XL base; turbo and SFT models can only restyle, redo and extend. A llama-toolchest server from before October 2026 can't change songs at all.

## Save a song yourself

The player's **Save as…** button (the arrow) saves the song wherever you choose. On the Remote control page it downloads the file.

## Add music to a project

In the Code tab, ask for something like "background music for the title screen at assets/bgm.mp3". The song plays on the step and is also written into the project; the path is checked before the server starts, and an existing file is kept unless you ask to replace it. A read-only session can make a song but not save it. The Shell assistant doesn't make music.

## Where songs are kept

Haruspex downloads each song and keeps its own copy, then deletes it from llama-toolchest, which would otherwise keep it for a day. A song that belongs to a chat or a Code session stays until you delete that chat or session. The test clip belongs to neither and is removed an hour later.

**Audio cache** shows how much space songs use. **Clear unused audio** deletes the ones no chat or session plays; it doesn't touch the rest.

## What it doesn't do

- Only llama-toolchest and ace-server can make music.
- With ace-server, the server's own settings (steps, guidance) are used; Haruspex doesn't change them.
- Players use your system's default audio output, not the device in Settings → Audio.
- A new song can't be longer than 240 seconds; a changed one can be up to 600.
- A short song can come out a little shorter than asked.

## What has been tested

On llama-toolchest with ACE-Step turbo: songs in the Code tab, saving into a project, cancelling, and keeping songs across a restart (a 30-second song took about 10 seconds). ace-server with XL SFT. Changing songs in Chat on llama-toolchest: extending and restyling with XL SFT, instruments with XL base.
