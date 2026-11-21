---
title: Cameras
description: Add a network camera (found over ONVIF or by its RTSP address) or a USB webcam, test it, give it a note for the assistant, and choose Ask or Allow.
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

A camera that isn't listed may have ONVIF turned off, or be on another network: type its **RTSP address**, then click **Connect** to try ONVIF there; a name you typed (`rtsp://wifi-cam-2.local/ch0`) is kept. Cameras are reached directly, never through the proxy in Settings → Network.

The password goes in the system keychain, or Haruspex's encrypted secrets file where there is no keychain, never in the settings. A saved password shows as "saved"; leave the field blank to keep it.

## Add a USB webcam

Click **Add camera**, set **Kind** to **USB**, and pick the **Webcam**. **Microphone** picks the webcam's own microphone when one matches its name; choose another, or **None**.

On Linux, a webcam that can pan and tilt (such as an OBSBOT Tiny) can set **Pan/tilt** to **Pan/tilt (UVC)**. The option is greyed out for a webcam that can't, and on macOS and Windows. Some webcams, such as a Logitech BRIO, offer pan and tilt but only move within a zoomed-in picture; **Left** or **Right** then says the picture didn't change, and **Pan/tilt** is best left at **None**.

## Test a camera

Click **Test** in the camera's form. Haruspex shows one frame with its size and codec, then listens for 3 seconds and shows how loud it was ("Silent" when nothing was heard). Click the frame to see it larger; the same goes for room references and Activity pictures. If it fails, the reason from ffmpeg is shown, with the password taken out.

A camera with pan/tilt also gets **Left**, **Right**, **Up**, **Down** and **Home** buttons, and **Calibrate**: see the `camera-pan-tilt` page.

Test uses the ffmpeg that Settings → Video editing uses.

## Tell the assistant about a camera

A camera's **Note** is given to the assistant with the camera list, such as "faces the living room; behind it is a wall". Use it for what the camera looks at and what to ignore.

## Ask or Allow

Each camera has a **Permission**:

| Setting | What happens |
|---|---|
| Ask (default) | You approve each use. |
| Allow | Used without asking. Jobs can only use cameras set to Allow. |

The list shows each camera's setting. Click **Edit** to change it, or **Remove** to delete the camera and its saved password.

## Use cameras in Chat

The assistant's camera tools, approvals and trusted servers are on the `camera-chat` page.

## What it doesn't do

- No zoom.
- No pan/tilt for USB webcams on macOS or Windows.
- Without a model that can see images, `camera_look` still turns the camera but takes no picture.
- No recording: Haruspex keeps no video or sound clip. The ambient log keeps text and one small picture per entry.
- No vendor cloud cameras (Ring, Nest, Tapo cloud, Wyze cloud).
