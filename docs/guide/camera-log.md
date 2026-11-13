---
title: Camera ambient log
description: Turn on a camera's ambient log, set its hours and triggers, browse or delete entries in Settings → Cameras, ask the assistant what happened, or summarise it on a schedule with a Camera digest job.
---

# Camera ambient log

A camera's ambient log writes an entry each time something moves or someone speaks in front of it. You can then ask the assistant "did anyone come by today?". It's off for every camera until you turn it on.

## Turn it on

1. Go to Settings → Cameras and click **Edit** on the camera.
2. Turn on **Log motion and speech**.
3. **Active hours** is **All day**, or pick **Between** and set two times, such as 08:00 and 18:30. An end before the start runs past midnight.
4. Set **Motion** (Low, Medium or High: how much of the picture must change) and **Sound** (how loud it must be, -35 dB by default; lower catches quieter speech, and more noise).
5. Click **Save**. Watching starts within a few seconds.

A network camera's **Substream**, when it has one, is what's watched; the main stream is recorded only while something is happening.

While a camera is being watched, the camera badge in the header names it, in the accent colour rather than red. It turns red while the assistant takes a picture or listens.

## What an entry keeps

- When it started, and whether motion, sound or both set it off.
- What was said, transcribed on this computer.
- A one-sentence caption of what was seen, written by the chat model.
- One small picture.

No video or sound clip is kept: each is deleted once it's transcribed.

## Captions

The chat model writes each caption from the entry's picture. A caption waits until no chat, Code or job turn needs the model, so a reply is never slowed; it appears a little after the turn ends.

Captions are only written by the local model or a server you trust in Settings → Cameras (see the `camera-chat` page). With any other model, entries wait with "caption pending" until you switch back. A model that can't see images leaves them with no caption.

## How long entries are kept

The **Ambient log** card in Settings → Cameras sets **Keep entries for**: 7 days by default, 1 to 90. Older entries and their pictures are deleted.

## Browse and delete entries

Click **Activity** on a camera in Settings → Cameras to see its latest 50 entries, newest first, with their pictures. **Delete** removes one; **Clear all** removes every entry for that camera after you confirm.

## Ask the assistant

In Chat, the `camera_log` tool searches the log: by camera, by words said or seen, and by time ("today", "yesterday", "last 3 hours", or a date). It gets text only, never the pictures. Ask "did anyone come by this afternoon?" or "what did the delivery driver say?".

A camera set to Ask shows one prompt for all such cameras when the assistant reads the log; **Deny** leaves them out. Jobs only read cameras set to Allow.

## Summarise the log on a schedule

A **Camera digest** job (Jobs tab) summarises the log and picks out moments worth knowing about. Set its **Schedule**, such as Daily at 19:00 (see the `jobs` page).

- **Cameras**: the ones to read. None ticked reads every camera set to Allow. A camera set to Ask is greyed out, and skipped with a note if it was ticked before.
- **Period**: since the last run (the last 24 hours on the first), the last 24 hours, or today.
- **Include a snapshot**: also takes a fresh picture from each camera. Skipped when the job's model can't see images.
- **Focus**: optional, such as "only mention people and deliveries".

It needs a camera set to Allow and the local model or a trusted server; the editor says so when either is missing. A period with no entries ends with "Nothing was logged." without using the model.

## What it doesn't do

- It only runs while Haruspex is open.
- No face or person recognition: captions don't say who someone is.
- No alerts or notifications when something happens.
