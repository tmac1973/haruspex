# Phase 27 — Install the models into ComfyUI

**Depends on:** 19 (the catalogue), 26 · **Enables:** 25.

## Goal

From Settings → Image, one button puts the files a model needs into the
user's ComfyUI: the diffusion model, its text encoder and its VAE.

## Three routes, tried in order

1. **Direct, for a ComfyUI on this machine.** `GET /internal/folder_paths`
   names each model folder. When the base URL is loopback and the first
   folder of each kind exists here and is writable, Haruspex downloads into
   it through `ModelManager::download_file`: progress, resume, the app's
   proxy setting, SHA-256 checked against the catalogue.
2. **ComfyUI-Manager**, for any server that runs it. Manager 4 ships with
   ComfyUI (`--enable-manager`); older installs have it as a custom node.
   - Detect: `GET /v2/manager/version`, then the legacy
     `GET /manager/version`.
   - Install: `POST /v2/manager/queue/install_model` per file (`name`,
     `type`, `save_path`, `url`, `filename`, `client_id`, `ui_id`), then
     `POST /v2/manager/queue/start`; follow `queue/status` and
     `queue/history` until each `ui_id` settles.
   - Gate: installing a model is Manager risk level `middle+`. At its default
     `normal` security that is allowed when ComfyUI listens on loopback, or
     when Manager's `network_mode` is `personal_cloud`; otherwise it fails
     with 403. The 403 is reported with the fix ("set network_mode to
     personal_cloud in ComfyUI-Manager's config"), not as a failure to
     reach.
   - Manager reports no byte progress; the row shows the file it is on.
3. **By hand.** Neither available: the row lists each missing file with its
   folder, size and link, and a button that copies them.

After any route, Probe runs again; the model appears in the dropdown when
ComfyUI's loader lists it.

## Files touched

- `src-tauri/src/comfy.rs` — `comfy_model_folders`, the direct download
  (reusing `download_file` with a target directory), Manager calls.
- `src/lib/image/comfyui/provision.ts` (new) — what is missing for a family
  (from the catalogue and the probe's loader lists), route choice, progress.
- `src/lib/components/settings/ImageSection.svelte` — under the model row:
  what is missing, the button, progress. One short sentence; detail in the
  tooltip.
- `docs/image-generation.md`.

## Steps

1. Missing files: catalogue entry files against `/object_info` loader lists
   (by filename, as `resolveCompanions` already matches).
2. Route choice, as above. A user can force the Manager route from the
   tooltip menu if the direct one is wrong (a ComfyUI in a container on
   loopback whose folders happen to exist here).
3. Direct download into ComfyUI's folders; partial files beside the target
   as `.partial`, never under ComfyUI's own name until verified.
4. Manager install, both API generations, with the 403 explained.
5. By-hand list.
6. Qwen-Image-2.1 goes through the existing non-commercial confirmation
   before any route starts.

## Test plan

- Missing-file computation per family from fixtures of `/object_info`.
- Route choice: loopback with writable folders → direct; remote with Manager
  → Manager; neither → by hand.
- Direct: a stub server's `/internal/folder_paths` pointing at a temp dir; a
  file lands there, verified, no `.partial` left behind; a bad hash is
  removed and reported.
- Manager: stubbed v2 and legacy routes; a 403 gives the network-mode
  message.
- Live: delete the Ming VAE from this ComfyUI and install it by each route
  (Manager via `--enable-manager`).

## Commit

```
feat(image): install a model's files into the user's ComfyUI
```
