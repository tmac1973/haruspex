# Phase 01 — Video model entries and migration

**Depends on:** nothing · **Enables:** every later phase (they all read `videoModels`)

## Goal

Add the data model: `videoModels: VideoModelEntry[]` in settings, built from
the old `videoGen*` fields on load, with the same list helpers image has. Add
`VideoCaps`, the one shape every backend reports, and widen `VideoJobHandle` so
a handle names its entry and backend. Nothing reads the list yet, so behaviour
is unchanged.

## Files touched

- `src/lib/videogen/types.ts` — add `VideoBackendKind`, `VideoCaps`,
  `VideoModelEntry`; widen `VideoJobHandle`.
- `src/lib/videogen/fields.ts` (new) — `LEGACY_VIDEO_FIELDS`, `videoModelsFromFields`.
- `src/lib/videogen/entries.ts` (new) — list helpers.
- `src/lib/videogen/fields.test.ts`, `src/lib/videogen/entries.test.ts` (new).
- `src/lib/stores/settings.ts` — `videoModels?` field, doc comment, load migration.
- `src/lib/stores/settings.test.ts` — migration cases.
- `src/lib/components/settings/VideoGenSection.svelte` — its setters also rewrite `videoModels`.

## Steps

1. In `types.ts`:
   - `export type VideoBackendKind = 'llama-toolchest' | 'comfyui';`
   - `VideoCaps`:
     `{ text: boolean; startImage: boolean; endImage: boolean; speech: boolean; needsSpeech: boolean; sound: boolean; limits: VideoLimits; frameStep: number; licence: string | null; commercialUse: boolean | null }`.
     `needsSpeech` is true for a model that can't make a clip without speech (Wan 2.2 S2V).
     `VideoLimits` is the type from `#lib/toolchest/models.ts`; `frameStep` is 4 for Wan
     (4n+1 frames) and 8 for LTX (8n+1).
   - `export type VideoModelEntry = GenerationEntry<VideoBackendKind, VideoCaps>;`
   - `VideoJobHandle` becomes
     `{ backend: VideoBackendKind; baseUrl; id; model; keyId; entryId?: string; extra?: Record<string, string> }`.
     A handle saved before this change has `backend: 'llama-toolchest'` and no
     `entryId`, so it still type-checks and still resumes.
2. `fields.ts` (reads no settings, so the store can import it, as `image/fields.ts` does):
   - `LEGACY_VIDEO_ENTRY_ID = 'legacy'`.
   - `videoModelsFromFields(s, previous = [])`: `videoGenBackendKind === 'none'` → `[]`;
     otherwise one entry `{ id: 'legacy', backend: 'llama-toolchest', url: videoGenToolchestBaseUrl, keyId: videoGenToolchestApiKeyId, model: videoGenToolchestModelId, options: {}, caps: null, capsAt: null, renamed: false }`,
     named `defaultVideoName(model)` (the instance id, or "Video model" when empty).
   - `VIDEO_BACKEND_LABEL = { 'llama-toolchest': 'llama-toolchest', comfyui: 'ComfyUI' }`.
3. `entries.ts`, mirroring `src/lib/image/entries.ts` function for function:
   `videoEntries`, `firstVideoEntry`, `videoEntryNames`, `videoEntryById`,
   `addVideoModel(backend, fill)`, `updateVideoModel(id, patch)` (clears caps on a
   config change, renames an un-`renamed` entry on a new model),
   `renameVideoModel`, `moveVideoModel(id, ±1)`, `removeVideoModel`,
   `saveVideoCaps(id, caps)`, `videoEntryApiKey(e)` (`toolchestKeyFor(e.keyId)` or `''`; no
   legacy key migration is needed, since video keys were always named keys),
   `videoEntryForHandle(handle)` (the saved entry with that `entryId` and the
   same `backend`; else an entry built from the handle, with `backend:
   handle.backend`, `url: baseUrl`, `keyId`, `model` and `options` from `extra`,
   so a job resumes on the server and backend it went to even after its entry
   was removed or changed; a handle saved before this project has
   `backend: 'llama-toolchest'`). Use `uniqueName` from `#lib/generation/entry.ts` for new names.
4. In `settings.ts`: add `videoModels?: VideoModelEntry[]` next to `imageModels`
   with a doc comment, and in the load path beside line 1598:
   `videoModels: Array.isArray(rest.videoModels) ? rest.videoModels : videoModelsFromFields({ ...defaults, ...rest })`.
   Keep the four `videoGen*` fields and their defaults: they are the
   migration source, as the legacy image fields are.
5. Keep the old section and the list in step until phase 04 replaces the
   section: each place in `src/lib/components/settings/VideoGenSection.svelte`
   that writes a `videoGen*` field also writes
   `videoModels: videoModelsFromFields({ ...getSettings(), ...patch }, videoEntries())`
   in the same `updateSettings` call, where `patch` is the `videoGen*` change
   being written, so the entry has the new values, not the old ones. Phase 04 removes these writes with the old section.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan

- `fields.test.ts`: `none` → `[]`; a toolchest config → one entry with the
  fields copied; `previous` keeps a renamed name and caps whose config key is
  unchanged.
- `entries.test.ts`: add, update clears caps, rename, move at both ends,
  remove, `saveVideoCaps` no-op on equal caps, `videoEntryForHandle` for a
  saved id, an unknown id, a `comfyui` handle whose entry was removed (it
  builds a `comfyui` entry), and an old handle with no `entryId`.
- `settings.test.ts`: a blob with only `videoGen*` keys loads with one
  `videoModels` entry; a blob with `videoModels: []` stays empty.

## Commit

`feat(videogen): video model entries, migrated from the single toolchest setting`

## Rollback

Revert the commit. `videoModels` in a saved settings file is ignored by older
code, and the `videoGen*` fields were never removed, so the old build still
works on a file the new one wrote.
