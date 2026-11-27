# Phase 06 — A shared ComfyUI client in src/lib/comfyui/

**Depends on:** nothing (it can land at any point before 07) · **Enables:** 07, 08, 09

## Goal

Move the parts of ComfyUI support that are not about pictures into
`src/lib/comfyui/`, typed on neutral types, so a video backend builds on them
without importing from `#lib/image/`. Add what video needs: outputs read by
key, a deadline per call, and saving an output straight into the audio cache.
Image generation behaves exactly as before.

## Files touched

- `src/lib/comfyui/client.ts` (moved from `src/lib/image/comfyui/client.ts`).
- `src/lib/comfyui/run.ts` (moved from `src/lib/image/comfyui/run.ts`).
- `src/lib/comfyui/fieldMap.ts` (moved from `src/lib/image/comfyui/fieldMap.ts`).
- `src/lib/comfyui/upload.ts` (moved from `src/lib/image/comfyui/upload.ts`).
- `src/lib/comfyui/errors.ts` (new) — `ComfyError`.
- `src/lib/comfyui/nodes.ts` (new) — `optionsOf`, `pickCompanion`, `listDiffusionModels`, moved from image's `families.ts`.
- `src/lib/image/comfyui/backend.ts`, `families.ts`, `provision.ts`,
  `upscale.ts`, `templates/index.ts` — import from `#lib/comfyui/…`; map `ComfyError` to `ImageBackendError`.
- The moved tests (`client.test.ts`, `client.rust.test.ts`, `run.test.ts`,
  `fieldMap.test.ts`) move with their sources. `git mv` keeps their history.

## Steps

1. `git mv` the four sources and their tests. Fix imports across
   `src/lib/image/comfyui/` and anything else `grep -rn "image/comfyui/(client|run|fieldMap|upload)"` finds.
2. `errors.ts`: `ComfyError extends Error { kind: 'unreachable' | 'rejected' | 'cancelled' | 'unconfigured'; status? }`.
   The moved code throws `ComfyError`. `src/lib/image/comfyui/backend.ts` wraps
   each call in `toImageError(e)`, which keeps kind, message and status, so
   every error text the image tests check is unchanged.
3. Neutral types in `run.ts`: `RunOptions { signal?; onProgress?(p: ComfyProgress); onSubmitted?(promptId); deadlineMs }`
   and `ComfyProgress { phase: 'queued' | 'running'; ahead?; step?; totalSteps? }`.
   The image backend maps `ComfyProgress` to `ImageProgress` and builds its own
   `ImageJobHandle` in `onSubmitted`.
4. Outputs by key: `history(cfg, promptId, outputNode)` returns
   `ComfyOutputFile[]` (`{ filename, subfolder, type }`) read from the output
   node's `images`, `gifs`, `videos` and `audio` lists, in that order, so both
   the core SaveVideo node and other video savers are found. The "no images"
   error becomes "The workflow's output node produced no files." The image
   path still takes only `images`, so its result is the same.
5. Deadline: `awaitPrompt` takes `deadlineMs`, a required option. Image
   passes `GENERATION_TIMEOUT_MS` (600 000).
6. Cache instead of bytes: `storeOutput(cfg, file, { mimeHint, title, conversationId, codeSessionId })`
   invokes `audio_store_url` with the `/view?filename=…&subfolder=…&type=…` URL
   built from `cfg.baseUrl`, and `cfg.apiKey` as the key (`ClientConfig` already
   carries both, so the client stays entry-neutral). It returns the cache hash. A clip never crosses the IPC
   bridge as bytes. (`audio_store_url` already accepts `video/webm` and
   `video/mp4`, uses the LAN client and caps a file at 50 MiB.)
7. Node lists: move `optionsOf`, `pickCompanion` and `listDiffusionModels`
   from `src/lib/image/comfyui/families.ts` to `src/lib/comfyui/nodes.ts`.
   Image's `families.ts` imports them from there; video uses them in phase 07.
8. Upload from either cache: `upload.ts` takes `cache: 'image' | 'audio'`,
   passed through to the `comfy_upload` IPC, which already supports both.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.
`cargo test` is not needed: no Rust changes.

## Test plan

- All image ComfyUI tests pass with only import changes: `backend.test.ts`,
  `backend.edit.test.ts`, `backend.upscale.test.ts`, `families.test.ts`,
  `provision.test.ts`, `templates/templates.test.ts`, and the moved tests.
- New `client.test.ts` cases: outputs under `gifs` and `videos` are found;
  an output node with nothing gives the new error.
- New `run.test.ts` case: a custom `deadlineMs` is honoured.
- The opt-in live image test (`live.test.ts`) against asmodean:8188 still draws.

## Commit

`refactor(comfyui): share the ComfyUI client between image and video`

## Rollback

Revert the commit. It is a move plus additive options; no stored data changes.
