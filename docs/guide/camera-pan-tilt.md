---
title: Camera pan and tilt
description: Turn a pan/tilt camera from its settings or by asking, calibrate how far its turns go, and have the assistant look around the whole room.
---

# Camera pan and tilt

A camera that can turn has **Pan/tilt** set to **ONVIF** (a network camera, after **Connect** in Settings → Cameras) or **Pan/tilt (UVC)** (a USB webcam on Linux). See the `cameras` page for adding one.

## Turn it from Settings

Once the camera is saved, its form in Settings → Cameras has **Left**, **Right**, **Up**, **Down** and **Home** buttons. Each makes a small turn (Home recentres it) and shows a new frame.

## Calibrate a network camera

Network cameras don't say how far a turn went, and many (including Thingino cameras such as the Cinnado D1) turn much further than asked. **Calibrate**, under **Pan/tilt** in the camera's form, measures it:

1. Click **Calibrate**. The camera goes home, steps to one end of its travel and then the other, comparing pictures as it goes, then does the same up and down. It takes a minute or two.
2. The form shows the result, such as "Turns about 5 picture widths end to end; home is 2.8 from the left end; tilts about 1.6 picture heights, home 0.8 from the bottom".
3. Click **Save**.

Calibrate again after moving the camera or changing its home position. **Connect** clears the calibration, since it may be a different camera. A USB webcam needs none: it reports its own angles.

## Ask the assistant to turn it

`camera_look` turns a camera left, right, up or down (small, medium or large), home, or to a preset by name, then takes a picture. How the assistant is told how far it went:

| Camera | Turns described as |
|---|---|
| USB webcam | Degrees: about 10°, 30° or 60° |
| Calibrated network camera | Picture widths (heights when tilting): about a quarter, half or a whole one |
| Network camera, not calibrated | Words only: a little, some way, a long way |

A turn that doesn't change the picture is reported as the end of its travel that way.

## Look around the room

Ask "look around the kitchen". `camera_look_around` turns the camera to its far left, then steps right taking a picture at each stop (up to 10, at a smaller size), then sends it home. The pictures are numbered left to right.

- On a calibrated camera each step is a little under a picture width, so neighbouring pictures overlap and the whole range is covered. When that would take more than 10 pictures, the steps widen and may leave narrow gaps.
- On an uncalibrated camera it steps its smallest turn and may run out of pictures before the far right; calibrate it to cover the whole range.
- It keeps the camera's tilt. Ask it to tilt first if the camera points at the ceiling or the counter.
- It takes about a minute on a calibrated camera, longer on an uncalibrated one, which checks each step's picture.

## What it doesn't do

- No zoom.
- No full 360° on cameras that stop short of one.
- No pan/tilt for USB webcams on macOS or Windows.
