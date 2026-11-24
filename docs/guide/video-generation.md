---
title: Video generation
description: Video models on ComfyUI or llama-toolchest, installing them, which model makes a clip, start and end pictures, making someone speak, sound, clip length, and where clips are kept.
---

# Video generation

Haruspex can have a ComfyUI or llama-toolchest server make short video clips. It is off until you add a video model in Settings → Video generation.

This page is about making new clips. Cutting and rendering your own footage is on the `video-editing` page.

## Add a video model

Open Settings → Video generation and press **Add model**. Choose the **Backend**, enter the **Server address** (`http://host:8188` for ComfyUI, `http://host:3000` for llama-toolchest) and pick an **API key** from Settings → Inference → API Keys if the server needs one. If your chat model comes from a toolchest, its address and key are filled in. Press **Probe**, then choose the **Model**; with only one, it is chosen for you.

Add as many as you like: two ComfyUI servers, or a toolchest's LTX-2.3 and its S2V. Each row says where the model runs and what it can do. Use ↑ and ↓ to set the order.

## Install a model into ComfyUI

A ComfyUI entry lists the four models Haruspex can run there, with their licence and size, and **Install** for any whose files are missing:

- **Wan 2.2 TI2V 5B**: from a prompt or a picture, 24 fps, up to 5 s. Apache 2.0.
- **Wan 2.2 I2V 14B**: from a picture, and to an end picture, 16 fps, up to 5 s. Apache 2.0.
- **Wan 2.2 S2V**: a person in a picture says some speech, 16 fps, up to 4.8 s. Apache 2.0.
- **LTX-2.3**: from a prompt or a picture, with its own sound. Its licence allows commercial use only below a revenue threshold, so you're asked before it downloads.

Install downloads straight into ComfyUI's model folders when ComfyUI runs on this computer. On another computer it goes through ComfyUI-Manager if the server has it, or shows the files and folders to copy by hand. ComfyUI 0.39 or later has every node these need.

On llama-toolchest, adding a model happens in llama-toolchest. A stopped instance starts when Haruspex first uses it.

## Choose which model makes a clip

Haruspex uses the first model in the list that can make what you asked for: a picture to start from, one to end on, speech, or sound. A model that doesn't answer is passed over for the next one. A model that refuses a clip isn't asked again elsewhere. You can also name one: "make it with LTX-2.3".

## Make a clip

Ask for one in Chat or the Code tab: "a five-second clip of a red fox running through snow". You can ask for portrait, a seed to repeat one, a clip with sound, or give a picture from the conversation (or an image file in the working folder) to start from. With an end picture too, the clip moves from one to the other.

A clip takes minutes, so it runs in the background. It gets a card with its progress and **Cancel**, and is in the **Tasks** list (see the `chat-conversations` page). When it's done, the assistant places it in the conversation, where it plays; **Save as…** under the player saves a copy. With a working folder set, ask "save it as fox.webm" to save it there.

If Haruspex closes first, the clip is picked up when it reopens, as long as the server still has the job.

## Make someone speak

With a speaking model (Wan 2.2 S2V), a picture of a person and some speech make a clip of them saying it: "make this portrait say 'hello, welcome to the channel'". The speech can be made in the conversation first (see the `speech` page) or be a sound file in the working folder.

- The clip is as long as the speech, up to about 5 seconds. Longer speech is refused before anything is sent: split it at its pauses.
- The finished clip plays with the speech under it.

## Continue a clip

With the video tools on (see the `video-editing` page), ask "continue that clip: the fox walks into the trees". The assistant saves the clip's last frame and starts the next clip from it.

## Sound

LTX-2.3 and speaking clips have sound; Wan clips are silent. The assistant says whether a clip has sound when it arrives.

## How long a clip can be

The model's own size and length are used unless you ask otherwise. The assistant knows each model's longest clip, which its row in Settings → Video generation shows too; a longer request is shortened to fit, with a note. A video-sequence job plans its clips to that length. On llama-toolchest the limit is what each instance was measured for; measure it larger on llama-toolchest's Server page for longer clips.

## Where clips are kept

Haruspex downloads each clip and keeps its own copy beside your songs. A clip that belongs to a chat or a Code session stays until you delete that chat or session. Settings → Music → **Clear unused audio** clears unused clips too.

## What it doesn't do

- The bundled image engine makes no video.
- It doesn't run your own ComfyUI video workflows, only the four models above.
- It can't change a clip once made, or add sound to a silent one.
- Clips are WebM; to edit one with your footage, see the `video-editing` page.
- The Shell assistant and scheduled jobs don't make clips.
