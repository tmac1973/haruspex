---
title: Video upscaling
description: Making a clip two or four times larger and sharper with a video upscaler on llama-toolchest (RelayVSR or SeedVR2), which clips it takes, sound, and what it doesn't do.
---

# Video upscaling

Haruspex can make a short clip two or four times larger and sharper. It uses a video upscaler on a llama-toolchest server: a RelayVSR or SeedVR2 instance. These look at several frames at once, so the result doesn't flicker the way a picture upscaler run on each frame would.

Only llama-toolchest has video upscalers. To make a picture larger, see the `image-editing` page.

## Set it up

1. In llama-toolchest, add a video upscaler set (RelayVSR ×2, RelayVSR ×4 or SeedVR2) and measure it at the largest clip you plan to send.
2. In Settings → Video generation → Upscalers, press **Add upscaler**. It starts on your inference server when that is a llama-toolchest; change the address if the upscaler is on another one.
3. Pick the instance under **Upscaler**. Probe lists the server's video upscalers, and the row then shows its scale and the clip size it was measured for, such as "×4 · up to 512×288, 33 frames".

Add one row for each upscaler you want Haruspex to use, from one server or several, and move them up or down: the order is the order they are tried. Clear a row's box to stop using it without removing it. When you first update to a version with this list, it is filled once from the servers your video models are on.

## Upscale a clip

Ask in Chat or the Code tab: "upscale that clip", "make clips/intro.mp4 four times larger", or "upscale it with seedvr2-3b" (an upscaler's name in the list). The clip can be one made in the conversation or a video file in the working folder, in any format ffmpeg reads.

- Without a scale, Haruspex uses the smallest in the list, usually ×2.
- Without a named upscaler, it uses the first in the list at that scale that takes the clip. An upscaler whose server doesn't answer is passed over.
- The upscale runs in the background, with a card that shows its progress and **Cancel**. It takes minutes: RelayVSR ×2 is the fastest, and SeedVR2 is slower but restores more detail.
- The result is WebM and plays in the conversation. Ask "save it as intro-2x.webm" to save it in the working folder.
- The clip's sound is put back under the upscaled picture.

If Haruspex closes first, the upscale is picked up when it reopens, as long as the server still has the job.

## Which clips it takes

A video upscaler holds the whole clip in memory, so it takes short clips only: at most about 224 frames at 832×480, 97 at 1280×720, or 43 at 1920×1080. An instance also refuses a clip larger or longer than the one it was measured with in llama-toolchest; a portrait clip needs a portrait measurement.

Haruspex checks the clip before it sends it, and says what to change. To upscale a longer clip, cut it into parts with the video tools (see the `video-cut` page) and upscale each part.

## What it doesn't do

- The bundled image engine, ComfyUI and Lemonade don't upscale clips.
- Cancelling a running upscale stops the upscaler instance in llama-toolchest, as it can't stop part way. The next upscale starts it again.
- It doesn't join the parts of a longer clip for you.
- The Shell assistant and scheduled jobs don't upscale clips.
