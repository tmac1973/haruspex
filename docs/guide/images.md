---
title: Image generation
description: Turning on image generation, ComfyUI, the bundled engine, Lemonade or llama-toolchest, the models and their licences, drawing in Chat, art for a project, and GPU cost.
---

# Image generation

Haruspex can draw pictures with a diffusion model. It is off by default: nothing is downloaded or started until you pick a backend in Settings → Image.

This page is about drawing new pictures. To change one, see the `image-editing` page; for web photos in answers, the `chat` page.

## Turn it on

Open Settings → Image → **Image backend** and choose a **Backend**:

- **None** — the default. No process and no download.
- **ComfyUI** — a [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server you run, on this computer or another.
- **Bundled engine** — stable-diffusion.cpp, shipped with Haruspex. Nothing else to install. It is offered on Linux, Windows and Apple Silicon Macs.
- **Lemonade** — a [Lemonade](https://lemonade-server.ai) server you run, which draws with the bundled engine's models.
- **llama-toolchest** — a llama-toolchest server you run with generation on.

**Test generation → Generate a test image** checks that a backend works.

### Set up the bundled engine

Under **Bundled engine**, press **Download** on a model (about 17 GB for Ming-Image, 10 GB for Qwen-Image Turbo), then **Use**. The engine starts when something needs it or on **Start**, and stops on **Stop**, a backend switch, or quitting.

### Set up ComfyUI

Under **Connection**, enter the **Server address** (for example `http://127.0.0.1:8188`) and an **API key** only if your server needs one, then press **Probe**. **Models on the server** shows what each model lacks. **Install** downloads the files into ComfyUI when it runs on this computer, or queues them with ComfyUI-Manager elsewhere. Without either, **Copy file list** gives you the files to place by hand. Then choose the **Model**.

The first picture after ComfyUI starts waits for the model to load (**Loading the model**).

### Set up Lemonade

Under **Connection**, enter the **Server address** (for example `http://127.0.0.1:13305`) and an **API key** only if your server needs one, then press **Probe**. Under **Models on the server**, **Install** downloads a model onto the server and **Remove** deletes it. Then choose the **Model**. The download continues if you close Settings. Lemonade keeps one image model loaded, so the first picture after switching waits for it to load. It does not make tiling textures.

### Set up llama-toolchest

If your chat model comes from a toolchest, its address and key are filled in; otherwise enter the **Server address** and an **API key** from Settings → Inference → API Keys. Choose one of its image instances as the **Model**; you start instances in llama-toolchest. It does not make tiling textures.

## Pick a model and check its licence

| Model                           | Licence               | Commercial use  | Bundled engine needs        |
| ------------------------------- | --------------------- | --------------- | --------------------------- |
| Ming-Image 0.1 Design (default) | MIT                   | Allowed         | ~8 GB VRAM, ~10 GB free RAM |
| Qwen-Image 2.1 Turbo            | Qwen Research License | **Not allowed** | ~12 GB VRAM                 |
| FLUX.2 klein 4B (ComfyUI only)  | Apache 2.0            | Allowed         | —                           |

An earlier Qwen-Image 2.1 download is offered again as Turbo, three times faster; ComfyUI keeps running the original.

Settings → Image marks Qwen-Image "Not licensed for commercial use." and asks before downloading or installing it. When a non-commercial model is in use, the assistant is told, so it can tell you. Some stores require AI-made content to be disclosed.

## Draw a picture in Chat

Ask Chat to draw, paint or illustrate something. A picture takes 30 seconds to a few minutes. It appears in the answer and is kept with the conversation; click it for full size and **Save as…**. If the model forgets to place it, it is shown under the answer. Ask for any shape, or a transparent background. With a working folder set, it can save the picture there; an existing file asks you first. A model that sees images is shown it.

## Make art for a project

In the Code tab, or the Shell assistant with Full access, ask for something like "a 32 px coin sprite in assets/". The assistant writes a finished sprite, icon, tiling texture or plain picture into your project as a PNG at the size you ask for: transparent background, cropped and reduced to a palette. Point it at an existing asset to match its colours. It won't overwrite a file unless you ask. See the `code` and `shell` pages.

A tiling texture, such as "a 32 px gravel floor tile", or the edge tiles where two textures meet, is drawn by code, not by the image model, and works without a backend; see the `textures` page. For a painted or photographic material that must tile, such as one for a 3D model, ask for a tiling picture instead. If the backend in Settings → Image can't tile, the picture is still written, and the assistant says it won't tile.

## Make a whole set of game art

The **Asset generation** job draws all of a project's sprites, icons and tiling textures in one style, checks each one, retries failures and writes a report. A texture it draws in code that the check rejects is redrawn up to twice, then kept and marked for **Review assets**. Guided planning can hand off to it. See the `jobs` page.

## What it costs your computer

Image generation uses your GPU heavily. The bundled engine holds most of a 16 GB card, so your chat model and games may slow or not fit. Stop it in Settings → Image when done.

## What has been tested

The asset job has been run end to end on Linux with an AMD GPU; drawing in Chat and art for a project only by automated tests, which also pass on macOS and Windows. If something fails, see the `troubleshooting` page.
