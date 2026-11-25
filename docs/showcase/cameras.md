---
title: Cameras
description: Ask what a camera sees, look around a room, find out what happened while you were out, and get urgent camera alerts or a daily digest by email.
---

## Ask what a camera sees

Name the camera and ask. The assistant takes one picture and looks at it; a camera set to Ask shows a prompt first.

Tab: Chat
Required settings: Settings → Cameras → add a camera; a model that can see images

Prompt:

> What's on the kitchen counter?

Example output:

I took a picture from the Kitchen camera. On the counter there's a kettle, a chopping board with some onions, and an open cereal box near the sink…

Read more: camera-chat, cameras

## Look around a room with a pan/tilt camera

The assistant sweeps the camera from its far left to its far right, a picture at each stop, then points it home.

Tab: Chat
Required settings: Settings → Cameras → a camera with Pan/tilt set, then Calibrate (network cameras)

Prompt:

> Look around the living room. Did I leave my keys out?

Example output:

I looked around the Living room camera's whole range (6 pictures, left to right). In picture 4 there's a set of keys on the coffee table, next to the remote…

Read more: camera-pan-tilt, camera-chat

## Save where a camera points as a preset

Turn the camera until it shows what you want, then ask the assistant to save it under a name. Next time, ask it to look there by that name.

Tab: Chat
Required settings: Settings → Cameras → a network camera with Pan/tilt set to ONVIF

Prompt:

> Save where the porch camera points now as a preset called hallway.

Example output:

Saved the preset "hallway" on Porch where it points now. Its presets are now Door, Garden and hallway; ask me to look at the hallway any time.

Read more: camera-pan-tilt, camera-chat

## Find out what happened while you were out

Turn on a camera's ambient log and it writes an entry each time something moves or someone speaks, with a caption and what was said. Then ask the assistant.

Tab: Chat
Required settings: Settings → Cameras → Edit → Log motion and speech

Prompt:

> Did anyone come by the front door this afternoon?

Example output:

The Front door camera logged two entries this afternoon:

- 14:12: a delivery driver left a parcel on the step. Heard: "Parcel for number 12."
- 16:40: motion only; a cat crossing the path.

Read more: camera-log, camera-chat

## Get an email when a camera sees something urgent

Have each log entry judged as Normal, Unusual or Urgent. An Urgent one shows a desktop notification and is emailed at once with its picture and why it was flagged.

Tab: Settings
Required settings: Settings → Cameras → Edit → Judge entries; Settings → Cameras → Alerts → Email alerts; an email account with Allow sending on

Prompt:

> Tell me if the back door is left open

Example output:

The rule is saved as one of the camera's watch rules. When an entry matches, an alert email arrives with the picture, what was seen, why it was flagged and what was heard.
<!-- media: an Urgent camera alert email with its picture and reason -->

Read more: camera-alerts, camera-log

## Get a daily summary of your cameras

A Camera digest job summarises the log on a schedule and picks out moments worth knowing about, with flagged entries first. It can email the result.

Tab: Jobs
Required settings: a camera set to Allow in Settings → Cameras; Settings → Cameras → Alerts for Email the result

Prompt:

> Only mention people and deliveries

Example output:

Today the Front door camera saw two deliveries (11:05 and 14:12) and one visitor who rang and left at 17:30. The Kitchen camera logged nothing unusual…

Read more: camera-log, jobs
