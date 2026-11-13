---
title: Cameras
description: Add a network camera (found over ONVIF or by its RTSP address) or a USB webcam, test it, choose Ask or Allow, pick trusted servers, and let the assistant look, listen and turn a camera in Chat.
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

## Find a camera on the network

Many network cameras speak ONVIF, which lets Haruspex find them and read their addresses for you.

1. In a new camera's form, click **Find cameras**. Haruspex looks for 3 seconds and lists the cameras that answer.
2. The first one is picked; click another to change it. A blank **Name** takes the name the camera gives itself. A camera with a name on your network is listed by it, and **Use its name** (on by default) keeps it working if the router changes its address.
3. Fill in **User name** and **Password**, then click **Connect**.

Haruspex signs in and fills in **RTSP address** (the camera's sharpest stream) and **Substream** (its smallest). If the camera can pan and tilt, **Pan/tilt** is set to **ONVIF** and its saved positions are listed as **Presets**; **Refresh presets** reads them again after you change them on the camera.

A camera that isn't listed may have ONVIF turned off, or be on another network: type its **RTSP address**, then click **Connect** to try ONVIF there. Cameras are reached directly, never through the proxy in Settings → Network.

The password goes in the system keychain, or Haruspex's encrypted secrets file where there is no keychain, never in the settings. A saved password shows as "saved"; leave the field blank to keep it.

## Add a USB webcam

Click **Add camera**, set **Kind** to **USB**, and pick the **Webcam**. **Microphone** picks the webcam's own microphone when one matches its name; choose another, or **None**.

On Linux, a webcam that can pan and tilt (such as an OBSBOT Tiny) can set **Pan/tilt** to **Pan/tilt (UVC)**. The option is greyed out for a webcam that can't, and on macOS and Windows.

## Test a camera

Click **Test** in the camera's form. Haruspex shows one frame with its size and codec, then listens for 3 seconds and shows how loud it was ("Silent" when nothing was heard). If it fails, the reason from ffmpeg is shown, with the password taken out.

A camera with pan/tilt also gets **Left**, **Right**, **Up**, **Down** and **Home** buttons: each turns it about 10° (Home recentres it) and shows a new frame.

Test uses the ffmpeg that Settings → Video editing uses.

## Ask or Allow

Each camera has a **Permission**:

| Setting | What happens |
|---|---|
| Ask (default) | You approve each use. |
| Allow | Used without asking. Jobs can only use cameras set to Allow. |

The list shows each camera's setting. Click **Edit** to change it, or **Remove** to delete the camera and its saved password.

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
| `camera_look` | Turns a pan/tilt camera left, right, up or down (about 10°, 30° or 60°), back home, or to a preset by name, then takes a picture. |
| `camera_look_around` | Sweeps a pan/tilt camera from its far left to its far right, taking up to 6 pictures, then points it home. |
| `camera_log` | Searches the ambient log (see the `camera-log` page). |

Ask "what's on the kitchen counter?", "look around the kitchen" or "turn the kitchen camera left", and name the camera. A camera set to Ask shows a prompt each time: **Allow** lets this one use go ahead, **Deny** takes nothing. Stopping the turn counts as Deny. A camera badge in the header names each camera while it's in use; click it to open Settings → Cameras.

The tools only appear when you have a camera and the chat model is local or a trusted server (see below); otherwise they aren't offered, and a call is refused. They don't appear in the Code or Shell tabs, or in lean mode.

Jobs never ask: a job can only use cameras set to Allow, and is refused an Ask camera. A Camera digest job summarises the log on a schedule (see the `camera-log` page).

## What it doesn't do

- No zoom.
- No pan/tilt for USB webcams on macOS or Windows.
- Without a model that can see images, `camera_look` still turns the camera but takes no picture.
- No recording: Haruspex keeps no video or sound clip. The ambient log keeps text and one small picture per entry.
- No vendor cloud cameras (Ring, Nest, Tapo cloud, Wyze cloud).
