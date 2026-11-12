---
title: Cameras
description: Add a network (RTSP) camera or a USB webcam, test it, choose Ask or Allow, pick which of your own servers may see and hear it, and let the assistant look and listen in Chat.
---

# Cameras

Settings → Cameras lists the cameras Haruspex can use: network cameras that stream over RTSP, and USB webcams. None are set up until you add one.

## Add a network camera

1. Go to Settings → Cameras and click **Add camera**.
2. Leave **Kind** on **Network** and type a **Name**, such as Kitchen. You and the assistant use this name.
3. Paste the camera's **RTSP address**, for example `rtsp://192.168.1.50:554/ch0`. The camera's manual or web page gives it.
4. Fill in **User name** and **Password**. If the address you pasted has them in it (`rtsp://admin:secret@…`), they move into these fields by themselves.
5. Optionally fill in **Substream**: a smaller stream from the same camera, used by the ambient log.
6. Click **Save**.

The password goes in the system keychain, or Haruspex's encrypted secrets file where there is no keychain, never in the settings. A saved password shows as "saved"; leave the field blank to keep it.

## Add a USB webcam

Click **Add camera**, set **Kind** to **USB**, and pick the **Webcam**. **Microphone** picks the webcam's own microphone when one matches its name; choose another, or **None**.

## Test a camera

Click **Test** in the camera's form. Haruspex shows one frame with its size and codec, then listens for 3 seconds and shows how loud it was ("Silent" when nothing was heard). If it fails, the reason from ffmpeg is shown, with the password taken out.

Test uses ffmpeg and ffprobe, the same ones Settings → Video editing finds or is set to.

## Ask or Allow

Each camera has a **Permission**:

| Setting | What happens |
|---|---|
| Ask (default) | You approve each use. |
| Allow | Used without asking. Jobs can only use cameras set to Allow. |

The list shows each camera's setting. Click **Edit** to change it, or **Remove** to delete the camera and its saved password.

## Trusted servers

Frames and sound from your cameras go to the local model. A remote model only gets them from a server you mark in the **Trusted servers** card, which lists the servers saved in Settings → Inference.

Only servers on your own network can be marked: private addresses (192.168.x.x, 10.x.x.x, 172.16–31.x.x), this computer, link-local addresses, and names ending `.local` or `.internal`. A public server, and OpenRouter, can never be trusted.

## Let the assistant look and listen

In Chat, the assistant can use your cameras with three tools:

| Tool | What it does |
|---|---|
| `camera_list` | Lists your cameras, whether each has sound or can be aimed, and its permission. |
| `camera_snapshot` | Takes one picture from a camera and looks at it. Needs a model that can see images. |
| `camera_listen` | Records up to 30 seconds of sound (10 by default), transcribes it on this computer, and says how loud it was. The clip isn't kept. |

Ask "what's on the kitchen counter?" or "what's being said in the kitchen?" and name the camera. A camera set to Ask shows a prompt each time: **Allow** lets this one use go ahead, **Deny** takes nothing. Stopping the turn counts as Deny. A camera badge in the header names each camera while it's in use; click it to open Settings → Cameras.

The tools only appear when you have a camera and the chat model is the local one or a trusted server (see below). With OpenRouter or any other server they aren't offered, and a call is refused. They don't appear in the Code or Shell tabs, or in lean mode.

Jobs never ask: a job can only use cameras set to Allow, and is refused an Ask camera.

## What it doesn't do

- No pan or tilt control yet.
- No ONVIF or network discovery yet: paste the camera's address.
- No recording: Haruspex keeps no video or sound clip.
- No vendor cloud cameras (Ring, Nest, Tapo cloud, Wyze cloud).
