# Phase 07 — ComfyUI video backend, with Wan 2.2 TI2V 5B

**Depends on:** 01, 02, 03, 04, 06 · **Enables:** 08 (more families on the same backend), 09 (install)

## Goal

A `comfyui` video entry generates clips. This phase builds the backend and its
family table, and ships the first family, Wan 2.2 TI2V 5B (a prompt or a start
image, no sound). The entry editor gets a ComfyUI server block. The files must
already be on the server; Install comes in phase 09.

## Files touched

- `src/lib/videogen/comfyui/families.ts` (new) — video family table.
- `src/lib/videogen/comfyui/backend.ts` (new) — `comfyVideoFor(entry)`.
- `src/lib/videogen/comfyui/templates/wan22_ti2v_5b.json` (new) — API-format graph.
- `src/lib/videogen/comfyui/templates/index.ts` (new) — templates and their field maps.
- `src/lib/videogen/comfyui/templates/README.md` (new) — where each graph came from and how to re-export it.
- `src/lib/videogen/index.ts` — import the ComfyUI backend so it registers.
- `src/lib/videogen/types.ts` — `VIDEO_TIMEOUT_MS`.
- `src/lib/components/settings/VideoEntryEditor.svelte` — ComfyUI server block.
- Tests: `families.test.ts`, `backend.test.ts`, `templates/templates.test.ts`;
  `live.test.ts` (opt-in, like the image one).

## Steps

1. Build the template on a real server: in ComfyUI on asmodean:8188, open the
   built-in "Wan 2.2 5B video" template, set its save node to SaveVideo with
   format webm, export it in API format, and save it as `wan22_ti2v_5b.json`.
   Read `/object_info` there and record in the README the core node classes
   it uses (UNETLoader, CLIPLoader with type `wan`, VAELoader, CLIPTextEncode,
   Wan22ImageToVideoLatent, KSampler, VAEDecode, CreateVideo, SaveVideo) and
   the ComfyUI version.
2. `families.ts`:
   - `VideoFamily = 'wan22_ti2v_5b'`. Phase 08 widens the union and every
     table below; each table is a `Record<VideoFamily, …>`, so the compiler
     makes phase 08 fill in all of them.
   - `FAMILY_PATTERNS` on the diffusion model filename, first match wins:
     `/wan2[._]?2.*ti2v.*5b/i` only. Other video files on the server match no
     family, are left out of `listVideoModels`, and an entry saved with one
     probes as `unconfigured` ("<file> is not a video model Haruspex can run.").
   - `FAMILY_CAPS[family]`: the `VideoCaps` without licence. Wan 2.2 TI2V 5B:
     `{ text: true, startImage: true, endImage: false, speech: false, needsSpeech: false, sound: false, frameStep: 4, limits: { defaultSize: '1280x704', defaultFps: 24, fixedFps: 24, defaultFrames: 121, maxFrames: 121, maxSize: '1280x704', maxPixelFrames: null } }`.
   - `FAMILY_LICENCE[family]`: Wan 2.2 is Apache 2.0, commercial use allowed.
   - `WANTED[family]`: companion regexes, read through `optionsOf` on the
     loader nodes the template uses (as `src/lib/image/comfyui/families.ts` does):
     Wan 5B wants `umt5_xxl` in `CLIPLoader.clip_name` and `wan2.2_vae` in `VAELoader.vae_name`.
   - `listVideoModels(cfg)`: `UNETLoader.unet_name` values that match a family.
3. `backend.ts`, `comfyVideoFor(entry)`:
   - `entry.model` is the diffusion model filename; `familyOf(entry.model)` picks the family.
   - `probe()` always returns `models` (`listVideoModels`) once `systemStats`
     answers, so a new entry can pick its first model. With `entry.model` empty
     it stops there: `{ ok: false, detail: 'Choose a video model.', models }`.
     With a model that matches no family: `{ ok: false, detail: '<file> is not a video model Haruspex can run.', models }`.
     Otherwise: `systemStats`, then the family's node classes exist in
     `/object_info` (missing → `unconfigured`, "This ComfyUI has no <class> node;
     update ComfyUI."), then the model and companions exist (missing →
     `unconfigured`, "Missing on the server: <files>."; phase 09 adds the Install sentence).
     `models` in the result lists `listVideoModels`.
   - `capabilities()`: `FAMILY_CAPS` plus licence. No server call beyond the probe.
   - `generate(req, opts)`: upload `startImage` from the image cache, apply the
     field map (prompt, negative prompt, seed, width, height, frames, fps, model,
     companions, start image), set the SaveVideo `filename_prefix` to
     `haruspex/<clientId>`, run with `deadlineMs: VIDEO_TIMEOUT_MS` (3 600 000),
     with `VIDEO_TIMEOUT_MS = 3_600_000` defined in `src/lib/videogen/types.ts`,
   then `storeOutput` the first output file into the audio cache and return
     the `VideoResult` (`model: entry.name`, `hasAudio` from `clipHasAudio`).
     Progress maps `queued`/`running` to `VideoProgress` `queued`/`generating`.
   - Handle: `{ backend: 'comfyui', baseUrl: entry.url, id: promptId, model: entry.model, keyId: entry.keyId ?? '', extra: { clientId, outputNode } }`.
   - `resume(handle, req, opts)`: `resumePrompt` from `#lib/comfyui/run.ts`,
     then the same store step. A prompt the server no longer knows throws
     `rejected` with status 404, so the follower reports a lost job.
   - Every call into `#lib/comfyui/` is wrapped in `toVideoError(e)`, which turns a
     `ComfyError` into a `VideoBackendError` with the same kind, message and
     status, so a ComfyUI server that is off is `unreachable` and routing passes
     over it.
   - Register with `registerVideoBackendKind('comfyui', comfyVideoFor)`.
4. `VideoEntryEditor.svelte`: Backend select now offers ComfyUI. Its block:
   `ServerAddress kind="comfyui"`, `ApiKeyPicker`, the model select from the
   probe's `models` (`withSavedModel`), Probe with its detail, the caps line,
   and the family's licence line ("Apache 2.0 · commercial use allowed").

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan

- `families.test.ts`: each real filename maps to its family; an unknown file
  maps to none and is left out of `listVideoModels`.
- `templates.test.ts`: every field map binds to nodes that exist in its graph.
- `backend.test.ts` with a stubbed client: probe reports a missing node class and
  missing files; generate sets frames, fps and size on the right nodes and
  stores the output through `audio_store_url`; resume of a lost prompt gives 404.
- `live.test.ts` (opt-in, `COMFY_URL=http://asmodean…:8188`): a 2-second
  prompt-only clip and a start-image clip, both stored and playable.
- During a full-length live run at the default size, record Wan 5B's peak VRAM
  (`rocm-smi --showmeminfo vram` or `nvidia-smi`, read during the sampler) and
  peak system RAM in `templates/README.md`. If the run runs out of memory, drop
  the size to 960×544, then frames by 16 at a time (keeping `4n + 1`) until it runs, and write what
  ran into `FAMILY_CAPS` as both the default and the maximum.
- By hand: a ComfyUI entry below a toolchest entry, toolchest off → the clip is made on ComfyUI.
- By hand: restart the app during a ComfyUI clip; it finishes into the cache.

## Commit

`feat(videogen): ComfyUI video backend with Wan 2.2 TI2V 5B`

## Rollback

Revert the commit. A saved `comfyui` entry then has no registered kind:
routing treats it as `unconfigured` and passes over it, so other entries keep working.
