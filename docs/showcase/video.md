---
title: Video
description: Generate clips, make a portrait speak, cut Shotcut or Kdenlive projects from your footage, add chapters and captions, and render to MP4.
---

## Generate a short clip

Describe a clip. It takes minutes, so it runs in the background while you keep chatting.

Tab: Chat or Code
Required settings: Settings → Video generation → a video model on ComfyUI or llama-toolchest (a server you run), such as Wan 2.2 TI2V 5B

Prompt:

> A five-second clip of a red fox running through snow.

Example output:

A card shows the clip's place in the queue, its progress and **Cancel**. When it's done, the clip plays in the conversation, with **Save as…** under the player.

<!-- media: the fox clip playing in a Chat answer -->

Read more: video-generation

## Start a clip from a picture, with ComfyUI

Add your ComfyUI server as a video model, install Wan 2.2 I2V 14B from the same place, then hand it a picture to start from and one to end on.

Tab: Chat or Code
Required settings: Settings → Video generation → a ComfyUI video model, with Wan 2.2 I2V 14B installed from its Install list

Prompt:

> Make a clip that starts on this sketch of a lighthouse and ends on this photo of it at dusk.

Example output:

The clip moves from the first picture to the second and plays in the conversation. The answer names the model that made it.

<!-- media: a Wan 2.2 14B clip moving between two pictures -->

Read more: video-generation

## Make a clip with Veo or Wan on OpenRouter

No video GPU? Add an OpenRouter video model, such as Veo 3.1 or Wan 3.0, and set the most one clip may cost. The prompt is sent to OpenRouter, and the clip is paid for from your OpenRouter credit.

Tab: Chat or Code
Required settings: Settings → Video generation → Add model → Backend: OpenRouter, with an OpenRouter API key and Most per clip ($)

Prompt:

> Make a six-second clip of waves breaking on a rocky shore at sunset, with sound.

Example output:

The clip plays in the conversation, with sound from a model that makes it, and the answer says what it cost. A clip that would cost more than the limit is refused before anything is sent, and the answer says what it would have cost.

<!-- media: Settings → Video generation with an OpenRouter model, its price after Probe and the per-clip limit -->

Read more: video-generation

## Keep a character the same across clips

Give a picture or two of a character, and each clip keeps their look without having to start on that picture. It works with OpenRouter's Wan 3.0, Seedance 2 and Runway models.

Tab: Chat or Code
Required settings: Settings → Video generation → Add model → Backend: OpenRouter, with Wan 3.0, a Seedance 2 model or a Runway model

Prompt:

> Using the robot from the two pictures I drew earlier as reference, make a clip of it walking through a rainy market at night.

Example output:

The clip plays in the conversation with the robot's colours and shape kept, though the scene is new. A model that doesn't take reference pictures is skipped for one that does.

<!-- media: a clip of the robot in a rainy market beside the two reference pictures -->

Read more: video-generation

## Make someone in a picture speak

Give a portrait and some speech, and a speaking model makes a clip of the person saying it, up to about 5 seconds.

Tab: Chat or Code
Required settings: Settings → Video generation → a speaking model such as Wan2.2 S2V

Prompt:

> Make this portrait say "hello, welcome to the channel".

Example output:

The speech is made first, then the clip plays in the conversation with the speech under it.

<!-- media: speaking clip made from a portrait -->

Read more: video-generation, speech

## Upscale a clip

Make a short clip two or four times larger and sharper with a video upscaler from Settings → Video generation → Upscalers. It keeps the clip's sound.

Tab: Chat or Code
Required settings: Settings → Video generation → Upscalers → a RelayVSR or SeedVR2 instance on a llama-toolchest server (a server you run)

Prompt:

> Upscale that fox clip to twice the size and save it as fox-2x.webm.

Example output:

A card shows the upscale's progress and **Cancel**. When it's done, the larger clip plays in the conversation, and the answer gives its old and new size.

<!-- media: an upscaled fox clip playing in a Chat answer -->

Read more: video-upscaling

## Cut a project from your clips

The assistant lays your clips end to end in a Shotcut or Kdenlive project you can open and change, with even sound and crossfades if you ask.

Tab: Chat or Code
Required settings: Settings → Video editing → Let the assistant edit videos; a working folder

