# Phase 04 — Settings → Video generation as a list

**Depends on:** 01, 02, 03 · **Enables:** 07 and 09 (the ComfyUI entry editor adds to this editor)

## Goal

Settings → Video generation shows the video models as an ordered list with an
editor per entry, like Settings → Image. The list, reorder, remove, one-open
and caps-line behaviour moves into one shared component that both sections use.

## Files touched

- `src/lib/components/settings/GenerationModelList.svelte` (new) — the shared list.
- `src/lib/components/settings/ImageSection.svelte` — uses it; image-specific
  engine status and stop stay here.
- `src/lib/components/settings/VideoGenSection.svelte` — rewritten around the list.
- `src/lib/components/settings/VideoEntryEditor.svelte` (new) — one video entry.
- `src/lib/videogen/capabilityLine.ts` (new) — one line from `VideoCaps`.
- `src/lib/components/settings/ImageSection.test.ts` — unchanged cases still pass.
- `src/lib/components/settings/VideoGenSection.test.ts` (new).

## Steps

1. `GenerationModelList.svelte`, props:
   `{ entries: GenerationEntry<string, unknown>[]; place(e): string; capsLine(e): string; onMove(id, d); onRemove(e); onAdd(); editor: Snippet<[entry]>; addLabel: string }`.
   It owns `openId`, renders the `<ol>` with name toggle, ↑/↓ (disabled at the
   ends), Remove, the caps line or "Not probed yet.", the open editor through
   the snippet, and the Add button. Move this markup out of
   `ImageSection.svelte:70-131` without changing its text or classes, so
   `ImageSection.test.ts` passes as is.
2. `ImageSection.svelte` passes its own `place`, `capabilityLine`, move, remove
   (with the `image_engine_stop` rule) and the `ImageEntryEditor` snippet.
3. `VideoEntryEditor.svelte`, props `{ entry: VideoModelEntry; onChange }`:
   - Name field (`renameVideoModel`), Backend select listing the registered
     kinds by `VIDEO_BACKEND_LABEL` (only llama-toolchest until phase 07).
   - Toolchest server block, moved from today's `VideoGenSection.svelte:135-196`:
     `ServerAddress kind="llama-toolchest"`, `ApiKeyPicker`, the model select from
     `withSavedModel(entry.model, models)`, Probe with its detail, the limits line,
     and `ToolchestModels kind="video"`.
   - Probe and model list come from this entry's own backend:
     `videoBackendForEntry(entry).probe()` and `.models()`, never the
     single-instance helpers in `toolchest.ts`, so a second entry probes its own
     server. The limits line reads the entry's saved `caps.limits`.
   - Probe on open; on `ok`, `saveVideoCaps` and `rememberServer`. With one video
     instance on the server and no model chosen, choose it (today's behaviour).
   - Every value passed to `updateVideoModel` is plain JSON, never `$state`.
4. `VideoGenSection.svelte`: one sentence of copy, the shared list, and Add.
   Add uses `addVideoModel('llama-toolchest', prefillFromInference('video'))`
   and opens the new entry. Remove the None/llama-toolchest kind select:
   an empty list means off. Keep `toolchestHint('video')`. Phase 01's
   `videoGen*` writes go with the old markup; nothing writes those fields now.
5. `capabilityLine.ts`: e.g. "From a prompt or picture · ends on a picture ·
   speech · with sound · up to 5 s at 1280×704". Detail goes in a `title`.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan

- `VideoGenSection.test.ts`: the migrated entry shows; Add opens a new toolchest
  entry; ↑/↓ reorders and the stored order matches; Remove empties the list and
  `generate_video` is no longer offered; a probe fills the caps line.
- `ImageSection.test.ts` passes without edits.
- By hand in `npm run tauri dev`: two toolchest entries on compute2 (a Wan and
  an LTX instance), reorder them, and check the order survives a restart.

## Commit

`feat(settings): video generation keeps a list of video models`

## Rollback

Revert the commit. The old section comes back with phase 01's writes, so it
works again on the first entry. Editing it then rebuilds `videoModels` from the
`videoGen*` fields, which keeps only one entry: any extra entries added since
phase 04 are dropped at the first edit.
