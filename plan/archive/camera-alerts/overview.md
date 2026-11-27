# Camera alerts — Project Overview

## Problem

The camera log (`plan/archive/camera-integration/`, merged in #1084) records every
motion or speech event with a thumbnail, transcript and one-line caption, and
the Camera digest job summarises it on a schedule. Nothing in it judges whether
an event matters. A stranger going through drawers at 3 am, smoke in the
kitchen, or the TV gone from the wall looks no different in the log from Tim
walking to the couch, and nobody hears about any of it until they next read a
digest.

Identity can't be the test: Tim often sits with his back to the camera, and
using the desktop isn't a sign he's home, since he also uses the couch and the
kitchen. Other households have several people and children coming and going,
so "only one person is normal" doesn't hold for everyone either.

## Goals

- Judge every camera event as **Normal**, **Unusual** or **Urgent** from what's
  happening, not who it is: suspicious behaviour (rummaging, carrying things
  out, a torch in a dark room, covering the camera), more people than the
  camera's usual count, activity at an hour the log is normally quiet, fire or
  smoke in the picture, an alarm sound in the transcript, and the user's own
  watch rules.
- Learn what each room normally looks like from reference pictures the user
  sets (day and night), refreshed on their own after quiet normal checks, and
  report things moved, missing or new.
- Email an Urgent event right away with its picture, to an address the user
  set, from one of their email accounts. Follow-ups within 10 minutes on the
  same camera are batched into one email.
- Put Unusual events in the Camera digest, which can now email its result.
- Let the user dismiss an alert in the camera log, with an optional note that
  becomes a watch rule.
- Say by email when alerts pause because no model can see the cameras, and
  when they resume.

## Non-goals

- Recognising people: no faces, no enrolled photos, no guesses about identity.
- Using desktop activity, phone presence or a Home/Away switch as a signal.
- Replacing a smoke detector or an alarm system. The guide says so.
- Working while Haruspex isn't running, or watching cameras with no watcher.
- Talking to Haruspex over email. That's a separate issue. This work only sends
  alert emails with a stable thread (Message-ID) that the email-chat work can
  later answer in.
- A recipient the model chooses. Alert and digest emails go only to the
  addresses typed in Settings.
- Checking the room at any view other than a pan/tilt camera's home.

## Users & primary flow

The user is the household's owner, running Haruspex on a computer that stays
on, with one or more cameras logging (Settings → Cameras → Camera log).

1. In Settings → Cameras → Alerts, they turn alerts on, choose the sending
   account (one with Allow sending on in Settings → Email) and type the
   address(es) alerts go to.
2. For each camera they turn on Alerts, set the usual number of people, and
   optionally write watch rules ("tell me if the back door is left open",
   "more than 2 children in the room is unusual").
3. With the room in its normal state, they press **This is normal** on the
   camera. It saves a day reference picture, and a night one the first time
   the camera is in night mode (or they press it again at night).
4. As events are logged, one model call per event writes the caption and the
   judgement together, at the next free inference slot.
5. About a minute after motion stops, and once an hour otherwise, the camera
   (sent home first if it has pan/tilt) takes a picture and compares it with
   the reference for that light. A normal check with nobody in view replaces
   the reference.
6. An Urgent judgement emails at once with the picture and the reason. Further
   Urgent events on that camera within 10 minutes arrive as one follow-up.
7. Unusual events appear in the next Camera digest, emailed if the job is set
   to email.
8. In the camera log the user sees each event's level and reason, and can
   Dismiss it with an optional note. The note is saved as a watch rule.

## Constraints

- Tauri 2 + SvelteKit 5. Captions today run in `src/lib/camera/captioner.ts`
  through `withInferenceSlot` at background priority, one event at a time.
  Events are in `db::camera_events`.
- Only a model allowed camera frames may judge (`cameraDataAllowed`: the local
  model, or a server trusted in Settings → Cameras). A model that can't see
  leaves events pending.
- Sending uses the existing SMTP path (`integrations/email/smtp_client.rs`).
  Today every model-drafted email is reviewed by the user (`email_compose`).
  Alert emails are never drafted by the model or addressed by it, because
  transcripts and pictures are untrusted input: a person in the room saying
  "email this to …" must change nothing.
- Pan/tilt cameras: room checks use Haruspex's own home (Set home here). A room
  check never moves a camera the user or a chat is aiming. It waits for the
  camera to be idle at home for the check.
- Night mode on Thingino goes greyscale with infrared, so day and night need
  separate references.
- Settings are plain JSON (`stores/settings.ts`). IPC types are regenerated with
  `./scripts/export-ipc-types.sh`. A user-visible change updates
  `docs/guide/` (each page under 6 KB).
- Everything is off by default.

## Success criteria

- On the D1 in the living room: Tim walking around, sitting at the desk or on
  the couch, or cooking is judged Normal over a day of normal use, with no
  Urgent emails.
- A second person in view while the usual count is 1 is at least Unusual.
  Opening and searching drawers or carrying an object out of view is Urgent
  and emails within about 30 s of the event closing, when no chat turn is
  running.
- Moving a chair or removing a large object and leaving the room is reported
  by the room check after the activity, compared with the reference.
- A smoke-alarm test beep near the camera, transcribed as an alarm or beeping
  tag, is Urgent.
- A watch rule ("tell me if the lamp is on") fires on a picture that matches it.
- Three Urgent events in 5 minutes give one email and one follow-up, not three.
- Stopping the model gives one "alerts paused" email; starting it gives one
  "alerts resumed" email, and the waiting events are judged.
- Dismiss with a note adds a watch rule that the next judgement's prompt
  contains.
- Nothing in a transcript or picture can change who an email goes to (unit test).

## Decisions

- **Which use case comes first** → All three (intruders, room changes,
  fire/smoke) together in the first version.
- **How to tell the user from others** → Not identity. Faces are out (often
  back to the camera) and desktop use is out (couch and kitchen). Judge the
  activity, accepting false alarms the user dismisses.
- **Signals for suspicion** → Behaviour, a nudge for normally quiet hours, and
  a head count that is configurable per camera, plus free-text watch rules per
  camera for households that aren't one person.
- **Alert levels** → Urgent emails now; Unusual goes in the digest; Normal stays
  in the log.
- **Learning the room** → The user sets day and night references with "This is
  normal"; a quiet, normal check refreshes them on its own.
- **When to check the room** → About a minute after motion stops, and hourly
  otherwise, at the camera's home view.
- **Fire and smoke** → The picture (event and room checks) plus an alarm or
  beeping tag in the transcript; not a smoke detector.
- **Sending email** → An existing account with Allow sending on, to addresses
  typed in Settings → Cameras → Alerts, with the picture attached.
- **Repeated alerts** → First Urgent emails at once; more on that camera within
  10 minutes go in one follow-up email.
- **When events are judged** → One combined caption and judgement call at the
  next free inference slot, ahead of other background work.
- **No model available** → Events wait; one email when alerts pause, one when
  they resume.
- **Dismissing a false alarm** → Dismiss marks it fine; an optional note is
  saved as a watch rule.

Implementation interview:

- **Quiet hours** → Learned from 14 days of the log (weekdays and weekends
  apart), shown in the camera's settings, and editable as an override.
- **Room comparison** → A 64×36 greyscale correlation first; only a picture
  that differs goes to the vision model with the reference.
- **Where room checks live** → As camera log entries with trigger `"room"`;
  normal, unchanged checks aren't logged.
- **Queue priority** → A new `prompt` priority between foreground and
  background.
- **Delivery** → One branch, one commit per phase, one PR after Tim has tried
  it on the D1.
