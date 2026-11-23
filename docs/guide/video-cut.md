---
title: Cutting a video
description: Having the assistant cut a Shotcut or Kdenlive project from your clips, with crossfades, even sound, fill or crop, and sound under the picture, and editing it in Shotcut or Kdenlive.
---

# Cutting a video

The assistant makes the cut as a normal Shotcut (`.mlt`) or Kdenlive (`.kdenlive`) project that you can open and change too. Setting up the video tools is on the `video-editing` page.

## Make a cut

Ask "make ep012 from the clips in order, intro as usual" or "cut ep012: the first clip from 0:10, then the second". The assistant lays the clips end to end on the main track (V1, with A1 in Kdenlive), with the intro first and the outro last when you ask.

A new project is `ep012/ep012.mlt` for Shotcut or `ep012/ep012.kdenlive` for Kdenlive, as Settings → Video editing → **Editor** says, in the size and frame rate of **Format**. Ask for "a Kdenlive project" or "a Shotcut project" to make one for the other editor. If the episode already has a project, that is used: one in the episode folder, or one in the working folder whose name ends in the episode's number, such as `show_012.mlt` for `ep012`. With both kinds in one folder, name the one to use.

Ask for changes the same way: "trim the first 4 seconds off clip 2", "drop clip 3", "move the last clip to the start". The assistant numbers clips from 1 as it lists them. A trim can be exact to the frame too: "drop the first frame of clip 2". Muting part of a clip and holding a frame are on the `video-adjust` page.

Before each change the project is copied to `.haruspex/backups/` next to it (the last 20 are kept), and the change is kept only if melt can still load the project.

## Crossfades and even sound

Ask for "1 second crossfades between the clips", or a crossfade into one clip (not the first). Each is the editor's own kind: a Shotcut transition, or a Kdenlive mix. It dissolves the picture and crossfades the sound, up to 3 seconds, never more than half the shorter clip. Without one the clips join with a hard cut.

Each clip's sound is measured and given a gain that brings it to YouTube's loudness (-14 LUFS) without clipping, so a quiet phone clip and a loud recording sound alike. The gain is the editor's Gain / Volume effect on the clip, and a Limiter follows it when the gain would push the loudest moments past -1.5 dB. In Kdenlive you can see and change both; Shotcut shows the gain but not the Limiter, which still plays. Ask to "leave the volume alone" to skip it. A gain adds at most 20 dB, and the assistant says when a clip stays quieter.

## Fill, letterbox or crop a clip

A clip of another shape, such as a phone clip in a landscape video, is letterboxed: the whole picture, with black bars. Ask to "fill the frame with clip 3" to cut off the spare around the centre instead, or to "crop clip 3 to its middle half" for a region you name. It is the editor's own Crop effect on the clip (Crop: Source in Shotcut), so you can change it there. Ask to "letterbox clip 3" to take it off.

## Put a voiceover or music under the picture

Ask for "the narration under the clips from the start" or "voice.wav at 0:12, and bed.mp3 quietly under the whole video". The sound goes on an audio track at that time and plays under the picture, instead of after the last clip. The project summary lists it under "Audio tracks", numbered in time order.

- Shotcut uses A1, A2 and so on; Kdenlive uses the audio tracks above A1 (a new project has A2). Sound that overlaps, such as speech over a music bed, goes on separate tracks. Shotcut gets a new track when one is needed; in Kdenlive add a track yourself (right-click a track → Insert Track), save, and ask again.
- Its sound is evened out like the clips': speech to -14 LUFS, or a level you ask for. A music bed under speech is usually set to about -30 LUFS ("quietly").
- Trimming, removing or cutting silences from a clip moves the sound with the clip it starts over, so it stays in time with the picture. Captions and the cut's transcript include the speech on the audio tracks.

## Edit it in Shotcut or Kdenlive too

Open the project, change it and save. The assistant reads the saved file before each change and only edits the main track and the audio tracks above. Clips on other video tracks, effects, markers, guides and titles you add stay as they are, and a clip keeps its effects when it is trimmed, moved or split.

- Close the project in the editor without saving before asking for a change, then reopen it, or the editor will save over the change.
- A crossfade you add yourself keeps its two clips together. The assistant won't move one away from the other; remove the crossfade in the editor first. Its own crossfades and gains it changes freely.
- Clips on other video tracks don't move when the main track gets shorter or longer.
- Projects saved by a Kdenlive older than 25.04 can be read but not edited.
- Shotcut projects set to GPU processing can be read but not edited or rendered. Switch them to Native in Shotcut's Settings → Processing Mode.

## What it doesn't do

- It doesn't turn a Kdenlive project into a Shotcut one or back. It can cut the same clips into a new project for the other editor, without your effects.
- It doesn't add effects, titles, colour grading or picture-in-picture, beyond its crossfades, gains and crops.
- It doesn't fade music under speech: set the bed's level, or lower stretches of it (see the `video-adjust` page).
- It doesn't control a running Shotcut or Kdenlive window.
