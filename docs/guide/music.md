---
title: Music generation
description: Turning on music generation with llama-toolchest or ace-server, making songs in Chat and the Code tab, changing a song you already have, the test clip, and where songs are kept.
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

If your chat model comes from a toolchest, its address and key are filled in; otherwise enter the **Server address** (for example `http://host:3000`) and pick an **API key** from Settings → Inference → API Keys. Press **Probe**, then choose one of its music instances as the **Model**. **Models on the server** lists them and whether each is running. Starting an instance, or adding a model, happens in llama-toolchest; Haruspex can't start one.

### Set up ace-server

Enter the **Server address** of ace-server itself (for example `http://host:8083`), not a llama-toolchest in front of it. Press **Probe**. **Model** lists the synthesis models the server loaded; **Server default** uses its first. ace-server has no API key, and it makes one song at a time with no queue Haruspex can see, so a second request waits without showing its place.

## Check it works

Under **Songs**, **Make a test clip** makes a 10-second instrumental and plays it. The progress line shows your place in the server's queue (llama-toolchest only), then **Composing** and **Synthesizing**. **Stop** cancels it on the server too.

**Default length** is how long a song is when a request doesn't say: 30 seconds unless you change it, from 5 to 240.

## Make a song in Chat

Ask for one: "a 45-second lo-fi track about rain", or give lyrics. The assistant writes a caption of style tags and, for a song with vocals, the lyrics, then the server makes it. A song takes a minute or more; the step shows your place in the queue, then **Composing** and **Synthesizing**. It plays in the answer, one player at a time, and starting it stops read-aloud. If the assistant forgets to place it, it is added under the answer. Stopping the reply cancels the song on the server.

You can ask for a length (5 to 240 seconds), tempo, key, language, or WAV instead of MP3.

With a working folder set in Chat, the assistant can also save the song there: ask "save it as rain.mp3", when you ask for it or later. If that file exists you're asked before it is replaced. Without a folder it can't save files.

## Change a song you already have

Ask the assistant to work on a song it made in the chat, or an audio file in the working folder (MP3, WAV, FLAC or OGG, up to 10 minutes). The original is kept; the new version plays as a new song.

- **Restyle**: "the same song as smoky jazz". Give the lyrics again to keep the vocals. It can follow the original closely or loosely.
- **Redo a stretch**: "redo 0:30 to 0:45 with a guitar solo".
- **Extend**: "add 30 seconds at the end", or an intro at the start.
- **Add or pull out an instrument**: "add drums", "give me just the vocals", or fill in a band around a part. It knows vocals, backing vocals, drums, bass, guitar, keyboard, percussion, strings, synth, effects, brass and woodwinds.

A new song can also borrow another's sound: "a ballad in the voice of that last song".

Instrument changes need a base or SFT model; a turbo model can only restyle, redo and extend. A llama-toolchest server from before October 2026 can't change songs at all.

## Save a song yourself

The player's **Save as…** button (the arrow) saves the song wherever you choose. On the Remote control page it downloads the file.

## Add music to a project

In the Code tab, ask for something like "background music for the title screen at assets/bgm.mp3". The song plays on the step and is also written into the project; the path is checked before the server starts, and an existing file is kept unless you ask to replace it. A read-only session can make a song but not save it. The Shell assistant doesn't make music.

## Where songs are kept

The server forgets a song after a while (llama-toolchest after a day), so Haruspex downloads each one and keeps its own copy. A song that belongs to a chat or a Code session stays until you delete that chat or session. The test clip belongs to neither and is removed an hour later.

**Audio cache** shows how much space songs use. **Clear unused audio** deletes the ones no chat or session plays; it doesn't touch the rest.

## What it doesn't do

- Only llama-toolchest and ace-server can make music.
- With ace-server, the server's own settings (steps, guidance) are used; Haruspex doesn't change them.
- Players use your system's default audio output, not the device in Settings → Audio.
- A new song can't be longer than 240 seconds; a changed one can be up to 600.
- The assistant can only save into the working folder (Chat) or the project (Code tab); use **Save as…** for anywhere else.
- A short song can come out a little shorter than asked: a 10-second request once gave 7.85 seconds.

## What has been tested

Making songs in the Code tab, saving one into a project, cancelling one, and keeping songs across a restart have been run against a llama-toolchest server with ACE-Step turbo. A 30-second song took about 10 seconds to make. Songs in Chat are covered only by automated tests so far. ace-server directly has been tested with the ACE-Step XL SFT model. Restyling, redoing, extending and adding or pulling out instruments were tested on a llama-toolchest server with ACE-Step XL SFT.
