# Video generation backends — Project Overview

## Problem

Settings → Video generation keeps one llama-toolchest server and one video
instance (`videoGenBackendKind`, `videoGenToolchestBaseUrl`,
`videoGenToolchestApiKeyId`, `videoGenToolchestModelId`). Each instance can do
different things: LTX-2.3 makes sound, the Wan 2.2 lightning instance can end
on a picture, Wan 2.2 S2V makes a person speak. `generate_video` refuses a
request the chosen instance can't do, so a user who wants speech in one clip
and an end frame in the next has to change the setting between them.

Video generation also works only with llama-toolchest. Most users don't run
it. Many of them run ComfyUI, which Haruspex already supports for images.
These users can't generate video at all.

## Goals

- Settings → Video generation keeps a list of video models
  (`videoModels: VideoModelEntry[]`), one model on one server per entry, in an
  order the user sets, the same way Settings → Image keeps `imageModels`.
- `VideoModelEntry` is a `GenerationEntry` (`src/lib/generation/entry.ts`), with
  backend `llama-toolchest` or `comfyui`.
- `generate_video` routes each request to the first entry, in Settings order,
  that can do what the request needs: start image, end image, speech (audio),
  sound. An entry that doesn't answer passes the request to the next one. A
  request that an entry refuses is not tried elsewhere.
- `generate_video` takes an optional `model` argument that names an entry.
- ComfyUI is a video backend, with bundled workflows for four families:
  Wan 2.2 TI2V 5B, Wan 2.2 I2V 14B (with a first-last-frame mode for end
  images), Wan 2.2 S2V, and LTX-2.3 (with sound).
- Settings → Video generation installs a family's files into the user's
  ComfyUI with the same three routes as Settings → Image (direct, ComfyUI-
  Manager, manual list). Licence and commercial use show for each family.
- The video-sequence job's "Video model" select offers "Automatic" (the
  default) and each entry. Automatic picks one entry for the job before it is
  planned: the first that can make clips, preferring one that can end on a
  picture. A clip that entry can't make routes on its own, and the job says so.
- Existing settings migrate on load with no action from the user: one
  toolchest server and instance become one entry. A saved job's
  `video_instance_id` maps to the entry for that instance.
- Settings → Image and Settings → Video generation share one list component
  (order, reorder, remove, open editor), so music can use it later. The video
  entry editor is its own component, built from the server widgets image
  already uses (`ServerAddress`, `ApiKeyPicker`, `ToolchestModels`, `ComfyModels`).

## Non-goals

- Music generation. It stays one toolchest instance. A later project can give
  it a list with the parts built here.
- Video on the bundled engine. sd-server has no video endpoint, and we don't
  bundle sd.cpp's CLI.
- The user's own ComfyUI video workflows (a workflow file and a field map).
  Only the four bundled families run on ComfyUI.
- Lemonade as a video backend.
- Retrying a refused request on another entry.
- Mixing video models inside one clip.

## Users & primary flow

The user runs ComfyUI, llama-toolchest, or both.

1. The user opens Settings → Video generation and adds a video model: picks
   ComfyUI or llama-toolchest, enters the server address and an API key name
   from Settings → Inference → API Keys if it needs one.
2. For ComfyUI, the user picks a diffusion model from the server's list. If
   a family's files are missing, Install in the same block puts them on the
   server, or lists them for a manual copy. For toolchest, the user picks a
   video instance on the server.
3. A probe fills in what the entry can do. The user adds more entries and
   drags them into the order to try.
4. In chat, the user asks for a clip. `generate_video` picks the first entry
   that can do it, or the one the chat model named, and the answer shows
   which model made it.
5. In a video-sequence job, the user leaves "Video model" on Automatic or
   picks an entry. Every clip in the job uses that entry.

## Constraints

- Tauri 2.x + SvelteKit 5 (runes) + TypeScript. Prettier, ESLint and the
  `#lib/...` import rule apply.
- Settings are plain JSON. A `VideoModelEntry` stored through
  `stores/settings.ts` must never be a `$state` proxy.
- A changed Tauri command or `#[ts(export)]` struct means running
  `./scripts/export-ipc-types.sh`.
- A job handle is saved with the task and must resume after a restart, on the
  server it went to, whatever the settings say then.
- Clips stay in the audio cache and are named by a `haruspex-video:` URL.
- ComfyUI is often on another machine (asmodean :8188 in the lab), so the
  direct install route works only on a local server.
- The user guide (`docs/guide/video-generation.md`, `video-sequence.md`) and
  the showcase (`docs/showcase/video.md`) change in the same PR as what they
  describe. Each guide page stays under 6 KB.
- UI copy: one short sentence per section, detail in `title` tooltips,
  Settings paths named in full.
- The 9B default model must still call `generate_video` correctly: the
  `model` argument is optional and routing works without it.

## Success criteria

- A user with only the old toolchest settings opens the app and sees one
  entry in Settings → Video generation that works as before.
- With an LTX-2.3 entry first and a Wan 2.2 S2V entry second, a request with
  speech goes to S2V and a request without it goes to LTX-2.3.
- With a toolchest entry whose server is off and a ComfyUI entry after it, a
  request is made on ComfyUI.
- On a ComfyUI server with none of the files, Install for Wan 2.2 TI2V 5B
  puts them in place, and a clip then generates from a prompt and from a
  start image.
- On ComfyUI, Wan 2.2 I2V 14B makes a clip that ends on the given end image,
  S2V makes a clip as long as its speech, and LTX-2.3 makes a clip with sound.
- A ComfyUI video job survives an app restart and finishes into the cache.
- A video-sequence job on Automatic uses one entry for all clips. An old job
  with `video_instance_id` opens with the matching entry selected.
- `npm run check`, `npm run lint`, `npm run test`, `cargo test` and
  `cargo clippy` pass, and the Guide check passes.

## Decisions

- **Scope** → Video only. Music gets a list in a later project.
- **Backends** → llama-toolchest and ComfyUI. No bundled CLI.
- **ComfyUI families** → Wan 2.2 TI2V 5B, Wan 2.2 I2V 14B, Wan 2.2 S2V and
  LTX-2.3.
- **Installing models** → Reuse Settings → Image's installer (direct,
  ComfyUI-Manager, manual list).
- **Routing** → Like image: first entry in Settings order that can do the
  request, an entry that doesn't answer passes to the next, plus an optional
  `model` argument.
- **Custom ComfyUI video workflows** → Not in this project.
- **Video-sequence jobs** → One model per job, picked once before planning;
  only clips it can't make route elsewhere.
- **Job editor's Video model select** → "Automatic" plus each entry. An old
  `video_instance_id` maps to its entry.
- **How it lands** → One PR for the whole project, one commit per phase.
- **Job editor's Speaking model select** → "Automatic", "None" and each entry
  that can do speech. An old `speaking_instance_id` maps to its entry.
- **Shared ComfyUI code** → Move the client, run loop, field maps and uploads
  to `src/lib/comfyui/`. Image and video both build on it.
- **ComfyUI video limits** → A fixed family table in code. The probe checks
  only that the nodes and files exist.
