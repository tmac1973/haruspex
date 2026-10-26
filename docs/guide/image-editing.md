---
title: Image editing
description: Changing a picture in Chat (one you attached, one the assistant drew, or a file in the working folder), combining pictures, and which image backends and models can do it.
---

# Image editing

The assistant can change a picture instead of drawing a new one: "make it night", "remove the car", "turn it into a watercolour". The original is kept; the edited picture appears in the answer as a new one.

## Edit a picture in Chat

Give the assistant a picture, then say what to change:

- **Attach one**: paste it, drop it on the chat, or use the camera button, then ask in the same or a later message. With several attached, say which ("the second one").
- **One it drew**: ask to change a picture from earlier in the chat.
- **A file**: with a working folder set, name a PNG, JPEG or WebP file in it.

Say what should stay the same if it matters ("keep his face"). An edit takes 10 seconds to a few minutes. The result has the original's shape, at about a megapixel. With a working folder set, ask it to save the result there; an existing file asks you first.

## Combine pictures

Name up to four pictures in one request, such as "put the cat from my second picture on the sofa in the first". How many the model can take depends on it.

## Which backends can edit

Editing needs a model that was made for it:

- **Bundled engine with Qwen-Image 2.1.** It edits once it has its vision weights, 1.2 GB more. A new download includes them; for one made earlier, press **Add editing** under Settings → Image → Bundled engine. Qwen-Image may not be used commercially. Ming-Image can't edit.
- **ComfyUI with Qwen-Image 2.1** (or its Turbo), on ComfyUI 0.39 or later. The files it already uses for drawing are enough. Pictures are uploaded to the server's input folder.
- **llama-toolchest** with a model that edits, such as FLUX.2 klein 4B (Apache 2.0, commercial use allowed). Add it in llama-toolchest; Settings → Image lists it like any other model.

With Lemonade, a ComfyUI model other than Qwen-Image 2.1, or an older ComfyUI, the assistant says it can't edit and what can. Choosing a different model in Settings → Image is up to you.

## What it doesn't do

- It doesn't paint into a region you mark; describe the area in words instead.
- It doesn't make a transparent background or tile.
- A picture pasted into Chat is shrunk to 1024 pixels on its longest side, so edits of it are at most that size.

## What has been tested

Editing with FLUX.2 klein 4B on a llama-toolchest server, and with Qwen-Image 2.1 Turbo on the bundled engine on a 16 GB AMD card (about 30 seconds), has been tested; ComfyUI and the rest are covered by automated tests. See the `images` page for setting up a backend.
