---
title: Video editing
description: Setting up video editing with Kdenlive, ffmpeg and melt, picking a series or episode folder, and asking about your clips in Chat or the Code tab.
---

# Video editing

The assistant can look at the clips for a video in Chat or the Code tab. It uses ffmpeg, ffprobe and melt on your computer, the programs Kdenlive runs on. Nothing is bundled or downloaded, and the tools are off until all three are found.

## Set up video editing

Install Kdenlive. On Linux, use your distribution's package: the Flatpak's melt can't be run from outside it. On macOS and Windows, Kdenlive ships ffmpeg, ffprobe and melt, and Haruspex finds them inside the install.

Open Settings → Video. **Programs** shows each one with its version and where it was found: **PATH**, **Kdenlive** or **set here**. If one says **Not found**, type its path or click **Browse…**, then **Check again**.

## Pick a folder

The video tools work on the conversation's working folder and nothing outside it. In Chat, click the folder icon in the chat box; in the Code tab it is the session's folder. Shell tabs, jobs and subtasks don't get the video tools.

The folder can be:

- **A series folder**, with one subfolder per episode, such as `videos/ep010/raw/` and `videos/intro001/intro.mp4`. Name the episode when you ask: "what's in ep010?"
- **One episode's folder**. Then the folder itself is the episode.

Clips are found in the episode folder and one level of subfolders. Folders starting with a dot, and a `renders` folder, are skipped.

## Set an intro and outro

Settings → Video → **New videos** has **Intro** and **Outro**: a clip to put at the start or end of a video when you ask for it. They may be anywhere on disk; they are the only files outside the working folder the video tools may read. An intro inside a series folder (a file or folder whose name starts with "intro" or "outro") works too: the assistant lists those it sees.

**Format** is the size and frame rate new video projects are made in: 1080p at 30 or 60 fps, 1440p at 60 fps, or 4K at 30 fps.

## Ask about your clips

Ask "what clips are in ep012?" or "how long is the footage for ep012?". The assistant lists each clip's length, size, frame rate and codecs, and says when the clips are mixed (different sizes, frame rates or codecs) or when one has no sound. Files it can't read are listed with the reason.

## What it doesn't do

- It doesn't control a running Kdenlive window.
- It doesn't add effects, titles, colour grading or picture-in-picture.
- It doesn't run in Shell tabs, jobs or subtasks.
- It doesn't read files outside the working folder, except the intro and outro set in Settings → Video.