Prompt:

> Make ep012 from the clips in order, intro as usual, with 1 second crossfades.

Example output:

The assistant writes `ep012/ep012.mlt` and lists the clips it placed, numbered from 1, with each clip's sound brought to -14 LUFS.

1. intro.mp4
2. raw/cam.mp4
3. raw/phone.mp4 (letterboxed)

Read more: video-cut, video-editing

## Cut silences and retakes by what was said

Transcribe the footage, then cut by the words: silences, a retake, or the ums and false starts.

Tab: Chat or Code
Required settings: Settings → Video editing → Let the assistant edit videos; a working folder

Prompt:

> Take the ums and false starts out of ep012.

Example output:

1. 0:41 "…so the, um, the next step…" (0.6 s)
2. 2:13 "We start by — we start by sanding…" (1.8 s)
3. …

Which should I cut: all, none, or by number?

Read more: video-speech, video-skills

## Write YouTube chapters and captions

Chapters come from where each topic starts; captions are an SRT made from the transcript, mapped into the cut.

Tab: Chat or Code
Required settings: Settings → Video editing → Let the assistant edit videos; a working folder

Prompt:

> Add chapters to ep012 and write captions for it.

Example output:

Saved `ep012.chapters.txt`:

0:00 Intro
1:12 Sanding the frame
…

Captions saved next to the newest render as `renders/ep012-….srt`. Add them in YouTube Studio → Subtitles.

Read more: video-speech

## Replace a misspoken word in your own voice

Strike or retype words in the transcript viewer. The new words are spoken in your saved voice and fitted into the project.

Tab: Chat or Code
Required settings: Settings → Audio → Speech engine → llama.cpp server; a saved voice; Settings → Video editing → Let the assistant edit videos

Prompt:

> /fix-speech apply .haruspex/edits/cam.edits.json

Example output:

The struck words are cut from the project, each new phrase is spoken in your voice and checked by transcribing it, and the old words are muted under the take. The assistant reports what it did and suggests rendering.

<!-- media: transcript viewer with a struck word and a retyped one, then the chat report -->

Read more: speech-replacement, transcript-viewer

## Change speed, mute part, or hold a frame

Adjust one clip in the cut. Each change is the editor's own, so you can change it later in Shotcut or Kdenlive.

Tab: Chat or Code
Required settings: Settings → Video editing → Let the assistant edit videos; a working folder

Prompt:

> Play clip 2 at half speed, mute 0:12.4 to 0:13 of clip 3, and hold the last frame of clip 4 for 2 seconds.

Example output:

The project is updated: clip 2 plays at half speed with its pitch kept, a stretch of clip 3 is muted, and a 2-second still of clip 4's last frame follows it. Later clips and their sound move to match.

Read more: video-adjust

## Render to MP4 and make a thumbnail

The render runs in the background and is checked when it finishes. A thumbnail comes from a frame, or is drawn by the image backend.

Tab: Chat or Code
Required settings: Settings → Video editing → Let the assistant edit videos; Settings → Image generation for a drawn thumbnail

Prompt:

> Render ep012, then make a thumbnail from 3:12 in the cut.

Example output:

A card shows progress and time left, then plays `renders/ep012-….mp4` with **Open** and **Show in folder**. The assistant reports its length, size and loudness against -14 LUFS, and saves a 1280×720 `ep012.thumbnail.jpg`.

<!-- media: render card playing the finished MP4, and the thumbnail in the chat -->

Read more: video-render

## Turn a brief into a long generated video

The Video sequence job makes sections of chained clips, joins them, adds music and narration, and renders a Shotcut or Kdenlive project.

Tab: Jobs
Required settings: Settings → Video editing → Let the assistant edit videos; Settings → Video generation; Settings → Music generation for music; Settings → Image generation for stills, unless Sections start from is The prompt

Prompt:

> 2 minutes: a fox walking in snow, then a fox in a summer forest, a gentle piano bed.

Example output:

The run writes `sequence.json`, makes stills, clips and the music bed, cuts them into a project, renders it to `renders/`, and writes `REPORT-sequence.md` with what was made and flagged.

<!-- media: Video sequence run view, then the rendered video playing -->

Read more: video-sequence, video-skills
