---
title: Video editing
description: Setting up video editing with Kdenlive, picking a series or episode folder, asking about and looking at your clips, and having the assistant cut a Kdenlive project you can also edit.
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

## Let it look at the footage

With a model that can see images, ask "look at ep012 every two minutes" or "show me the cut at 4:10 and 9:30". The assistant gets one sheet of up to 16 numbered frames, and the sheet shows in the chat too. It can also list where a clip changes shot ("where are the scene changes in the phone clip?"), with any model.

## Make a cut

Ask "make ep012 from the clips in order, intro as usual" or "cut ep012: the first clip from 0:10, then the second". The assistant writes a Kdenlive project and lays the clips end to end on the main track (V1 with A1), with the intro first and the outro last when you ask.

A new project is `ep012/ep012.kdenlive`, made in the Settings → Video → **Format**. If the episode already has one, that is used: one in the episode folder, or one in the working folder whose name ends in the episode's number, such as `show_012.kdenlive` for `ep012`. Name another to use it.

Ask for changes the same way: "trim the first 4 seconds off clip 2", "drop clip 3", "move the last clip to the start". The assistant numbers clips from 1 as it lists them.

Before each change the project is copied to `.haruspex/backups/` next to it (the last 20 are kept), and the change is kept only if melt can still load the project.

## Crossfades and even sound

Ask for "1 second crossfades between the clips", or a crossfade into one clip. Each is a normal Kdenlive mix: a dissolve on the picture and a crossfade on the sound, up to 3 seconds, and never more than half the shorter clip. Without one the clips join with a hard cut.

Each clip's sound is measured and given a gain that brings it to YouTube's loudness (-14 LUFS) without clipping, so a quiet phone clip and a loud recording sound alike. The gain is a Volume effect on the clip, which you can see and change in Kdenlive. Ask to "leave the volume alone" to skip it. If a render's check says the loudness is off, ask to even out the sound again.

## Edit it in Kdenlive too

The project is a normal Kdenlive project: open it, change it and save. The assistant reads the saved file before each change, and only edits the main track. Clips on other tracks, effects, guides and titles you add stay as they are, and a clip keeps its effects when it is trimmed or moved.

- Close the project in Kdenlive without saving before asking for a change, then reopen it, or Kdenlive will save over the change.
- A crossfade you add in Kdenlive keeps its two clips together. The assistant won't move one of them away from the other; remove the crossfade in Kdenlive first. Its own crossfades and gains it changes freely.
- Clips on other tracks don't move when the main track gets shorter or longer.
- Projects saved by a Kdenlive older than 25.04 can be read but not edited.

To turn the project into a video file, see the `video-render` page. To cut by what was said, and for chapters and captions, see the `video-speech` page.

## What it doesn't do

- It doesn't control a running Kdenlive window.
- It doesn't add effects, titles, colour grading or picture-in-picture, beyond its crossfades and gains.
- It doesn't run in Shell tabs, jobs or subtasks.
- It doesn't read files outside the working folder, except the intro and outro set in Settings → Video.
