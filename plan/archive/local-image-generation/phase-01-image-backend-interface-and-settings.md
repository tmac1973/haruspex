# Phase 01 — Image backend interface, types and settings

**Depends on:** nothing · **Enables:** every later phase; this is the interface
the ComfyUI backend (02), the local engine (13) and every consumer implement
against.

## Goal

Define the image-generation layer's vocabulary and configuration with no
backend behind it yet. This phase establishes the boundary the whole plan
depends on: a module under `src/lib/image/` that knows about *requests* and
*images* and nothing about specs, anchors, assets or jobs. It ships the request
and result types, the `ImageBackend` interface, a registry that resolves the
configured backend, the capability declaration every backend answers with, and
the settings fields that select one. A no-op "none" backend is the only
implementation, so the phase is verifiable on its own.

## Files touched

- `src/lib/image/types.ts` — new. `ImageRequest`, `ImageResult`,
  `ImageBackendCapabilities`, `ImageBackendKind`, `ImageProgress`,
  `ImageBackendError`, `SamplerSettings`, `LoraRef`.
- `src/lib/image/backend.ts` — new. The `ImageBackend` interface, plus
  `resolveImageBackend()` reading settings and returning the configured one.
- `src/lib/image/registry.ts` — new. `registerImageBackend()` /
  `getImageBackend()`, mirroring `agent/jobs/types/registry.ts`.
- `src/lib/image/none.ts` — new. The unconfigured backend: declares no
  capabilities and fails every call with a message naming Settings → Image.
- `src/lib/stores/settings.ts` — add the eight image settings listed in step 9.
- `src/lib/image/types.test.ts`, `backend.test.ts`, `registry.test.ts` — new.
- `src/lib/image/layering.test.ts` — new. Both halves of the layering guard.

## Steps

1. `SamplerSettings` is `{ name: string; steps: number; cfg: number }` and
   `LoraRef` is `{ name: string; strength: number }`. Both are named types
   because the anchor recipe in phase 08 has to store them and a later run has
   to compare them.
2. `ImageRequest`: `{ prompt: string; negativePrompt?: string; width: number;
   height: number; seed: number | null; model?: string; referenceImage?:
   Uint8Array; referenceStrength?: number; loras?: LoraRef[]; sampler?:
   SamplerSettings; seamless?: boolean }`. Every field is about generating a
   picture; no field names an asset, an entry or a spec.
   `model` names the checkpoint to generate with — without it there is no way
   for a caller to choose, and `ImageResult.meta.model` has no source. Unset
   means the backend's configured default. There is deliberately no `batch`,
   no `backgroundColor` and no `extra`: nothing batches, the background reaches
   the model as prompt text rather than a parameter, and an escape-hatch bag
   nothing fills is the same unchecked claim. Every field here has a producer
   and a consumer in this plan.
3. `ImageResult`: `{ images: Array<{ bytes: Uint8Array; mimeType: string;
   width: number; height: number }>; meta: { seed: number; model: string;
   backend: ImageBackendKind; sampler: SamplerSettings; loras: LoraRef[];
   durationMs: number; raw?: unknown } }`. `sampler` and `loras` are echoed back
   as the backend actually resolved them — the request may leave them unset and
   the recipe must record what was really used. The backend returns bytes and
   never writes a file.
4. `ImageProgress`: `{ phase: 'queued' | 'running' | 'downloading'; step?:
   number; totalSteps?: number; detail?: string }`. Enough for a determinate
   bar when the backend reports steps and an indeterminate one when it does not.
5. `ImageBackendError extends Error` with `{ kind: 'unconfigured' |
   'unreachable' | 'rejected' | 'timeout' | 'cancelled'; status?: number; body?:
   string }`. Phase 09 branches on `kind` to decide whether an entry is worth
   retrying, so it is a discriminant rather than decoration.
6. `ImageBackendCapabilities`: `{ referenceConditioning: boolean;
   seamlessTiling: boolean; loras: boolean; maxLoras: number }`. Every field is
   read by phase 09's degradation logic. There is deliberately no `controlNet`,
   no `maxBatch` and no `sizes`: no phase ships a ControlNet workflow, nothing
   batches, and nothing negotiates sizes — a capability nothing reads is a
   claim nobody checks.
