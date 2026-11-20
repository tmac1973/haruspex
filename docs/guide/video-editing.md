---
title: Video editing
description: Setting up video editing, picking a series or episode folder, setting an intro and outro, and asking about and looking at your clips.
---

# Video editing

The assistant can look at the clips for a video in Chat or the Code tab. It uses ffmpeg and ffprobe, which ship with Haruspex, and melt, which comes with Shotcut and Kdenlive. The tools are off until you turn them on and all three are found.

## Set up video editing

Install Shotcut or Kdenlive for melt. On Linux, use your distribution's package or Shotcut's tarball in `/opt/shotcut`: a Flatpak's melt can't be run from outside it. Fedora's `mlt-melt` and `melt-7` are found too.

Open Settings → Video editing. **Programs** shows each one with its version and where it was found. **Use** picks ffmpeg and ffprobe: **Automatic** (bundled, then PATH, then an editor's), **Bundled with Haruspex**, **System**, or **Custom paths**. If melt or a custom ffmpeg says **Not found**, type its path or click **Browse…**.

Then turn on **Let the assistant edit videos** under **Video tools**.

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

## Make a cut

Ask "make ep012 from the clips in order". The assistant writes a Shotcut or Kdenlive project you can open and change yourself: see the `video-cut` page. To render it, see the `video-render` page; to cut by what was said, the `video-speech` page.

## What it doesn't do

- It doesn't control a running Shotcut or Kdenlive window.
- It doesn't add effects, titles, colour grading or picture-in-picture, beyond its crossfades and gains.
- It doesn't run in Shell tabs, jobs or subtasks.
- It doesn't read files outside the working folder, except the intro and outro set in Settings → Video editing.
