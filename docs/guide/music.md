---
title: Music generation
description: Turning on music generation with a llama-toolchest server, picking an ACE-Step model, the test clip, and where songs are kept.
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

## Where songs are kept

llama-toolchest deletes a song a day after making it, so Haruspex downloads each one and keeps its own copy. A song that belongs to a chat or a Code session stays until you delete that chat or session. The test clip belongs to neither and is removed an hour later.

**Audio cache** shows how much space songs use. **Clear unused audio** deletes the ones no chat or session plays; it doesn't touch the rest.

## What it doesn't do

- Only llama-toolchest can make music.
- Players use your system's default audio output, not the device in Settings → Audio.
- A song can't be longer than 240 seconds.
- A short song can come out a little shorter than asked: a 10-second request once gave 7.85 seconds.

## What has been tested

Making songs in the Code tab, saving one into a project, cancelling one, and keeping songs across a restart have been run against a llama-toolchest server with ACE-Step turbo. A 30-second song took about 10 seconds to make. Songs in Chat are covered only by automated tests so far.
