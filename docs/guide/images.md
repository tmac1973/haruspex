---
title: Image generation
description: Turning on image generation, ComfyUI or the bundled engine, the models and their licences, drawing in Chat, art for a project, and GPU cost.
---

# Image generation

Haruspex can draw pictures with a diffusion model on your own machine. It is off by default: nothing is downloaded or started until you pick a backend in Settings → Image.

This page is about drawing new pictures. For photos found on the web inside answers, see the `chat` page.

## Turn it on

Open Settings → Image → **Image backend** and choose a **Backend**:

- **None** — the default. No process and no download.
- **ComfyUI** — a [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server you run, on this computer or another. Choose this if you already use ComfyUI.
- **Bundled engine** — stable-diffusion.cpp, shipped with Haruspex. Nothing else to install. It is offered on Linux, Windows and Apple Silicon Macs.

Once a backend is set up, **Test generation → Generate a test image** makes one picture to check it works.

### Set up the bundled engine

Under **Bundled engine**, press **Download** on a model, then **Use**. Downloads are large (about 17 GB for Ming-Image, 10 GB for Qwen-Image). The engine starts when something needs it, or when you press **Start**, and stops when you press **Stop**, switch backend, or quit.

### Set up ComfyUI

Under **Connection**, enter the **Server address** (for example `http://127.0.0.1:8188`) and an **API key** only if your server needs one, then press **Probe**. **Models on the server** then shows what each model is missing. **Install** downloads the files into ComfyUI when it runs on this computer, or queues them with ComfyUI-Manager on another server. Without either, **Copy file list** gives you the files to place by hand. Then choose the **Model**.

The first picture after ComfyUI starts is slow: it loads the model from disk, which can take a minute or more. The progress line says **Loading the model** with a running clock while it does, then counts the drawing steps. Later pictures skip the load.

## Pick a model and check its licence

| Model | Licence | Commercial use | Bundled engine needs |
|---|---|---|---|
| Ming-Image 0.1 Design (default) | MIT | Allowed | ~8 GB VRAM, ~10 GB free RAM |
| Qwen-Image 2.1 | Qwen Research License | **Not allowed** | ~12 GB VRAM |

Settings → Image marks Qwen-Image "Not licensed for commercial use." and asks before downloading or installing it. When a non-commercial model is in use, the assistant is told, so it can tell you. Generated images are generally not copyrightable on their own, and some stores require AI-made content to be disclosed.

## Draw a picture in Chat

With a backend set up, ask Chat to draw, paint or illustrate something. A picture takes from about 30 seconds to a few minutes. It appears in the answer and is kept with the conversation. If the model forgets to place it, it is shown under the answer. You can ask for a shape other than square, or a transparent background for an object on its own.

## Make art for a project

In the Code tab, or the Shell assistant with Full access, ask for something like "a 32 px coin sprite in assets/". The assistant writes a finished sprite, icon, tiling texture or plain picture into your project as a PNG at the size you ask for: transparent background, cropped and reduced to a palette. Point it at an existing asset to match its colours. It does not overwrite a file unless you ask. See the `code` and `shell` pages.

## Make a whole set of game art

The **Asset generation** job draws all of a project's sprites, icons and tiling textures in one style, checks each one, retries failures and writes a report. Guided planning can hand off to it. See the `jobs` page.

## What it costs your computer

Image generation uses your GPU heavily. While it runs, the bundled engine holds most of a 16 GB card, and other GPU work — including your chat model and games — will slow down or may not fit. Stop the engine in Settings → Image when you are done.

## What has been tested

Image generation is new. The asset job has been run end to end on Linux with an AMD GPU. Drawing in Chat and art for a project are newer and so far covered only by automated tests. It builds and passes its tests on macOS and Windows, but nobody has generated images there yet. If something fails, see the `troubleshooting` page.
