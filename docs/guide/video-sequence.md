---
title: Making a long generated video
description: The Video sequence job — a brief to a rendered video of generated clips, someone speaking, joins, music and narration, in a Shotcut or Kdenlive project; run modes and resume.
---

# Making a long generated video

A Video sequence job turns a brief ("2 minutes: a fox walking in snow, then a fox in a summer forest, a gentle piano bed") into one rendered video: sections of generated clips, each continuing from the last, joined the way you choose, with music and narration under them. The result is a normal Shotcut or Kdenlive project you can open and change, and its render.

## Turn it on

Open Settings → Video editing and turn on **Let the assistant edit videos**, and set up a video model in Settings → Video generation (see the `video-generation` page). For opening stills, set up an image backend in Settings → Image generation; for music, Settings → Music generation. Then Jobs → new job → **Video sequence**.

## Write the job

- **Episode folder**: where everything goes, inside the working folder. Clips and pictures already in it can be sections and start pictures. A folder that doesn't exist is made, and the Interview step says so: a misspelt name starts an empty episode.
- **Brief**: what the video is. Say lengths, how sections join, and the sound if you know them.
- **Run mode**: _Attended_ asks, one question at a time, what the brief leaves open, and stops to show you the spec, the stills, and each section's first clip. _Unattended_ never asks.
- **Video model**: one from Settings → Video generation, or **Automatic**: the first that can make the clips, preferring one that ends on a picture. On Automatic, a clip it can't make goes to another model.
- **Speaking model**: one that makes someone speak (Wan2.2 S2V), for speaking sections; **Automatic** takes the first, **None** leaves them out.
- **Sections start from**: _A still_ draws an opening picture for each section; _The prompt_ makes each section's first clip from its text alone, with no image backend. Later clips continue from the last frame.
- **Check each seam**, **Re-anchor every** (with stills only) and **Editor**: see their tooltips.

## What a run does

1. Writes `sequence.json`: the sections, how each joins the next (a cut, a crossfade, or a generated transition), and the sound. You can edit this file; a run reads it as it is.
2. Speaks the lines of each speaking section into `narration/` (see below).
3. With _A still_, makes a still for each generated section in `keyframes/`. Later sections' stills are edits of the first, so the subject stays the same, when the image model can edit. An Attended run shows them as thumbnails: click one, or **View all stills**, to see them full size, and use ← and → to go through them.
4. Makes the clips in `generated/`. A section longer than the model's longest clip is several clips, each starting from the last frame of the one before; with stills, every few clips end on a fresh one, so it doesn't drift.
5. With a model that can see, checks each seam and makes a clip that jumps once more.
6. Makes the music beds in `music/` and the narration in `narration/`.
7. Cuts everything into `<episode>.mlt` or `.kdenlive`, renders it to `renders/`, and writes `REPORT-sequence.md`: what was made, what was flagged, and the render's check.

The project's format follows the video model: LTX-2.3's 1280×704 at 24 fps becomes a 720p, 24 fps project. A clip's own sound is kept when the spec says so; otherwise it is muted in the project, where you can bring it back.

## Someone speaking

A speaking section is a person in a portrait saying lines, such as a presenter between two scenes. Ask for one in the brief ("then a presenter in a winter coat says: …"). Give a picture of the person in the episode folder, or one is drawn. The spec's `style` isn't used: the section's prompt says who, where and the look. Each line is spoken first, in its saved voice if it names one. Then the speech is cut at its pauses into clips of at most the speaking model's longest clip (about 5 s for S2V), each made from the portrait with its stretch of speech under it. Clips join with a cut, or a 0.3 s crossfade when the section asks. Music under it sits low. Each clip starts afresh from the portrait, so the joins between them show. S2V makes 16 fps clips, placed in the project as they are.

## Stop and carry on

Everything is saved as it is made. A run that failed or was stopped has **Resume** in its run view: it carries on from the next thing not made, and follows a clip the video server was still making when Haruspex closed. Changing a section's prompt in `sequence.json` makes that section again and keeps the rest. When the video server can't load its model because another one holds the GPU, the run waits a minute and tries again, up to three times, before it stops.

## How long it takes

A run says how many clips it will make. The time is estimated once the first clip is made. Two minutes on LTX-2.3 is about 25 clips, often two to four hours.

## What it doesn't do

- It doesn't upscale clips, and a speaking section's clips don't continue one from another.
- Clips chained by their last frame keep the subject, but motion can change at a seam. With _The prompt_, nothing holds the subject from one section to the next.
- It can't run on a schedule.
- Narration is spoken by Settings → Audio → Speech engine: a Kokoro voice, or with a llama.cpp server the saved voice a line names (see the `speech` page).

## What has been tested

Each stage has automated tests with stand-in models. A 10-second fox brief has run end to end, Unattended, on Wan 2.2 TI2V 5B with FLUX.2 klein stills and ACE-Step music: two stills, eight chained clips, a crossfade, a piano bed, a Shotcut project and its render. Resume kept the stills after a failed run. LTX-2.3, transitions on a model with end pictures, seam checks and narration have not been tried on real servers yet.
