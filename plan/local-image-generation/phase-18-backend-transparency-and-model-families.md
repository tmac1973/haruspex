# Phase 18 — Transparency in the backend, and a template per model family

**Depends on:** 17 (steps 1 and 4) · **Enables:** 19, 20, 21, 24.

## Goal

A caller can ask the image backend for a transparent result and get one, from
whichever supported model is configured, without knowing how that model
produces alpha. The ComfyUI backend gains workflows for Ming-Image and
Qwen-Image-2.1; the SDXL workflows and their IP-Adapter plumbing go.

## Why the request changes rather than the job

How a model yields alpha differs per model: Qwen-Image-2.1 wants a fixed
prompt prefix; Ming-Image ignores its documented prefixes and needs sampling
to start from the latent of a transparent canvas (spike, finding 4). That is a
property of the model and the workflow, which is backend knowledge. Putting it
in the asset job would make the job know about latents and denoise values, and
would leave a future image tab or chat image (overview, "future consumers")
unable to ask for a cut-out at all.

## Files touched

- `src/lib/image/types.ts` — `ImageRequest.transparent?: boolean`;
  `ImageBackendCapabilities.transparency: boolean`; remove
  `referenceConditioning` and `referenceStrength` (see step 5).
- `src/lib/image/comfyui/templates/` — add `ming_t2i.json`,
  `ming_t2i_rgba.json`, `qwen21_t2i.json`; delete `reference.json`,
  `seamless_reference.json`; `index.ts` gains a `family` per template.
- `src/lib/image/comfyui/fieldMap.ts` — a binding for the transparent-canvas
  upload and for the shift node's reference size.
- `src/lib/image/comfyui/backend.ts` / `client.ts` — upload the canvas; detect
  the family; resolve a real seed.
- `src/lib/image/local/adapter.ts` — same request field, per phase 24.
- Tests beside each.

## Steps

1. **Request and capability.** `transparent: true` asks for a result whose
   background is alpha 0. `capabilities().transparency` says whether the
   backend can honour it for the configured model. A backend that cannot
   still generates and reports `false`; the caller degrades (phase 20 keys the
   backdrop instead) and says so.
2. **Model family.** The backend decides which workflow to run from the
   configured model's family: `ming`, `qwen21`, or `unknown`. For ComfyUI the
   family comes from the selected diffusion model's filename against a
   pattern per family, because ComfyUI does not report architecture; an
   unmatched name is `unknown` and gets no transparency claim.
3. **Ming workflows.** `ming_t2i` is the stock ComfyUI template's graph,
   flattened from its subgraph (UNETLoader, CLIPLoader `qwen_image`, VAELoader,
   ModelSamplingFlux, BasicScheduler, BasicGuider, SamplerCustomAdvanced,
   VAEDecode, SaveImage). `ming_t2i_rgba` adds LoadImage → JoinImageWithAlpha →
   VAEEncode as the latent, with `denoise` 0.9 on the scheduler. Both set
   ModelSamplingFlux's `max_shift` 1.35 with reference width/height 1024,
   which is the vendor's shift at every size from 1024 up. At 1024 the stock
   template's 1.15 works equally well (48 of 48 singles either way,
   `measurements-phase-17.md` §1); at 2048 only 1.35 gives alpha (spike,
   finding 4), so one value everywhere is simplest. Denoise is a template constant, not a request
   field: a caller has no business tuning it.
4. **The transparent canvas.** A fully transparent PNG at the request's size,
   built in memory and uploaded through `uploadImage`, like the IP-Adapter
   reference was. Name it by size (`haruspex-clear-1024.png`) rather than a
   fresh UUID as the reference uploads did — ComfyUI's input folder already
   holds hundreds of `haruspex-ref-*` files from earlier runs, and one canvas
   per size is all this ever needs.
5. **Remove reference conditioning.** IP-Adapter is UNet-only and has no
   counterpart in either family. Phase 17 measured a Ming reference image as
   a replacement and it made sheets less consistent, not more
   (`measurements-phase-17.md` §3), so nothing replaces it.
6. **Qwen-Image-2.1 workflow.** `qwen21_t2i`: the text encoder pinned to CPU
   (the RGBA VAE decode runs out of memory on 16 GB otherwise; spike, finding
   11). Transparency is the prompt wrapper from the model's template, applied
   by the backend when `transparent` is set.
7. **Seed honesty** (phase 16, step 2, carried over). `seed: null` resolves to
   a random seed in the backend, applied to the graph and echoed in
   `meta.seed`. Pinned seeds pass through untouched.
8. **Keep seamless out of the DiT families.** Neither family tiles by circular
   padding, so both report `seamlessTiling: false`. Phase 23 owns textures.

## Deviations, as built

- **No upload for the transparent canvas.** Step 4 planned to build a PNG in
  memory and upload it. The canvas is built inside the graph instead —
  `EmptyImage` joined with a `SolidMask` of 1.0 — measured byte-identical to
  the uploaded version. No upload path, no files accumulating in ComfyUI's
  input folder. `FieldMap.width`/`height` can now bind several nodes, because
  the image and the mask must take the same size.
- **The SD graphs stay, as the `sd` family.** `txt2img` and `seamless` remain
  for a ComfyUI user who still points at an SD checkpoint — an unmatched
  filename is `sd`, so existing settings keep working. Only the IP-Adapter
  graphs (`reference`, `seamless_reference`) and every reference field went.
  The catalogue's SD entries are phase 19's to remove.
- **Companion files are found, not configured.** A DiT family's text encoder
  and VAE are picked from ComfyUI's own loader lists by filename pattern
  (`families.ts`), preferring the smallest encoder, rather than adding two
  more settings.
- **The workflow follows the requested model**, not only the configured one,
  so a spec that pins a Ming model gets the Ming graph whatever the default
  is. `capabilities()` still answers for the configured model.
- **Qwen-Image-2.1 ran live too**, not only Ming: one transparent sprite came
  back with real alpha through `SaveImage`, text encoder on the CPU, no
  out-of-memory.
- **`reference_strength` left the Rust profile** with the rest of the
  IP-Adapter plumbing; old specs that carry it still load (tested).
- **The single-image default edge is now 1024** (was 512): every supported
  model is trained at 1024 or above.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

## Test plan

- Each new template passes `validateFieldMap`, and every binding it declares
  names a node and input that exist — the existing registry test, extended.
- `transparent: true` on the Ming family selects `ming_t2i_rgba`, uploads a
  canvas of the requested size with every alpha 0, and sets denoise below 1.
  Remove the canvas upload and watch the test fail.
- `transparent: true` on Qwen wraps the prompt exactly once; on `unknown` it
  changes nothing and `transparency` is false.
- `seed: null` → a concrete seed in the graph equal to `meta.seed`; two such
  requests differ; a pinned seed is unchanged.
- The layering tests still pass: nothing under `src/lib/image/` mentions an
  asset, sheet or anchor.
- **Live, env-gated** (`HARUSPEX_IMAGE_E2E=1`): one transparent Ming request
  returns a PNG with more than half its pixels at alpha 0.

## Commit

```
feat(image): ask any supported model for transparency; add Ming and Qwen 2.1 workflows
```

## Rollback

Revert the commit: the SDXL templates return with it. Specs written by a
later phase that rely on transparency degrade to keying, which phase 20 keeps.
