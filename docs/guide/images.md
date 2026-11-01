---
title: Image generation
description: Adding image models (ComfyUI, the bundled engine, Lemonade or llama-toolchest) and the order they are used in, the models' licences, drawing in Chat, art for a project, and GPU cost.
---

# Image generation

Haruspex can draw pictures with diffusion models. It is off by default: nothing is downloaded or started until you add a model in Settings → Image.

This page is about drawing new pictures. To change one, see the `image-editing` page; for web photos in answers, the `chat` page.

## Add image models

In Settings → Image, press **Add model**, then choose its **Backend**:

- **ComfyUI** — a [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server you run, here or elsewhere.
- **Bundled engine** — stable-diffusion.cpp, shipped with Haruspex, on Linux, Windows and Apple Silicon Macs.
- **Lemonade** — a [Lemonade](https://lemonade-server.ai) server you run, with the bundled engine's models.
- **llama-toolchest** — a llama-toolchest server you run with generation on.

Each model says what it can do. The image tools use the first in the list that can do the job: an editing one for an edit, one with transparency if you ask. Use ↑ and ↓ to change the order. A model that doesn't answer is skipped. To use a certain one, name it ("draw it with klein"). Click a model to change it; **Generate a test image** checks it works.

Every model's **API key** is a named key from Settings → Inference → API Keys; a ComfyUI or Lemonade key set before was moved there. A server you probe is kept under **Saved servers**; a llama-toolchest is listed in Settings → Music and Video too.

### Set up the bundled engine

Under **Bundled engine**, press **Download** on a model (about 17 GB for Ming-Image, 10 GB for Qwen-Image Turbo), then **Use**. Each model lists what it can do. The engine starts when something needs it or on **Start**, and stops on **Stop**, on removing it, or on quitting. Two bundled-engine models take turns.

### Set up ComfyUI

Enter the **Server address** (`http://127.0.0.1:8188`), pick an **API key** if your server needs one, and press **Probe**. **Models on the server** shows what each model lacks. **Install** downloads the files into ComfyUI when it runs on this computer, or queues them with ComfyUI-Manager elsewhere. Without either, **Copy file list** gives you the files to place by hand. Then choose the **Model**.

The first picture after ComfyUI starts waits for the model to load.

### Set up Lemonade

Enter the **Server address** (`http://127.0.0.1:13305`), pick an **API key** if needed, and press **Probe**. Under **Models on the server**, **Install** downloads a model onto the server and **Remove** deletes it. Then choose the **Model**. The download continues if you close Settings. It does not make tiling textures.

### Set up llama-toolchest

If your chat model comes from a toolchest, its address and key are filled in; otherwise enter the **Server address** and pick an **API key**. Choose one of its image instances as the **Model**; a stopped one starts when used. It does not make tiling textures.

## Pick a model and check its licence

| Model                                 | Licence               | Commercial use  | Bundled engine needs        |
| ------------------------------------- | --------------------- | --------------- | --------------------------- |
| Ming-Image 0.1 Design (default)       | MIT                   | Allowed         | ~8 GB VRAM, ~10 GB free RAM |
| Qwen-Image 2.1 Turbo                  | Qwen Research License | **Not allowed** | ~12 GB VRAM                 |
| FLUX.2 klein 4B, Qwen-Image-Edit-2511 | Apache 2.0            | Allowed         | ComfyUI only                |

Settings → Image marks Qwen-Image as not licensed for commercial use and asks before downloading it. When one draws, the assistant is told. Some stores require AI-made content to be disclosed.

## Draw a picture in Chat

Ask Chat to draw something. It takes 30 seconds to a few minutes, or ask for it in the background (see the `image-editing` page). It appears in the answer and is kept with the conversation; click it for full size, or hover for **Save as…**. Ask for another shape or a transparent background. With a working folder set, it can save it there, asking before replacing a file.

## Make art for a project

In the Code tab, or the Shell assistant with Full access, ask for something like "a 32 px coin sprite in assets/". The assistant writes a finished sprite, icon, tiling texture or plain picture into your project as a PNG at the size you ask for: transparent background, cropped and reduced to a palette. Point it at an existing asset to match its colours. It won't overwrite a file unless you ask. See the `code` and `shell` pages.

A tiling texture, such as "a 32 px gravel floor tile", or the edge tiles where two textures meet, is drawn by code, not by the image model, and works without a backend; see the `textures` page. For a painted or photographic material that must tile, such as one for a 3D model, ask for a tiling picture instead. If no model in Settings → Image can tile, the picture is still written, and the assistant says so.

## Make a whole set of game art

The **Asset generation** job draws all of a project's sprites, icons and tiling textures in one style, checks each one, retries failures and writes a report. A texture it draws in code that the check rejects is redrawn up to twice, then kept and marked for **Review assets**. Guided planning can hand off to it. See the `jobs` page.

## What it costs your computer

The bundled engine holds most of a 16 GB card, so your chat model and games may not fit. Stop it in Settings → Image when done.

## What has been tested

The asset job has been run end to end on Linux with an AMD GPU; drawing in Chat and project art only by automated tests, which pass on macOS and Windows too. If something fails, see the `troubleshooting` page.
