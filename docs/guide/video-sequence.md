---
title: Making a long generated video
description: The Video sequence job — a brief to a rendered video of generated clips, someone speaking, joins, music and narration, in a Shotcut or Kdenlive project; run modes and resume.
---

# Making a long generated video

A Video sequence job turns a brief ("2 minutes: a fox walking in snow, then a fox in a summer forest, a gentle piano bed") into one rendered video: sections of generated clips, each continuing from the last, joined the way you choose, with music and narration under them. The result is a normal Shotcut or Kdenlive project you can open and change, and its render.

## Turn it on

Open Settings → Video editing and turn on **Let the assistant edit videos**, and set up a video model in Settings → Video generation (see the `video-generation` page). For opening stills, set up an image backend in Settings → Image; for music, Settings → Music. Then Jobs → new job → **Video sequence**.

## Write the job

- **Episode folder**: where everything goes, inside the working folder. Clips and pictures already in it can be used as sections and start pictures. If it doesn't exist yet, the run makes it and says so in the Interview step, so check the name: a misspelt folder starts an empty episode.
- **Brief**: what the video is. Say lengths, how sections join, and the sound if you know them.
- **Run mode**: _Attended_ asks, one question at a time, what the brief leaves open, and stops to show you the spec, the stills, and each section's first clip. _Unattended_ never asks.
- **Speaking model**: a video instance that makes someone speak (Wan2.2 S2V), for speaking sections; it shows only when the server has one.
- **Video model**, **Open each section on a keyframe**, **Check each seam**, **Re-anchor every** and **Editor**: see their tooltips.

## What a run does

1. Writes `sequence.json`: the sections, how each joins the next (a cut, a crossfade, or a generated transition), and the sound. You can edit this file; a run reads it as it is.
2. Speaks the lines of each speaking section into `narration/` (see below).
3. Makes a still for each generated section in `keyframes/`. Later sections' stills are edits of the first, so the subject stays the same, when the image model can edit. In an Attended run, click a still in the question to see it full size, and use ← and → to go through the others.
4. Makes the clips in `generated/`. A section longer than the model's longest clip is several clips, each starting from the last frame of the one before; every few clips end on a fresh still of the section, so it doesn't drift.
5. With a model that can see, checks each seam and makes a clip that jumps once more.
6. Makes the music beds in `music/` and the narration in `narration/`.
7. Cuts everything into `<episode>.mlt` or `.kdenlive`, renders it to `renders/`, and writes `REPORT-sequence.md`: what was made, what was flagged, and the render's check.

The project's format follows the video model: LTX-2.3's 1280×704 at 24 fps becomes a 720p, 24 fps project, and a model at another size gets a project at its own frame rate. A clip's own sound is kept when the spec says so; otherwise it is muted in the project, where you can bring it back.

## Someone speaking

A speaking section is a person in a portrait saying lines, such as a presenter between two scenes. Ask for one in the brief ("then a presenter in a winter coat says: …"). Give a picture of the person in the episode folder, or one is drawn. Each line is spoken first, in its saved voice if it names one (see the `speech` page). Then the speech is cut at its pauses into clips of at most the speaking model's longest clip (about 5 s for S2V), each made from the portrait with its stretch of speech under it. Clips are joined with a cut, or a 0.3 s crossfade when the section asks. Music under a speaking section sits low. Each clip starts afresh from the portrait, so the joins between them show. S2V makes 16 fps, and its clips are placed in the project as they are. A clip takes several minutes.

## Stop and carry on

Everything is saved as it is made. A run that failed or was stopped has **Resume** in its run view: it carries on from the next thing not made, and follows a clip the video server was still making when Haruspex closed. Changing a section's prompt in `sequence.json` makes that section again and keeps the rest. When the video server can't load its model because another one holds the GPU, the run waits a minute and tries again, up to three times, before it stops.

## How long it takes

A run says how many clips it will make. The time is unknown until the first clip is made; after that it estimates from that clip. Two minutes on LTX-2.3 is about 25 clips, often two to four hours.

## What it doesn't do

- It doesn't upscale clips, and a speaking section's clips don't continue one from another.
- Clips chained by their last frame keep the subject, but motion can change at a seam.
- It can't run on a schedule: it may need to ask.
- Narration is spoken by Settings → Audio → Speech engine: a Kokoro voice, or with a llama.cpp server the saved voice a line names (see the `speech` page).

## What has been tested

Each stage is covered by automated tests with stand-in models. A 10-second fox brief has run end to end, Unattended, on llama-toolchest's Wan 2.2 TI2V 5B with FLUX.2 klein stills and ACE-Step music, with Qwen3.8-Flash writing the spec: two stills (the second an edit of the first), eight chained clips, a crossfade, a piano bed, a Shotcut project and its render. Resume kept the stills after a failed run. LTX-2.3, transitions on a model with end pictures, seam checks and narration have not been tried on real servers yet.
