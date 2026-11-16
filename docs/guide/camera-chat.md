---
title: Cameras in Chat
description: Let the assistant look, listen and turn a camera in Chat with the camera tools, approve each use, and choose which remote servers may see and hear your cameras.
---

# Cameras in Chat

Cameras are added in Settings → Cameras (see the `cameras` page).

## Trusted servers

Frames and sound from your cameras go to the local model. A remote model only gets them from a server you mark in the **Trusted servers** card, which lists the servers saved in Settings → Inference.

Only servers on your own network can be marked: private addresses (192.168.x.x, 10.x.x.x, 172.16–31.x.x), this computer, link-local addresses, and names ending `.local` or `.internal`, and names with no dot (such as `compute`). A public server, and OpenRouter, can never be trusted.

## Let the assistant look and listen

In Chat, the assistant can use your cameras with these tools:

| Tool | What it does |
|---|---|
| `camera_list` | Lists your cameras, whether each has sound or can be aimed (with its presets), and its permission. |
| `camera_snapshot` | Takes one picture from a camera and looks at it. Needs a model that can see images. |
| `camera_listen` | Records up to 30 seconds of sound, transcribes it on this computer and says how loud it was; the clip isn't kept. |
| `camera_look` | Turns a pan/tilt camera, then takes a picture (see the `camera-pan-tilt` page). |
| `camera_look_around` | Sweeps a pan/tilt camera end to end, a picture at each stop, then points it home. |
| `camera_log` | Searches the ambient log (see the `camera-log` page). |

Ask "what's on the kitchen counter?", "look around the kitchen" or "turn the kitchen camera left", and name the camera. A camera set to Ask shows a prompt each time: **Allow** lets this one use go ahead, **Deny** takes nothing. Stopping the turn counts as Deny. A camera badge in the header names each camera while it's in use; click it to open Settings → Cameras.

The tools only appear when you have a camera and the chat model is local or a trusted server (see below); otherwise they aren't offered, and a call is refused. They don't appear in the Code or Shell tabs, or in lean mode.

Jobs never ask: a job can only use cameras set to Allow, and is refused an Ask camera. A Camera digest job summarises the log on a schedule (see the `camera-log` page).

