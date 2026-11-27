# llama-toolchest image & music backends — Project Overview

## Problem
llama-toolchest now runs stable-diffusion.cpp and ACE-Step instances behind its
main port: `POST /v1/images/generations` (synchronous, OpenAI-shaped) and
`/v1/music/jobs` (async). Haruspex can use toolchest for chat, but not for
images or music. Its image backends are ComfyUI, the bundled sd-server and
Lemonade. It has no music support at all, and its webview cannot play audio:
TTS plays natively through rodio, and markdown, the CSP and DOMPurify only allow
images.

Toolchest's image route also blocks for the whole queue wait and render. It
reports no progress, and once a render starts it cannot be cancelled. A
Haruspex backend built on that would show a spinner for minutes and could not
report where the job is.

## Goals
- **Toolchest side:**
  - async image jobs (`/v1/images/jobs`), mirroring the music job API;
  - a `phase` field on both job objects;
  - a `meta.api` list on generation entries in `/v1/models`, so clients can
    tell what a build supports.
- **Settings → Image:** a `llama-toolchest` backend kind.
  - It uses the shared Connection section (address, API key, Model dropdown).
  - The dropdown lists toolchest image instances with their state and
    capabilities.
  - It uses image jobs when `meta.api` has them, and falls back to the
    synchronous route otherwise.
  - Ming-Image keeps transparency through the transparent-canvas `init_image`
    recipe.
- **Settings → Music:** a new section with backend `None` or `llama-toolchest`,
  plus Connection, Model, Default length and a Test generation that plays the
  clip. The music kind is a union, so an ACE-Step backend can be added later.
- **Autodetection:** choosing the toolchest kind in Image or Music prefills the
  address and key from the inference server when that server is toolchest.
  When the inference server has image or music instances, Settings → Image or
  Music shows a one-line hint. Nothing turns itself on.
- **The `generate_music` tool** in Chat and the Code tab (not Shell, which has
  no saved session to keep the audio).
  - Params: caption (required), lyrics, duration_seconds, instrumental, bpm,
    key, language, format, title; plus path and overwrite in Code.
  - Duration defaults to 30 s and is clamped to 5–240 s. Format defaults to
    mp3.
  - In Code an optional `path` also saves the file into the project.
- **An audio cache** under `<app_data>/audio/`, content-addressed and linked to
  the chat conversation or Code session that made it.
  - Served as `haruspex-audio://` to the webview and as `/api/v1/audio/<hash>`
    to the web client.
  - The CSP `media-src` and DOMPurify allow it.
- **Inline audio players:**
  - `![title](haruspex-audio:…)` in an answer renders as an `<audio>` player;
  - a safety net appends audio the model forgot (Chat only, as with images;
    in Code the step card always plays it);
  - the `generate_music` step card shows a compact player.
  - All of this works in both Chat and Code.
- Progress for both tools reports a phase, and the queue position while
  queued. Cancelling a turn cancels the toolchest job.

## Non-goals
- Starting, stopping, measuring or installing toolchest instances or model sets
  from Haruspex. That stays in toolchest's UI, and Haruspex links to it.
- Image editing (`/v1/images/edits`, FLUX.2 klein's `edit` capability). It is
  filed as a cross-backend follow-up issue.
- A generic OpenAI-images backend, and a stock ACE-Step (`/release_task`)
  backend.
- A music job type, and music or sfx in the asset generation job. The latter is
  filed as a follow-up issue.
- Step-count progress bars (needs sd-server and ace-server to report steps).
- Playing audio files opened from the Code tab's file tree.
- Persisting toolchest jobs across toolchest restarts, a list endpoint, or hard
  delete.
- Seamless tiling through toolchest. It has the same sd-server limit as
  Lemonade: the extras block crashes over about 24 KB.

## Users & primary flow
Tim, or anyone running a llama-toolchest server with generation enabled.

1. In Settings → Image, choose **llama-toolchest**. The address and key are
   prefilled from the inference server if it is toolchest. Probe lists the
   image instances (e.g. `qwen-turbo-local — running`); pick one.
2. In Settings → Music, choose **llama-toolchest**, pick an ACE instance and
   run a 10 s Test generation, which plays inline.
3. In Chat: "make me a lo-fi track about rain, 45 seconds".
   - The model calls `generate_music`.
   - The step card shows `Queued (2 ahead)`, then `Composing…`, then
     `Synthesizing…`.
   - The mp3 is downloaded into the audio cache, and the answer shows a player.
4. In Code: "add background music to the game at assets/bgm.mp3". The tool also
   writes the file into the project, and the step card plays it.
5. `generate_image` against toolchest shows the same phase lines through image
   jobs. On an older toolchest build it uses the synchronous route with a plain
   "Generating…" line.

## Constraints
- **Stack:** Tauri 2 / Rust and SvelteKit 5 runes, following the repo
  conventions:
  - `#lib/...` imports with extensions;
  - camelCase file names, kebab-case tool modules;
  - tabs and single quotes;
  - domain-first command names (`audio_store_url`, `toolchest_json`);
  - `./scripts/export-ipc-types.sh` after IPC changes;
  - the Guide check;
  - pages under 6 KB.
- **Toolchest API constraints:**
  - Bearer auth on `/v1/*` only. Haruspex never calls `/api/*`, which needs
    Basic Auth in secure mode.
  - Jobs live in memory for 24 h.
  - The per-GPU queue holds up to 16 jobs; `429` comes with `Retry-After`.
  - An instance must already be running.
- **Image-server HTTP** goes through `comfy.rs`'s client (no proxy, no
  `Origin`) as a new `ImageServer`. The key is read from the named-key store
  (`apikey:<id>`, chosen with ApiKeyPicker) and sent inline. Music reuses the
  same client.
