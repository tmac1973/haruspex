---
title: Settings reference (tools)
description: What the Settings sections for cameras, the Shell and Code tabs, images, music, video, guest chat, remote control, feedback and licences hold, and their defaults.
---

# Settings reference (tools)

The rest of Settings is on the `settings` page. Click the gear in the header to open Settings; **← Back** closes.

## Cameras

- **Add camera**: Network or USB. **Pan/tilt**: None, ONVIF or UVC (Linux). **Permission**: Ask (default) or Allow.
- **Ambient log**: off. **Keep entries for**: 7 days.
- **Trusted servers**: none.

See the `cameras` and `camera-log` pages.

## Shell

The Shell tab's terminal and its assistant.

- **Shell binary**: blank, for `$SHELL`.
- **Recent shell commands attached to each chat message**: 3.
- **Include your shell history file in prompts**: on.
- **Max output bytes per captured command**: 8192.
- **Max steps per turn**: 40, both modes.
- **Start new shells with Full access**: off.
- **Command execution** (Full access): Auto.
- **Memory limit**: 50 % of RAM.

See the `shell` page.

## Code

The coding agent in the Code tab and the Shell's Full access.

- **run_command timeout**: 30 seconds.
- **Max steps per task**: 40.
- **Subtasks**: Read only, Read and write, or Off. See the `code-subtasks` page.
- **Background log size**: 5 MB per process.
- **Additional system prompt**: empty.
- **Auto-approve commands**: off.
- **Helpers**: all off (see `helpers`).

See the `code` page.

## Image generation

- **Backend**: None (default), ComfyUI, Bundled engine (where it can run), Lemonade, llama-toolchest or OpenRouter.

See the `images` page.

## Music generation

- **Backend**: None (default) or llama-toolchest.
- **Default length**: 30 seconds.

See the `music` page.

## Video generation

- **Backend**: None (default), llama-toolchest, ComfyUI or OpenRouter.
- **Most per clip ($)**, for an OpenRouter model: $2.
- What OpenRouter pictures and clips have cost since the last **Reset**, in Settings → Image generation and Settings → Video generation.

See the `video-generation` page.

## Video editing

- **Let the assistant edit videos**: off. **ffmpeg and ffprobe**, **melt**: Automatic (the bundled ones).
- **Editor**: Shotcut. **Format**: 1080p, 60 fps. **Encoder**: x264. **Intro**, **Outro**: none.

See the `video-editing`, `video-cut` and `video-render` pages.

## Guest chat

- **Let people on your network chat with this Haruspex**: off. Uses HTTPS.
- **Who can connect**: **People with the link**.
- **Port**: 8787.
- Once on: a link and QR code, and guests you can disconnect.

See the `guest-chat` page.

## Remote control

Use your Code sessions from other computers. Off; port 8788.

See the `remote-control` page.

## Feedback

- **Open feedback issue…**: a filled-in GitHub issue, API keys removed; check it first.
- **Save Full Diagnostics…**: saves logs to attach to the issue.
- **Let the model report problems with Haruspex's tools**: off. See the `model-feedback` page.

See the `troubleshooting` page.

## Licences

Every open-source program and package Haruspex ships, with its licence text: the programs it runs beside itself (llama.cpp, whisper.cpp, FFmpeg and the rest), and the npm, Rust and Python packages built into it. Open an entry to read its text. Type `npm`, `Rust` or `Python` in the filter to list one kind.
