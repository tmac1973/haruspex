---
title: Rendering videos
description: Rendering a Kdenlive project to an MP4 for YouTube in the background, where renders go, the encoder setting, the checks on a finished render, and making a thumbnail.
---

# Rendering videos

The assistant renders the episode's Kdenlive project with melt, the program Kdenlive renders with. Setting up the video tools and making the project are on the `video` page.

## Render a video

Ask "render ep012". The render runs in the background, so you can keep chatting. A card shows how far it has got and the time left, with **Cancel**. When it finishes, the assistant gets a message with the file, its length and size, and how loud it is, and tells you; the card has **Open** and **Show in folder**. If the chat isn't open when it finishes, a notice says which one it was, and the assistant reports when you go back to it.

Renders go in the episode's `renders` folder, named after the project and the time, such as `renders/ep012-20261025-1410.mp4`. They are MP4 (H.264 and AAC) at the project's size and frame rate, at the bitrates YouTube recommends. One render runs at a time. Quitting Haruspex stops a render, and nothing is saved.

Settings → Video → **Encoder** is x264 by default. A hardware encoder (VA-API, NVENC, Quick Sync, AMF or VideoToolbox) is listed only when a test encode with it works on this computer; **Retest** tries again. Hardware encoding is faster; x264 gives the best picture for its size.

The check reports loudness against YouTube's -14 LUFS, a render whose length differs from the project, and a render with no sound.

## Make a thumbnail

Ask "make a thumbnail from 3:12 in the cut", "use the frame at 40 seconds of the phone clip", or "draw a thumbnail of a castle at sunset". A frame comes from a clip, a render or the cut; a drawing comes from the image backend in Settings → Image, and needs one set up. Either way the thumbnail is a 1280×720 JPEG under 2 MB, YouTube's size, saved as `<project>.thumbnail.jpg` in the episode folder and shown in the chat. Pictures of another shape are cropped to fill, or fitted inside black bars if you ask. Making a new one keeps the old one in `.haruspex/backups/`.

Haruspex doesn't put text on a thumbnail. An image model can draw a short title into the picture if the prompt asks for it.

To upload the render, see the `youtube` page.

## What it doesn't do

- It doesn't render anything but the project's main sequence, at the project's size and frame rate. Change those in Kdenlive (Project → Project Settings) or ask for another format before the first cut.
- It doesn't keep a render going after Haruspex quits, or run two at once.
- It doesn't fix what the check finds by itself; ask for the fix.