- **Toolchest is first-class but not the majority path:**
  - everything is off by default;
  - `None` is the music default;
  - nothing changes for users who don't pick it.
- **The servers come and go** while Tim re-deploys (compute2:3000,
  asmodean:3000):
  - an unreachable server is a normal probe result, not an error state;
  - tests use recorded fixtures.
- Licence and commercial-use fields stay first-class. Toolchest's `recipe` maps
  to Haruspex's catalogue where it can (Ming = MIT, Qwen-Image = non-commercial).

## Success criteria
- **Toolchest:**
  - `POST /v1/images/jobs` returns 202.
  - `GET` shows `phase` and `queue_position`; when the job is done, `/image`
    returns a PNG.
  - `DELETE` cancels a queued job.
  - `/v1/models` generation entries carry `meta.api`.
  - Toolchest's Go tests pass.
- **Settings → Image → llama-toolchest:**
  - Probe lists instances from compute2 or asmodean with their state.
  - Test generation produces an image through image jobs, with phase progress.
  - Against a build without `images.jobs` it still works through the
    synchronous route.
- **Settings → Music → llama-toolchest:** Test generation produces a clip that
  plays inline.
- **Chat:**
  - `generate_music` returns a playable player in the answer, and it still
    plays after an app restart, served from the audio cache.
  - Cancelling the turn sends `DELETE` to the job.
- **Code:** `generate_music` with `path` writes the mp3 into the project, and
  the step card plays it.
- **Web client:** the remote-control page plays the same audio.
- **Off by default:** with nothing configured, no music tool is offered, and
  Settings → Image and Music behave as before.
- **Repo checks:** `npm run check`, `lint`, `test`, `cargo test`, `clippy`,
  `fmt` and the IPC drift check all pass.
- **Docs:**
  - the Guide pages `images` and the new `music` describe it;
  - the `settings` page is updated, which also fixes its stale Image section;
  - `docs/image-generation.md` has a toolchest section.

## Decisions
- **Image backend framing** → A dedicated `llama-toolchest` kind reads
  `/v1/models` meta; the adapter speaks plain OpenAI images underneath.
- **Music API** → Toolchest `/v1/music/jobs`. Settings → Music offers None and
  llama-toolchest, and the kind can be extended for an ACE-Step backend later.
- **Synchronous images** → Add async image jobs to toolchest. Haruspex uses
  them when detected and falls back to the synchronous route.
- **Job progress** → Phase plus queue position on both job APIs (no step
  counts).
- **Autodetection** → Prefill the address and key from a toolchest inference
  server, and show an "available on <host>" hint. Never auto-enable.
- **Model management** → Haruspex picks an instance and shows its status and
  capabilities. Starting instances and installing model sets stay in toolchest,
  with a link to it. `/v1` only.
- **Music tool shape** → A single `generate_music` in Chat and Code, with an
  optional `path` to save into the project in Code.
- **Shell** → No `generate_music` in Shell; a Shell session has no saved
  conversation, so its audio would be swept within the hour.
- **Audio storage** → A new content-addressed audio cache with a
  `haruspex-audio://` scheme and a web-client route, not a generalised
  `image_cache`.
- **Playback surfaces** → Players in the answer through markdown, a safety net
  for audio the model leaves out, and a player on the tool step card, in Chat
  and Code. No players for project files.
- **Image editing** → Out of scope; becomes a cross-backend follow-up issue.
- **Detecting image jobs** → A `meta.api` list on `/v1/models` generation
  entries.
- **Music beyond the tool** → The tool only. Asset-job music becomes a
  follow-up issue.
- **Default duration** → 30 s, clamped to 5–240 s, mp3 by default. Settings →
  Music → Default length overrides it.
- **Where toolchest work is planned** → Phase 1 of this plan, against
  `/home/tim/Projects/llama-toolchest`.