7. The interface:
   ```ts
   export interface ImageBackend {
     kind: ImageBackendKind;
     capabilities(): Promise<ImageBackendCapabilities>;
     probe(): Promise<{ ok: boolean; detail: string }>;
     generate(req: ImageRequest, opts: {
       signal?: AbortSignal;
       onProgress?: (p: ImageProgress) => void;
     }): Promise<ImageResult>;
   }
   ```
   `generate` takes one request and returns one result: the single-image call is
   the primitive, not a special case of a batch run. `signal` and `onProgress`
   are in the interface so a future UI gets cancellation and a progress bar with
   no new plumbing.
8. `ImageBackendKind` is `'none' | 'comfyui' | 'local'` from the start, even
   though phase 13 supplies the third implementation — the union, the settings
   field and the registry key must agree, and splitting them across phases is
   how they drift.
9. Settings fields, all defaulting to `'none'` or empty so an existing install
   is unaffected and no migration flag is needed: `imageBackendKind`,
   `imageBackendBaseUrl`, `imageBackendApiKey`, `imageComfyCheckpoint`
   (the default checkpoint name a request's unset `model` resolves to),
   `imageComfyWorkflowPath`, `imageComfyFieldMapPath`, `imageLocalModelPath`,
   `imageLocalModelId`. There is **one** API-key field: it is sent as a header
   by the ComfyUI client in phase 02, and nothing else. When both
   `imageLocalModelId` and `imageLocalModelPath` are set the **id wins**; the
   path is the escape hatch for a file the catalogue does not know.
10. `registry.ts` copies the job-type registry's shape: a module-level
   `Map<ImageBackendKind, ImageBackend>`, with re-registration replacing so a
   module-cached barrel stays idempotent.
11. `resolveImageBackend()` reads `imageBackendKind`, looks it up, and falls
    back to the `none` backend when unset or unregistered.
12. `none.ts`: `capabilities()` all-false with `maxLoras: 0`;
    `probe()` returns `{ ok: false, detail: 'No image backend configured —
    Settings → Image.' }`; `generate()` throws `ImageBackendError` with `kind:
    'unconfigured'` and that same sentence. Per the project's UI-copy rule the
    one sentence names the settings path and explains nothing further.
13. `layering.test.ts` enforces both halves of the overview's constraint by
    scanning every file under `src/lib/image/`:
    - no import from `$lib/agent/jobs` or a relative path resolving into
      `src/lib/agent/jobs/`;
    - no occurrence of the identifiers `AssetSpec`, `AssetEntry`, `AnchorRef`,
      `AnchorRecipe`, or the words `spec`, `anchor`, `entry` or `asset` used as
      an identifier — prose in comments is exempt, so the module may still
      explain what it deliberately does not know.
    Asset-shaped code belongs in `src/lib/assets/` (phase 05), which may depend
    on this module but never the reverse.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- `types.test.ts` — an `ImageRequest` round-trips through `JSON.stringify` with
  the reference bytes omitted, proving nothing non-serialisable leaked into a
  type that must cross a boundary.
- `registry.test.ts` — register/lookup; re-registering an id replaces rather
  than duplicates; an unknown kind returns undefined.
- `backend.test.ts` — `resolveImageBackend()` returns `none` when the setting is
  unset, when it names an unregistered kind, and when settings are empty;
  returns the registered backend when the kind matches.
- `none.test.ts` — `generate()` rejects with `kind: 'unconfigured'` and a
  message containing `'Settings → Image'`; `capabilities()` reports nothing
  supported.
- Every field of `ImageRequest` and `ImageBackendCapabilities` is referenced by
  at least one later phase — a grep-style test over the plan's own vocabulary is
  not possible, so this is asserted by review, but the types are deliberately
  minimal so the review is short. (Model resolution is tested in phase 02 and
  local-model precedence in phase 13, where the code that implements each
  lives.)
- `layering.test.ts` — passes now. Verify both halves have teeth: temporarily
  add an import of `$lib/agent/jobs/types/registry` to `backend.ts`, then
  temporarily add a type named `AssetSpec` to `types.ts`, confirming each makes
  the test fail on its own.
- Settings: an existing settings blob with no image fields loads and reports
  `imageBackendKind === 'none'`.

## Commit

```
feat(image): add the image backend interface, registry and settings
```

## Rollback

Delete `src/lib/image/` and revert the eight settings fields. Nothing else
imports them yet, so removal is total and safe. An install that persisted the
new settings keys is unaffected — unknown keys are ignored by the settings
loader.
