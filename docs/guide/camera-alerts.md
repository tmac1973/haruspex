---
title: Camera alerts
description: Have each camera log entry judged as normal, unusual or urgent from what is happening, set the usual number of people, watch rules and quiet hours, and dismiss false alarms in Settings → Cameras.
---

# Camera alerts

Camera alerts judge each entry in a camera's ambient log as **Normal**, **Unusual** or **Urgent**. They go by what is happening in the picture, not who it is, so you being home or away, or sitting with your back to the camera, doesn't matter. They're off for every camera until you turn them on, and they need the ambient log (see the `camera-log` page).

## Turn them on

1. Go to Settings → Cameras and click **Edit** on the camera.
2. With **Log motion and speech** on, turn on **Judge entries** under **Alerts**.
3. Set **Usual people**: how many people are usually in view at once (1 by default).
4. Optionally add **Watch rules** (below).
5. Click **Save**.

Judging uses the chat model that writes captions: the local model or a server you trust in Settings → Cameras (see the `camera-chat` page), and it must be able to see images. Each entry gets its caption and judgement in one request, sent as soon as the current chat turn finishes, ahead of other background work.

## What counts as what

- **Urgent**: someone searching drawers or cupboards, carrying things out, forcing a door or window, a torch in a dark room, the camera being covered or turned, smoke, flames or a fire glow, an alarm sound heard (whisper writes it as `[alarm]` or `[beeping]`), or a watch rule that matches. More people than usual during a quiet hour is urgent too.
- **Unusual**: more people than **Usual people**, anyone moving about during a quiet hour, or an unfamiliar large object.
- **Normal**: everything else.

An Urgent entry shows a desktop notification. Unusual and Urgent entries show their level and the reason in the camera's **Activity** list.

## Watch rules

A watch rule is one sentence about this camera, such as "Tell me if the back door is left open" or "More than 2 children in the room is unusual". Each entry is judged with the camera's rules. A camera keeps up to 20, of up to 300 characters each.

## Quiet hours

Haruspex learns when a room is normally quiet from the last 14 days of its log, weekdays and weekends apart. Until a camera has about a week of entries, no hour counts as quiet. **Quiet hours** in the camera's Alerts settings shows the learned hours; **Edit** lets you set them yourself by clicking hours, and **Use learned** goes back.

## Dismiss a false alarm

In the camera's **Activity** list, click **Dismiss** on an Unusual or Urgent entry. You can type why it's fine, such as "Me cooking late at night is normal":

- **Dismiss** marks it handled and keeps your note.
- **Dismiss and add rule** also saves the note as one of the camera's watch rules, so later entries are judged with it.

Expect some false alarms at first. Watch rules are how you teach it what's normal for your home.

## When there's no model to judge

With no model that may see the camera, or a model that's stopped or loading, entries wait as "caption pending" and are judged once one is back.

## What it doesn't do

- It doesn't recognise people, faces or voices.
- It isn't a smoke detector or an alarm system: it sees one view, only while Haruspex is open, and a judgement can be wrong.
- Entries from cameras without **Judge entries** are captioned as before, with no level.
