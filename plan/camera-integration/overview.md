# Camera Integration — Project Overview

## Problem

Haruspex can see the user's screen, but not the room it sits in. A user who
wants the assistant to answer "is anyone in the kitchen?", "what did the
delivery driver say?" or "did anyone come by while I was out?" has no way to
give a local model eyes and ears in a physical space. Consumer cameras that
could do this are built around vendor clouds and apps, which defeats the point
of a private, local assistant.

Cheap cameras can be made fully local (a $12 Cinnado D1 flashed with Thingino
streams 1080p H.264 + mono AAC over RTSP and has pan/tilt over ONVIF; USB PTZ
webcams such as the OBSBOT Tiny expose pan/tilt over UVC). A spike on
2026-11-12 proved the core loop on real hardware: an ffmpeg frame grab from
`rtsp://…/ch0` was legible to a vision model, and a 12-second clip from the
camera mic was transcribed word-for-word by the bundled whisper `base.en`
model. What's missing is the product around it.

## Goals

- The model can **look** (a frame from a named camera), **listen** (a short
  clip, transcribed locally), and **aim** a pan/tilt camera, on demand in
  chat. Jobs reach cameras through a Camera digest job (log + optional
  snapshot).
- An optional **ambient watcher** per camera records events on motion or
  speech, transcribes the audio, captions a frame with the local model, and
  keeps a searchable log the model can query ("anyone come by today?").
- **Brand-neutral**: any RTSP camera, with ONVIF for discovery and pan/tilt
  when the camera offers it; any USB webcam, with UVC pan/tilt on Linux.
- **Local only**: frames and audio never reach a remote model unless the user
  has explicitly marked that server as their own.
- **No terminal needed**: an LGPL ffmpeg/ffprobe ships with the app, shared
  with the video tools.
- Clear consent and visibility: a per-camera Ask/Allow setting and an
  always-visible indicator whenever a camera is in use or a watcher is on.

## Non-goals

