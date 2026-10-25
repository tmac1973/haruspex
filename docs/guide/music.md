---
title: Music generation
description: Turning on music generation with a llama-toolchest server, making songs in Chat and the Code tab, the test clip, and where songs are kept.
---

# Music generation

Haruspex can have a server make songs with ACE-Step. It is off by default: nothing happens until you pick a backend in Settings → Music.

## Turn it on

Open Settings → Music → **Music backend** and choose a **Backend**:

- **None** — the default.
- **llama-toolchest** — a llama-toolchest server you run with generation on and an ACE-Step model added.

While it is off, Settings → Music says so if the llama-toolchest your chat model comes from has music models.

### Set up llama-toolchest

If your chat model comes from a toolchest, its address and key are filled in; otherwise enter the **Server address** (for example `http://host:3000`) and pick an **API key** from Settings → Inference → API Keys. Press **Probe**, then choose one of its music instances as the **Model**. **Models on the server** lists them and whether each is running. Starting an instance, or adding a model, happens in llama-toolchest; Haruspex can't start one.

## Check it works

Under **Songs**, **Make a test clip** makes a 10-second instrumental and plays it. The progress line shows your place in the server's queue, then **Composing** and **Synthesizing**. **Stop** cancels it on the server too.

**Default length** is how long a song is when a request doesn't say: 30 seconds unless you change it, from 5 to 240.

## Make a song in Chat

Ask for one: "a 45-second lo-fi track about rain", or give lyrics. The assistant writes a caption of style tags and, for a song with vocals, the lyrics, then the server makes it. A song takes a minute or more; the step shows your place in the queue, then **Composing** and **Synthesizing**. It plays in the answer, one player at a time, and starting it stops read-aloud. If the assistant forgets to place it, it is added under the answer. Stopping the reply cancels the song on the server.

You can ask for a length (5 to 240 seconds), tempo, key, language, or WAV instead of MP3.

## Add music to a project

In the Code tab, ask for something like "background music for the title screen at assets/bgm.mp3". The song plays on the step and is also written into the project; the path is checked before the server starts, and an existing file is kept unless you ask to replace it. A read-only session can make a song but not save it. The Shell assistant doesn't make music.

## Where songs are kept

llama-toolchest deletes a song a day after making it, so Haruspex downloads each one and keeps its own copy. A song that belongs to a chat or a Code session stays until you delete that chat or session. The test clip belongs to neither and is removed an hour later.

**Audio cache** shows how much space songs use. **Clear unused audio** deletes the ones no chat or session plays; it doesn't touch the rest.

## What it doesn't do

- Only llama-toolchest can make music.
- Players use your system's default audio output, not the device in Settings → Audio.
- A song can't be longer than 240 seconds.
