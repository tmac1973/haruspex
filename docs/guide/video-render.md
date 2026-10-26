---
title: Rendering videos
description: Rendering a Kdenlive project to an MP4 for YouTube in the background, the progress card, where renders go, the encoder setting, and the checks on a finished render.
---

# Rendering videos

The assistant renders the episode's Kdenlive project with melt, the program Kdenlive renders with. Setting up the video tools and making the project are on the `video` page.

## Render a video

Ask "render ep012". The render runs in the background, so you can keep chatting. A card shows how far it has got and the time left, with **Cancel**. When it finishes, the assistant gets a message with the file, its length and size, and how loud it is, and tells you; the card has **Open** and **Show in folder**. If the chat isn't open when it finishes, a notice says which one it was, and the assistant reports when you go back to it.

Renders go in the episode's `renders` folder, named after the project and the time, such as `renders/ep012-20261025-1410.mp4`. They are MP4 (H.264 and AAC) at the project's size and frame rate, at the bitrates YouTube recommends. One render runs at a time. Quitting Haruspex stops a render, and nothing is saved.

Settings → Video → **Encoder** is x264 by default. A hardware encoder (VA-API, NVENC, Quick Sync, AMF or VideoToolbox) is listed only when a test encode with it works on this computer; **Retest** tries again. Hardware encoding is faster; x264 gives the best picture for its size.

The check reports loudness against YouTube's -14 LUFS, a render whose length differs from the project, and a render with no sound.

## What it doesn't do

- It doesn't render anything but the project's main sequence, at the project's size and frame rate. Change those in Kdenlive (Project → Project Settings) or ask for another format before the first cut.
- It doesn't keep a render going after Haruspex quits, or run two at once.
- It doesn't fix what the check finds by itself; ask for the fix.