- Two-way audio (talking through the camera's speaker). It isn't in ONVIF
  Profile S and is proprietary per vendor; replies come from the computer.
- Continuous video recording, NVR features, or keeping raw audio/video clips.
- Real-time conversation through the camera (wake words, live dialogue).
- Vendor cloud integrations (Tapo, Ring, Wyze cloud, Nest, etc.) and vendor
  proprietary APIs (e.g. Tapo privacy mode).
- USB pan/tilt on macOS and Windows in this release.
- Camera tools in the Code and Shell tabs.
- Bundling `melt`; video editing still finds it as it does today.
- Running the watcher while Haruspex is closed (no headless service).
- Remote access to cameras from outside the local network.
- Face or person recognition / identifying individuals.

## Users & primary flow

The user is a non-technical Haruspex user running a local model, with one or
more cameras on their home network or plugged in by USB.

1. **Add a camera.** Settings → Cameras → Add. Haruspex lists ONVIF cameras
   found on the network and USB video devices; the user picks one or pastes an
   RTSP URL, enters a name ("Kitchen") and credentials (stored in the OS
   keychain), and presses Test to see a live frame and an audio level.
2. **Set permission.** The camera is Ask by default; the user can switch it to
   Allow.
3. **Use it in chat.** "What's on the kitchen counter?" → the model calls
   `camera_snapshot("Kitchen")`; if the camera is Ask, an approval prompt
   appears; the frame is captured and given to the model, which answers. "Turn
   left and look at the door" → `camera_look`. "What's being said in there?" →
   `camera_listen` returns a transcript.
4. **Turn on the watcher (optional).** On the camera's settings, the user turns
   on Ambient log and optionally sets active hours. While it runs, motion or
   speech triggers an entry: transcript + caption + one thumbnail.
5. **Ask about the past.** "Did anyone come by this afternoon?" → the model
   calls `camera_log` and answers from the entries. The user can also browse
   and delete entries under Settings → Cameras.
6. **Jobs.** A Camera digest job ("every evening, summarise the kitchen log")
   runs on a schedule over cameras set to Allow.

## Constraints

- Stack: Tauri 2 (Rust) + SvelteKit 5 runes; tools register through
  `src/lib/agent/tools/registry.ts`; jobs through
  `src/lib/agent/jobs/types/registry.ts`; secrets through `src-tauri/src/secrets.rs`.
- Platforms: Linux, macOS, Windows for network cameras and plain USB webcams;
  USB pan/tilt (v4l2 UVC controls) on Linux only.
- Inference is shared: llama-server runs one model, so ambient captioning must
  go through the existing inference queue behind chat turns.
- Whisper already exists in two instances (8766 voice, 8768 video); camera
  transcription must not interfere with voice input.
- The bundled ffmpeg must be an LGPL build (no x264/x265); cameras only decode.
- Sidecars are named `haruspex-<tool>-{triple}` (rpm/deb conflict rule).
- The jobs scheduler and the watcher only run while the app is open.
- Small local vision models: frames are downscaled sensibly; the design must
  not depend on video understanding, only on single frames and transcripts.
- Visible changes update `docs/guide/` in the same PR; settings copy follows
  the one-sentence + tooltip rule.

## Success criteria

- A Thingino Cinnado D1 and a plain USB webcam can each be added from
  Settings → Cameras without a terminal, on a machine with no system ffmpeg.
- In chat with the local model: `camera_snapshot` returns an image the model
  describes correctly; `camera_listen` returns an accurate transcript of
  speech at a few feet; `camera_look` moves the D1 (ONVIF) and an OBSBOT on
  Linux (UVC), and the next snapshot shows the new view.
- With the chat model set to OpenRouter or an unmarked remote server, no camera
  tool is offered and calling one is refused; marking a LAN server as trusted
  makes them available.
- An Ask camera shows an approval prompt every use; an Allow camera doesn't;
  a Camera digest job skips an Ask camera with a message naming Settings →
  Cameras.
- A scheduled Camera digest job produces a summary of the period's log.
- With the watcher on, walking into view or speaking produces a log entry
  within a minute (transcript, caption, thumbnail); a quiet empty room
  produces none; entries older than the retention window are deleted.
- A chat turn running during an event is never slowed: the caption arrives
  after the turn finishes.
- Video tools still work, and now work with no system ffmpeg (melt aside).
- The guide documents cameras, and every setting appears in `settings.md`.

## Decisions

- **v1 scope** → On-demand tools plus the ambient log.
- **Camera kinds** → Network (RTSP/ONVIF) and USB, including UVC pan/tilt.
- **Permission** → Per-camera Ask/Allow; a visible in-use indicator either way.
- **Local only** → Blocked for remote models, with a per-server opt-in for
  servers the user marks as their own.
- **Ambient triggers** → Motion (scene change) or speech (loudness gate).
- **Ambient retention** → Transcript + caption + one thumbnail; raw clips
  discarded after processing; 7-day default window, configurable.
- **Watcher schedule** → Per-camera manual toggle plus optional active hours;
  off by default; indicator while on.
- **ffmpeg** → Bundle an LGPL ffmpeg + ffprobe sidecar, shared with the video
  tools (override → bundled → PATH → Kdenlive); melt is still found as today.
- **Platforms** → All three; USB pan/tilt Linux-only in v1.
- **GPU sharing** → Detection and transcription continue during chat;
  captioning queues behind the chat turn.
- **Log access** → A `camera_log` model tool plus a recent-entries list with
  delete / clear all in Settings → Cameras.
- **Adding cameras** → ONVIF + USB discovery and manual RTSP URL; test button;
  credentials in the OS keychain.
- **Where tools appear** → Chat, plus the Camera digest job; not Code or Shell.
- **Jobs and Ask cameras** → Jobs may only use cameras set to Allow.
- **Delivery** → All nine phases on one branch, one commit per phase, no PRs
  between phases; evaluate the whole feature before merging to main.
- **How jobs use cameras** → A new Camera digest job type (like Email
  digest) that summarises Allow cameras' logs on a schedule; no free-form
  camera jobs.
