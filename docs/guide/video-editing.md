---
title: Video editing
description: Setting up video editing, picking a series or episode folder, setting an intro and outro, asking about and looking at your clips, and taking a still from a clip.
---

# Video editing

The assistant can look at the clips for a video in Chat or the Code tab. It uses ffmpeg, ffprobe and melt, which all ship with Haruspex, so you don't need to install anything. The tools are off until you turn them on.

## Set up video editing

Open Settings → Video editing. **Programs** shows each one with its version and where it was found. **ffmpeg and ffprobe** and **melt** each pick **Automatic** (bundled, then PATH, then a Shotcut or Kdenlive install), **Bundled with Haruspex**, **System**, or **Custom path**, where you type the path or click **Browse…**. A Flatpak editor's melt can't be used from outside it.

Then turn on **Let the assistant edit videos** under **Video tools**.

While **Let the assistant edit videos** is on, the bundled `ffmpeg`, `ffprobe` and `melt` also come first in the commands the assistant runs in the Code tab, and in Shell tabs opened after you turn it on (not in WSL). Turning it off leaves your own PATH as it was.

## Pick a folder

The video tools work on the conversation's working folder and nothing outside it. In Chat, click the folder icon in the chat box; in the Code tab it is the session's folder. Shell tabs, jobs and subtasks don't get the video tools.

The folder can be:

- **A series folder**, with one subfolder per episode, such as `videos/ep010/raw/` and `videos/intro001/intro.mp4`. Name the episode when you ask: "what's in ep010?"
- **One episode's folder**. Then the folder itself is the episode.

Clips are found in the episode folder and one level of subfolders. Folders starting with a dot, and a `renders` folder, are skipped.

## Set an intro and outro

Settings → Video editing → **New videos** has **Intro** and **Outro**: a clip to put at the start or end of a video when you ask for it. They may be anywhere on disk; they are the only files outside the working folder the video tools may read. An intro inside a series folder (a file or folder whose name starts with "intro" or "outro") works too: the assistant lists those it sees.

**Editor** is the editor new projects are made for: Shotcut (the default) or Kdenlive. **Format** is the size and frame rate they are made in: 1080p at 30 or 60 fps, 1440p at 60 fps, or 4K at 30 fps.

## Ask about your clips

Ask "what clips are in ep012?" or "how long is the footage for ep012?". The assistant lists each clip's length, size, frame rate and codecs, and says when the clips are mixed (different sizes, frame rates or codecs) or when one has no sound. Files it can't read are listed with the reason.

## Let it look at the footage

With a model that can see images, ask "look at ep012 every two minutes" or "show me the cut at 4:10 and 9:30". The assistant gets one sheet of up to 16 numbered frames, and the sheet shows in the chat too. It can also list where a clip changes shot ("where are the scene changes in the phone clip?"), with any model.

## Take a still from a clip

Ask "save the last frame of ep012/raw/phone.mp4" or "take a still at 0:42". The assistant saves the frame at full size as a PNG in the episode's `.haruspex/stills/` folder, or where you name, and shows it in the chat. The last frame is the clip's true last frame. It works on a generated clip in the conversation too, so a new clip can start from it (see the `video-generation` page).

## Make a cut

Ask "make ep012 from the clips in order". The assistant writes a Shotcut or Kdenlive project you can open and change yourself: see the `video-cut` page. To render it, see the `video-render` page; to cut by what was said, the `video-speech` page.

## What it doesn't do

- It doesn't control a running Shotcut or Kdenlive window.
- It doesn't add effects, titles, colour grading or picture-in-picture, beyond its crossfades and gains.
- It doesn't run in Shell tabs, jobs or subtasks.
- It doesn't read files outside the working folder, except the intro and outro set in Settings → Video editing.
