---
title: Image editing
description: Changing a picture in Chat (attached, drawn earlier, or a file), or only part of it, extending it, combining pictures, upscaling, and which image backends and models can do each.
---

# Image editing

The assistant can change a picture instead of drawing a new one: "make it night", "remove the car", "turn it into a watercolour". The original is kept; the edited picture appears in the answer as a new one.

## Edit a picture in Chat

Give the assistant a picture, then say what to change:

- **Attach one**: paste it, drop it on the chat, or use the camera button, then ask in the same or a later message. With several attached, say which ("the second one").
- **One it drew**: ask to change a picture from earlier in the chat.
- **A file**: with a working folder set, name a PNG, JPEG or WebP file in it.

Say what should stay the same if it matters ("keep his face"). An edit takes 10 seconds to a few minutes. The result has the original's shape, at about a megapixel. With a working folder set, ask it to save the result there; an existing file asks you first.

## Change only part of a picture

Say which part: "change only the sky", "just the left half". The assistant marks that part of the picture and the edit changes nothing outside it, on every backend; the edge is blended so the join doesn't show. The result keeps the original's full size.

## Extend a picture past its edges

Ask for it wider or taller: "extend it by half on the right, continuing the road". The picture is kept, apart from a narrow blend where it meets the new part, which is painted to continue it, on the bundled engine or ComfyUI with any of their models. Say what the scene's light is like if it matters; a faint seam can still show in an even sky. Lemonade and llama-toolchest can't extend.

## Combine pictures

Name up to four pictures in one request, such as "put the cat from my second picture on the sofa in the first". How many the model can take depends on it.

## Which backends can edit

Settings → Image says what Haruspex can do with the chosen model (draw, edit, upscale, transparent backgrounds, tiling textures); hover over that line for how to get the rest. Editing needs a model that was made for it:

- **Bundled engine with Qwen-Image 2.1.** It edits once it has its vision weights, 1.2 GB more. A new download includes them; for one made earlier, press **Add editing** under Settings → Image → Bundled engine. Qwen-Image may not be used commercially. Ming-Image can't edit.
- **ComfyUI with Qwen-Image 2.1** (or its Turbo), on ComfyUI 0.39 or later, **FLUX.2 klein 4B** (12.4 GB) **or Qwen-Image-Edit-2511** (31 GB, about 24 GB of VRAM). Both are Apache 2.0, commercial use allowed; **Install** them under **Models on the server**. The files a model draws with are enough. Pictures are uploaded to the server's input folder.
- **Lemonade with Qwen-Image 2.1.** Installing it from Settings → Image now includes the vision weights; for one installed earlier, press **Add editing** under **Models on the server**. Haruspex also installs Lemonade's image engine the first time, if the server has none.
- **llama-toolchest** with a model that edits, such as FLUX.2 klein 4B (Apache 2.0, commercial use allowed). Add it in llama-toolchest; Settings → Image lists it like any other model.

With Ming-Image, another ComfyUI model, or an older ComfyUI, the assistant says it can't edit and what can. Lemonade's own edit models, such as its FLUX.2 klein, can't be chosen in Haruspex yet. Choosing a different model in Settings → Image is up to you.

## Make a picture larger

Ask the assistant to upscale a picture, two or four times: "make it four times bigger for printing". It sharpens as it enlarges, and a transparent background stays transparent. The result is at most 4096 pixels on its longest side, so pictures up to 2048 pixels can be upscaled. A 1024-pixel picture takes about 12 seconds.

This needs Real-ESRGAN (BSD 3-Clause), on the bundled engine, ComfyUI or Lemonade: press **Download** under Settings → Image → Bundled engine → **Upscaler** (67 MB), or **Install** on the **Upscaler** under **Models on the server** for ComfyUI (67 MB, into `models/upscale_models`; a ComfyUI on another machine may give you the file to copy instead) or Lemonade (62 MB). It works with whichever model is chosen.

## What it doesn't do

- You can't mark a region by hand; name the part in words.
- An edit doesn't make a transparent background or tile.
- llama-toolchest doesn't upscale yet.
- A picture pasted into Chat is shrunk to 1024 pixels on its longest side, so edits of it are at most that size.

## What has been tested

Editing with FLUX.2 klein 4B on a llama-toolchest server, and with Qwen-Image 2.1 Turbo on the bundled engine on a 16 GB AMD card (about 30 seconds), on ComfyUI 0.39 and on Lemonade (about 20 seconds), and with FLUX.2 klein 4B (about 5 seconds) and Qwen-Image-Edit-2511 (about 45 seconds) on ComfyUI, has been tested, as has changing only part of a picture on Lemonade, and extending one on the bundled engine and on ComfyUI with FLUX.2 klein (about 10 seconds), as has upscaling on the bundled engine, ComfyUI 0.39 and Lemonade. See the `images` page for setting up a backend.
