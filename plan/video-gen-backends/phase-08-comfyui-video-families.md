# Phase 08 — Wan 2.2 I2V 14B, Wan 2.2 S2V and LTX-2.3 on ComfyUI

**Depends on:** 01, 02, 03, 04, 06, 07 · **Enables:** 09 (their files become installable), 10

## Goal

Add the other three families to the ComfyUI video backend: Wan 2.2 I2V 14B
(start image, and end image through first-last-frame), Wan 2.2 S2V (a start
image and speech, as long as the speech), and LTX-2.3 (with sound).

## Files touched

- `src/lib/videogen/comfyui/templates/wan22_i2v_14b.json`,
  `wan22_flf_14b.json`, `wan22_s2v.json`, `ltx23_t2v.json`, `ltx23_i2v.json` (new).
- `src/lib/videogen/comfyui/templates/index.ts` — the five templates and field maps.
- `src/lib/videogen/comfyui/templates/README.md` — their sources and node classes.
- `src/lib/videogen/comfyui/families.ts` — caps, licence and companions for the three families.
- `src/lib/videogen/comfyui/backend.ts` — template choice per request; audio upload.
- Tests: the same three test files, plus live cases.

## Steps

1. Export each graph on asmodean:8188 from ComfyUI's built-in templates, as
   in phase 07, with SaveVideo (webm) as the output node:
   - Wan 2.2 14B I2V with the lightx2v 4-step LoRAs on both the high-noise and
     low-noise passes (two UNETLoader + LoraLoaderModelOnly, two KSamplerAdvanced, WanImageToVideo).
   - The same with WanFirstLastFrameToVideo in place of WanImageToVideo, for an end image.
   - Wan 2.2 S2V (AudioEncoderLoader, AudioEncoderEncode, LoadAudio, WanSoundImageToVideo).
   - LTX-2.3 text-to-video and image-to-video, with its audio VAE so the clip has sound.
   Record each graph's node classes and the ComfyUI version in the README.
   Where a template is missing or differs:
   - The built-in 14B template has no lightx2v LoRAs: add a
     LoraLoaderModelOnly after each UNETLoader (high-noise LoRA on the
     high-noise model, low-noise on the low-noise), set both samplers to 4 steps
     in total (2 + 2) at CFG 1, run it once, then export.
   - No built-in template for S2V or LTX-2.3: build the graph from the
     workflow on that model's page in the ComfyUI docs (docs.comfy.org,
     Tutorials → Video), run it once, then export.
   - ComfyUI's core has no LTX-2.3 nodes: the graph uses the ComfyUI-LTXVideo
     custom node pack, the README says so, and the probe's missing-node message
     for `ltx23` names that pack ("Install ComfyUI-LTXVideo in ComfyUI-Manager.").
2. `families.ts`: widen `VideoFamily` to
   `'wan22_ti2v_5b' | 'wan22_i2v_14b' | 'wan22_s2v' | 'ltx23'` and add patterns,
   first match wins: `/wan2[._]?2.*i2v.*high[_-]?noise.*14b/i` (the high-noise
   file is the entry's model; the low-noise file matches nothing, so it is never
   offered as a model), `/wan2[._]?2.*s2v/i`, `/ltx[-_]?2[._]?3/i`.
   - `wan22_i2v_14b`: `{ text: false, startImage: true, endImage: true, speech: false, needsSpeech: false, sound: false, frameStep: 4, limits: { defaultSize: '1280x720', defaultFps: 16, fixedFps: 16, defaultFrames: 81, maxFrames: 81, maxSize: '1280x720', maxPixelFrames: null } }`;
     Apache 2.0, commercial use allowed. Companions: the low-noise model (the
     high-noise model's filename with `high` → `low`), `umt5_xxl`, `wan_2.1_vae`,
     and both lightx2v LoRAs in `LoraLoaderModelOnly.lora_name`.
   - `wan22_s2v`: `{ text: false, startImage: true, endImage: false, speech: true, needsSpeech: true, sound: false, frameStep: 4, limits: { defaultSize: '832x480', defaultFps: 16, fixedFps: 16, defaultFrames: 81, maxFrames: 241, maxSize: '1280x720', maxPixelFrames: null } }`;
     Apache 2.0. Companions: `umt5_xxl`, `wan_2.1_vae`, `wav2vec2_large_english` in `AudioEncoderLoader.audio_encoder_name`.
   - `ltx23`: `{ text: true, startImage: true, endImage: false, speech: false, needsSpeech: false, sound: true, frameStep: 8, limits: { defaultSize: '1280x704', defaultFps: 24, fixedFps: null, defaultFrames: 121, maxFrames: 241, maxSize: '1920x1088', maxPixelFrames: null } }`;
     licence "LTX-2 Community License", `commercialUse: false` (it allows
     commercial use only under a revenue threshold, which the licence line names).
     Companions: the text encoder matching `/gemma[-_]?3/i` and the audio VAE
     matching `/ltx.*audio.*vae/i`, each read from the file input of the loader
     node that loads it in the exported graph (the class and input name go into
     `WANTED.ltx23` as written in the JSON).
   - Run each family once on asmodean at its default size and length, and
     record its peak VRAM (`rocm-smi --showmeminfo vram` or `nvidia-smi`, read
     during the sampler) and peak system RAM in the README; phase 09 copies them
     into the install sets. If a run runs out of memory, drop the size one step
     (Wan 14B and S2V to 832×480, LTX-2.3 to 960×544), then
     drop frames by `4 × frameStep` at a time (16 for Wan, 32 for LTX), keeping
     the count at `frameStep × n + 1`, until it runs, and write
     what ran into the table as both the default and the maximum.
3. `backend.ts`:
   - Template choice: `wan22_i2v_14b` → FLF graph when `req.endImage`, else I2V;
     `ltx23` → I2V graph when `req.startImage`, else T2V.
   - `req.audio` (speech) is uploaded from the audio cache (`cache: 'audio'`) and bound to LoadAudio.
     With `req.followAudio`, the frame count is set from the speech length
     (rounded up to `4n+1`, capped at `maxFrames`) instead of being left out,
     since the graph needs a number.
   - A request the family can't do (end image on 5B, speech off S2V) cannot reach
     the backend, because routing checks caps; the backend still refuses it with
     `rejected` as a guard.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan

- `templates.test.ts`: every new field map binds to existing nodes.
- `backend.test.ts`: the FLF graph is chosen only with an end image; LTX T2V vs
  I2V; S2V uploads the audio and sets frames from its length.
- `live.test.ts` (opt-in): a 14B clip that ends on the given picture; an S2V
  clip as long as a 3-second speech file; an LTX-2.3 clip whose `hasAudio` is true.
- By hand: entries LTX-2.3 (ComfyUI) first and S2V (ComfyUI) second; a speech
  request goes to S2V and a plain one to LTX.

## Commit

`feat(videogen): Wan 2.2 14B, S2V and LTX-2.3 on ComfyUI`

## Rollback

Revert the commit. Phase 07's patterns match only Wan 5B, so entries with
these models then probe as an unknown file (`unconfigured`) and are passed
over; Wan 5B entries keep working.
