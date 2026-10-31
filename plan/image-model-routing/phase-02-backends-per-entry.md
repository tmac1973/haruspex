# Phase 02 — The entry type and backends bound to an entry

**Depends on:** 01 · **Enables:** 03 (entries saved in settings), 04 (routing
over several entries).

## Goal
Introduce the entry — one model on one server — and make every image backend
work from an entry instead of reading settings. Each kind exports
`forEntry(entry): ImageBackend`. Until Phase 03 saves entries, the one entry is
built from today's single-backend fields, so nothing a user sees changes. This
is the refactor that lets two ComfyUI servers, or two toolchest instances, run
side by side.

## Files touched
- `src/lib/generation/entry.ts` (new) — the medium-neutral entry type and
  helpers, so music and video can reuse it later.
- `src/lib/image/types.ts` — `ImageModelEntry` (the image entry), and
  `ImageResultMeta` gains `entryId`.
- `src/lib/image/backend.ts` — `ImageJobHandle` gains `entryId`;
  `resolveImageBackend()` becomes `forEntry(legacyImageEntry())`;
  `backendForEntry(entry)` dispatches on `entry.backend`.
- `src/lib/image/registry.ts` — the map holds a factory per kind
  (`registerImageBackendKind(kind, forEntry)`), and `backendForEntry` caches
  one object per entry id, rebuilt when the entry's config changes
  (compared by `JSON.stringify` of the config fields).
- `src/lib/image/legacy.ts` (new) — `legacyImageEntry()`: the entry described
  by `imageBackendKind` and its fields, with id `'legacy'`.
- `src/lib/image/comfyui/backend.ts`, `comfyui/run.ts`, `comfyui/upscale.ts` —
  `config()`, `configuredModel()` and `customTemplate()` read the entry;
  `editsByServer` stays a module map (it is keyed by server and family, which
  is correct across entries).
- `src/lib/image/local/backend.ts` — model id from the entry.
- `src/lib/image/lemonade/backend.ts`, `lemonade/client.ts` — address, key and
  model from the entry; the catalogue cache stays module level (it is the
  app's own catalogue, not the server's).
- `src/lib/toolchest/kind.ts` — `toolchestKind` gains a sibling
  `toolchestServer(baseUrl, keyId, modelId)` that holds its own
  `lastInstances` and upscalers; `toolchestKind(kind)` becomes a thin wrapper
  that builds one from the settings fields (music and video keep using it).
- `src/lib/image/toolchest/backend.ts` — built from `toolchestServer(...)` per
  entry; `seenInstances`, `toolchestInstance` and `toolchestFamily` take the
  entry (callers pass `legacyImageEntry()` for now).
- `src/lib/image/none.ts` — unchanged; returned when there is no entry.
- Callers of `getImageBackend(kind)` (`forTool.ts` `resumeForTool`,
  `_imageJob.ts`) — use `backendForEntry` with an entry rebuilt from the handle
  (see Steps).
- Tests beside each file.

## Steps
1. `generation/entry.ts`:
   ```ts
   export interface GenerationEntry<B extends string, C> {
   	id: string;           // crypto.randomUUID()
   	name: string;         // shown in Settings and in the `model` enum
   	backend: B;
   	url: string;          // '' for the bundled engine
   	keyId: string | null; // a named key, Settings → Inference → API Keys
   	model: string;        // checkpoint / instance / catalogue id
   	options: Record<string, string>; // per-backend extras
   	caps: C | null;       // last probe's answer (Phase 03 fills it)
   	capsAt: number | null;
   	renamed: boolean;     // the user set the name (Phase 03 stops renaming)
   }
   ```
   Plus `entryConfigKey(e)` (the fields that change behaviour: backend, url,
   keyId, model, options) and `uniqueName(name, host, taken)`: `name` if
   free, else `name (host)`, else `name 2`, `name 3`, ….
   `defaultName(e)`: the model's display name where it is known without a
   probe (toolchest instance id; catalogue name for the bundled engine and
   Lemonade; ComfyUI checkpoint file name without extension), or the backend's
   label ("ComfyUI", "Bundled engine", "Lemonade", "llama-toolchest") when
   `model` is empty.
2. `ImageModelEntry = GenerationEntry<Exclude<ImageBackendKind,'none'>,
   ImageBackendCapabilities>`. ComfyUI's custom workflow paths go in
   `options.workflowPath` and `options.fieldMapPath`.
3. Keys: a ComfyUI or Lemonade entry with `keyId: null` sends an empty key, so
   Rust's `effective_api_key` (`src-tauri/src/comfy.rs`) falls back to the
   `comfy:key` / `lemonade:key` secret as today. With a `keyId`, the webview
   resolves it with `toolchestKeyFor` (rename to `namedKeyValue` and move to
   `stores/apiKeySecrets.ts`) and passes it inline, as toolchest does now. No
   Rust change.
4. Convert each backend to a factory. Inside each, replace every
   `getSettings().<field>` with the entry's field. Keep the object shape
   (`capabilities`, `probe`, `generate`, `upscale?`, `resume?`) unchanged.
5. Handles carry the entry: `ImageJobHandle.entryId`, and for ComfyUI
   `extra.keyId` (toolchest already sets it). `resumeForTool(handle)` always
   talks to the server and model the job was started on: it takes the entry
   with `entryId` from the current entries (`legacyImageEntry()` for now) for
   its `options`, and overrides `url`, `model` and `keyId` with the handle's.
   If the entry is gone, it builds a stand-in entry from the handle alone: `backend`, `baseUrl`
   and `model` are on every `ImageJobHandle`; `keyId` is `extra.keyId`, or
   `null` when absent (a ComfyUI handle saved before this phase). Only ComfyUI
   and toolchest emit handles; Lemonade and the bundled engine have none to
   resume. So a resume never depends on the list still holding the entry. ComfyUI resume then sends the handle's key, not
   the current one (`comfyui/run.ts` `resumePrompt`).
6. `ImageResultMeta.entryId` is set by `backendForEntry`'s wrapper on every
   result, so later phases can name the entry that ran.
7. Every other caller keeps calling `resolveImageBackend()`, which now goes
   through `legacyImageEntry()` — no behaviour change.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan
- Existing backend tests pass with settings mocks unchanged (they now reach the
  backend through `legacyImageEntry()`).
- New: two ComfyUI entries with different URLs probe and generate against two
  mocked servers in one test; two toolchest entries keep separate instance
  lists; `backendForEntry` returns the same object until the entry's config
  changes.
- Resume: a ComfyUI handle with `extra.keyId` resumes with that key after the
  settings key changed; a handle whose entry is gone resumes through the
  stand-in entry.

## Commit
`refactor(image): bind each image backend to an entry instead of the settings`

## Rollback
Revert the commit. Nothing new is saved, so it is safe to revert alone. A
handle saved with `entryId` by this build is still readable by the old code,
which ignores the extra field.
