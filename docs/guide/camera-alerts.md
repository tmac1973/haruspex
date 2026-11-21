---
title: Camera alerts
description: Have camera log entries judged as normal, unusual or urgent, get urgent ones by email, check rooms against a picture of how they normally look, and dismiss false alarms in Settings → Cameras.
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

An Urgent entry shows a desktop notification, and an email when alert emails are on (below). Unusual and Urgent entries show their level and the reason in the camera's **Activity** list. Unusual ones reach you through a Camera digest job with **Email the result** on (see the `camera-log` page): flagged entries lead its summary.

## Get alerts by email

1. Have an email account with **Allow sending** on (Settings → Integrations → Email; see the `integrations` page).
2. In Settings → Cameras → **Alerts**, turn on **Email alerts**, pick **Send from**, and type up to 5 addresses in **Send to**, separated by commas.
3. Click **Send test** to check it arrives.

The first Urgent entry on a camera is emailed at once with its picture, what was seen, why it was flagged and what was heard. More Urgent entries on that camera in the next 10 minutes come in one follow-up email, in the same thread. Alert emails go only to the addresses typed here, and no copy is saved to Sent.

## Watch rules

A watch rule is one sentence about this camera, such as "Tell me if the back door is left open" or "More than 2 children in the room is unusual". Each entry is judged with the camera's rules. A camera keeps up to 20, of up to 300 characters each.

## Spot a changed room

Room checks compare the room with a picture of it as it normally looks, to catch furniture moved, something large gone or new, or smoke.

1. With the room as it should be, click **This is normal** under **Room** in the camera's Alerts settings. A camera that turns goes to its home first.
2. Day and night (a greyscale infrared picture) are kept apart. Click it again at night, or the first check at night saves the night picture.

A check runs about a minute after activity stops and hourly otherwise, at the camera's home view. If you or the assistant turned the camera in the last 5 minutes, it waits. A picture almost the same as the reference ends there; otherwise the model compares the two. A changed room is logged as a **Room check** entry, judged and emailed like any other. A normal check with nobody in view becomes the new reference, so a slow change doesn't keep alerting.

## Quiet hours

Haruspex learns when a room is normally quiet from the last 14 days of its log, weekdays and weekends apart. Until a camera has about a week of entries, no hour counts as quiet. **Quiet hours** in the camera's Alerts settings shows the learned hours; **Edit** lets you set them yourself by clicking hours, and **Use learned** goes back.

## Dismiss a false alarm

In the camera's **Activity** list, click **Dismiss** on an Unusual or Urgent entry. You can type why it's fine, such as "Me cooking late at night is normal":

- **Dismiss** marks it handled and keeps your note.
- **Dismiss and add rule** also saves the note as one of the camera's watch rules, so later entries are judged with it.

Expect some false alarms at first. Watch rules are how you teach it what's normal for your home.

## When there's no model to judge

With no model that may see the camera, or a model that's stopped or loading, entries wait as "caption pending" and are judged once one is back. With alert emails on, you get one "alerts paused" email when this starts and one "alerts resumed" email when judging starts again.

## What it doesn't do

- It doesn't recognise people, faces or voices.
- It isn't a smoke detector or an alarm system: it sees one view, only while Haruspex is open, and a judgement can be wrong.
- Room checks only see the home view, and miss small objects.
- Entries from cameras without **Judge entries** are captioned as before, with no level.
