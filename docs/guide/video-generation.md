---
title: Video generation
description: Turning on llama-toolchest video generation, making a short clip, start and end pictures, making someone in a picture speak, continuing a clip, sound, clip length, and where clips are kept.
---

# Video generation

Haruspex can have a llama-toolchest server make short video clips, with a model such as Wan 2.2 TI2V 5B. It is off by default: nothing happens until you pick a backend in Settings → Video generation.

This page is about making new clips. Cutting and rendering your own footage is on the `video-editing` page.

## Turn it on

Open Settings → Video generation and choose **llama-toolchest** as the **Backend**.

If your chat model comes from a toolchest, its address and key are filled in; otherwise enter the **Server address** (`http://host:3000`) and pick an **API key** from Settings → Inference → API Keys. Press **Probe**, then choose one of its video instances as the **Model**; with only one, it is chosen for you. **Instances on the server** lists its enabled instances. A stopped one starts when Haruspex first uses it, so the first clip takes longer. Adding a model happens in llama-toolchest.

A server you probe or **Add** is kept under **Saved servers**, so you can switch back without typing it; a llama-toolchest is listed in Settings → Image and Music too.

Under the model, Settings says the size and frame rate it makes, and how many frames fit at that size.

## Make a clip

Ask for one in Chat or the Code tab: "a five-second clip of a red fox running through snow". You can ask for portrait instead of landscape, a seed to repeat one, or give a picture from the conversation (or an image file in the working folder) to start from, if the model can.

Some models can also end on a picture, such as Wan 2.2 I2V A14B; with a start picture too, the clip moves from one to the other. On a model that can't, the assistant says so.

A clip takes minutes, so it always runs in the background. The assistant starts it and carries on, so you can keep chatting. The clip gets a card with its place in the queue, its progress and **Cancel**, and is in the **Tasks** list (see the `chat-conversations` page). When it's done, the assistant places it in that conversation, where it plays; the button in its top-left corner, shown when you point at it, plays it full screen (Esc leaves), and **Save as…** under the player saves a copy anywhere.

With a working folder set in Chat, or in a Code session's project, the assistant can also save it there as a `.webm` file: ask "save it as fox.webm". If that file exists in Chat, you're asked before it is replaced.

If Haruspex closes first, the clip is picked up when it reopens, as long as the server still has it.

## Make someone speak

With a speaking model, such as Wan2.2 S2V (llama-toolchest's **s2v** set), a picture of a person and some speech make a clip of them saying it. Choose that instance in Settings → Video generation, then ask "make this portrait say 'hello, welcome to the channel'". The speech can be made in the conversation first (see the `speech` page), or be a sound file in the working folder.

- The clip is as long as the speech. S2V makes at most about 5 seconds (81 frames at 16 fps), less where the instance was measured for fewer; longer speech is refused before anything is sent, so split it at its pauses and make one clip per part.
- The picture sets who speaks; the clip doesn't keep it as its first frame.
- The finished clip plays with the speech under it.

A speaking model needs both the picture and the speech; other models can't take speech.

## Continue a clip

With the video tools on (see the `video-editing` page), ask "continue that clip: the fox walks into the trees". The assistant saves the clip's true last frame as a picture and starts the next clip from it. You get two clips; joining them is a cut in a video project.

## Sound

A clip has sound when the model makes it, such as LTX-2.3, or when it is a speaking clip. The assistant says whether a clip has sound when it arrives. Other Wan models make silent clips.

## How long a clip can be

The model's own size and length are used unless you ask otherwise. A clip can't be longer than the instance has GPU memory for: llama-toolchest measures each instance, and Haruspex shortens a longer request to fit and says so. To allow longer clips, measure the instance at a larger size on llama-toolchest's Server page.

Wan models make 4n + 1 frames, so lengths are rounded down to one of those.

## Where clips are kept

The server keeps a clip for a day, so Haruspex downloads each one, keeps its own copy beside your songs, and deletes it from the server. A clip that belongs to a chat or a Code session stays until you delete that chat or session. Settings → Music → **Clear unused audio** clears unused clips too.

## What it doesn't do

- Only llama-toolchest can make clips.
- It can't change a clip once made: ask for a new one, perhaps with the same seed.
- It can't add sound to a silent clip.
- Clips are saved as WebM; to edit one with your footage, see the `video-editing` page.
- The Shell assistant and scheduled jobs don't make clips.

## What has been tested

In Chat, against llama-toolchest with Wan 2.2 TI2V 5B: making a clip, playing it in the answer and on its card, and picking it up after Haruspex was closed mid-job. Starting from a picture and saving into a folder are covered only by automated tests so far.
