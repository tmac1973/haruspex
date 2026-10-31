# Phase 03 — Entries saved in settings, with migration

**Depends on:** 02 · **Enables:** 04 (routing reads the saved list), 05 (the list
UI edits it).

## Goal
Settings hold `imageModels: ImageModelEntry[]`. On load, a user's single
backend becomes entry 1, and the ComfyUI and Lemonade key secrets become named
keys. Every reader that used `imageBackendKind` and its fields now reads the
list. Settings → Image keeps its current screen but edits entry 1, and a
successful probe saves the entry's capabilities. Users see no difference yet;
the list can hold one entry.

## Files touched
- `src/lib/stores/settings.ts` — `imageModels` field (default `[]`);
  `seedImageModels(rest)` in `load()`; `imageModels()` getter and
  `setImageModels(list)` / `updateImageModel(id, patch)` setters (plain JSON,
  snapshotted); the old fields stay in the type and the blob, read only by
  the seed.
- `src/lib/stores/apiKeySecrets.ts` — `migrateImageKeys()`: for each entry
  whose backend is ComfyUI or Lemonade and `keyId` is null, read the
  `comfy:key` / `lemonade:key` secret; if set, `addStoredApiKey('ComfyUI' |
  'Lemonade', value)` and save the new id on every entry of that backend. The
  old secrets are left in place for one release.
- `src/routes/+layout.svelte` — run `migrateImageKeys()` beside
  `migrateJobApiKeys()`.
- `src/lib/image/legacy.ts` — deleted; `src/lib/image/entries.ts` (new):
  `imageEntries()`, `firstImageEntry()`, `entryById(id)`.
- `src/lib/image/backend.ts` — `resolveImageBackend()` uses `firstImageEntry()`
  (none backend when the list is empty).
- Readers of `imageBackendKind !== 'none'` switch to `imageEntries().length > 0`:
  `agent/tools/registry.ts` (:433, :570), `agent/tools/make-asset.ts`,
  `agent/tools/video-thumbnail.ts`, `skills/needs.ts`, `code/systemPrompt.ts`,
  `stores/settings.ts` (IMAGES block), `guide/status.ts`,
  `lean/pausedIntegrations.ts`, asset-generation `definition.ts`,
  `Editor.svelte`, guided-planning `pipeline.ts`, `LogViewer.svelte` (any
  local entry → engine logs), `shell/boundary.ts` (every entry's port).
- Readers of the per-kind model fields (`forTool.ts` `nonCommercialModel`,
  asset-generation `pipeline.ts` `configuredModelName`, `nativeEdge.ts`) read
  the first entry's `backend` and `model`.
- `src/lib/components/settings/ImageSection.svelte` — reads and writes entry 1
  instead of the per-kind fields; picking a backend on an empty list creates
  entry 1; picking None removes it. The key control is `ApiKeyPicker` for
  every backend; the ComfyUI and Lemonade password fields go.
  `ComfyModels.svelte` takes the entry's url and key as props.
- `src/lib/stores/imageSecrets.ts` — kept, used only by the migration.
- `src-tauri/src/comfy.rs` (`COMFYUI`) and `src-tauri/src/lemonade.rs` —
  `secret: ""`, as toolchest's is, so Rust never falls back to the old secret:
  an entry whose key was cleared sends no key. The secrets stay in the store,
  where a downgraded build still finds them.
- `src/lib/agent/jobs/runner.fixtures.ts` and test mocks — `imageModels`.
- File a GitHub issue "Remove the single-backend image settings": drop the
  old `image*` fields from `AppSettings`, `imageSecrets.ts`, and the
  `comfy:key` / `lemonade:key` secrets, one release after this phase ships.
- `docs/guide/images.md` — "API key" now says it is a named key from
  Settings → Inference → API Keys for every backend.

## Steps
1. `seedImageModels(rest)`: if `rest.imageModels` is an array, keep it.
   Otherwise, if `imageBackendKind` is not `none`, build one entry from the
   kind's fields (ComfyUI: `imageBackendBaseUrl`, `imageComfyCheckpoint`,
   `imageComfyWorkflowPath` → `options.workflowPath`,
   `imageComfyFieldMapPath` → `options.fieldMapPath`; local: `imageLocalModelId`; Lemonade:
   `imageLemonadeBaseUrl`, `imageLemonadeModelId`; toolchest:
   `imageToolchestBaseUrl`, `imageToolchestApiKeyId`, `imageToolchestModelId`).
   Name it `uniqueName(defaultName(entry), host, [])`. `caps: null`. Else `[]`.
2. Never write the old fields again. A downgrade reads them as they were
   before the update, which is the setup it last knew.
3. Probe saves capabilities: after `probe()` answers `ok`, ImageSection calls
   `capabilities()` and `updateImageModel(id, {caps, capsAt: Date.now()})`, and
   sets the name from the model's display name unless `renamed` (Phase 02's
   field) is set; Phase 05's rename sets it. The new name goes through `uniqueName`,
   so two entries never share a name. The seed in step 1 also uses
   `uniqueName`.
4. Before each run, `forTool.ts` already probes; when the live capabilities
   differ from the snapshot, save the new ones (`sameCaps` deep compare).
5. App start: entries with `caps: null` are probed once in the background
   (`void refreshMissingCaps()` in `+layout.svelte`), so a migrated entry gets
   its snapshot without the user opening Settings. A failed probe leaves
   `caps: null`; later phases treat null as "unknown, may try".
6. Ordering: `migrateImageKeys()` exposes a promise `imageKeysReady()`, and
   `backendForEntry`'s wrapper awaits it before any call to a ComfyUI or
   Lemonade server, so no call goes out keyless while the migration runs.
7. Remove `legacy.ts` and point Phase 02's callers at `entries.ts`.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`;
`cargo fmt -- --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test` (from `src-tauri/`).

## Test plan
- `settings.test.ts`: each of the four kinds seeds one entry with the right
  fields; `none` seeds `[]`; an existing `imageModels` is kept as is.
- `apiKeySecrets.test.ts`: `migrateImageKeys` makes one named key per secret,
  sets it on every entry of that backend, and is a no-op the second time.
- `ImageSection.test.ts`: the existing tests pass against entry 1; a probe
  saves `caps`; choosing None empties the list.
- Registry: image tools are offered when the list has an entry and not when it
  is empty.
- Live: start the dev app on a profile with a ComfyUI or toolchest backend set
  and a key; after the update the backend still works and Settings → Inference
  → API Keys lists the migrated key.

## Commit
`feat(image): keep image backends as saved entries`

## Rollback
Revert the commit. The old fields were never rewritten, so the previous build
finds the setup as it was before this update. Named keys made by the migration
stay in the key list; they are harmless and the old secrets are still there.
