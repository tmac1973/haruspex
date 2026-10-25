# Phase 02 — Haruspex: the llama-toolchest image backend

**Depends on:** 01 · **Enables:** 05 (it reuses the Rust toolchest client, the
model-list parser and the prefill/hint helper)

## Goal
Add `llama-toolchest` to Settings → Image, so it serves `generate_image`,
`make_asset` and the asset job.

- It uses image jobs (with phases and cancel) when `meta.api` has
  `images.jobs`, and the synchronous route otherwise.
- The Model dropdown lists the server's image instances with their state.
- Choosing the kind prefills the address and key from a toolchest inference
  server, and a hint names an inference server that has image instances.

## Files touched
**Rust:**
- **`src-tauri/src/toolchest.rs`** (new):
  - `TOOLCHEST: ImageServer { secret: "", name: "llama-toolchest" }`. The
    secret is empty because the key always arrives inline from the named-key
    store.
  - `#[tauri::command] toolchest_json(call: ComfyCall)` → `comfy::json_from`.
  - `#[tauri::command] toolchest_bytes(call: ComfyCall)` → the bytes path, for
    PNGs.
  - Tests.
- **`src-tauri/src/comfy.rs`:**
  - make the bytes path `pub(crate) bytes_from(call, server)`, as `json_from`
    already is;
  - `send` accepts `"DELETE"` as well as GET and POST, for cancelling jobs;
  - `effective_api_key` skips the store lookup when `secret` is empty.
- **`src-tauri/src/lib.rs`:** `mod toolchest;` and the two commands in
  `generate_handler!`.
- **IPC:** `src/lib/ipc/commands.ts`, regenerated.

**Image backend:**
- **`src/lib/image/types.ts`:**
  - add `'llama-toolchest'` to `ImageBackendKind`;
  - add `ahead?: number` to `ImageProgress`.
- **`src/lib/image/progress.ts`:** `describeImageProgress` says "Queued (N
  ahead)" when `ahead > 0`.
- **`src/lib/toolchest/models.ts`** (new), shared with music:
  - `parseGenerationModels(json, kind: 'image' | 'music')` →
    `ToolchestInstance[] {id, modelSet, recipe, capabilities, state, api,
    licence: string, commercialUse: boolean | null}`;
  - `toolchestKeyFor(apiKeyId: string | null): Promise<string>`: `await
    apiKeysReady()` (`stores/apiKeySecrets.ts`), then
    `rememberedApiKey(id) ?? ''` (`stores/apiKeyMemory.ts`);
  - `toolchestCall(baseUrl: string, apiKey: string, method: 'GET' | 'POST' |
    'DELETE', path: string, body?: unknown, timeoutMs = 30_000): ComfyCall`.
- **`src/lib/toolchest/models.test.ts`** (new),
  **`src/lib/toolchest/fixtures/models-asmodean.json`** (new; recorded from
  `asmodean:3000/v1/models` after Phase 01) and
  **`src/lib/toolchest/fixtures/models-ming.json`** (new; recorded from
  compute2, see step 4).
- **`src/lib/toolchest/detect.ts`** (new), shared with music:
  - `inferenceToolchest()` → `{baseUrl, apiKeyId} | null` when the active
    remote inference backend is `llama-toolchest`;
  - `toolchestHint(kind)` probes that server's `/v1/models` and returns
    `{host, count} | null`.
- **`src/lib/image/toolchest/`** (new):
  - `client.ts`: `toolchestImageConfig()` reads settings and the key, and
    wraps `toolchestJson`/`toolchestBytes` with cancel through `comfy_cancel`;
  - `adapter.ts`: request body (size, `<sd_cpp_extra_args>`, Ming alpha), job
    parsing, phase mapping;
  - `backend.ts`: `ImageBackend` plus `registerImageBackend`;
  - `adapter.test.ts`, `backend.test.ts`.
- **`src/lib/image/index.ts`:** register the toolchest backend.
- **`src/lib/image/forTool.ts`** (L44-47): `nonCommercialModel` branch.
- **`src/lib/image/sdcpp.ts`:** unchanged. The adapter imports the existing
  exported `transparentStart` (L24).

**Asset job and status:**
- **`src/lib/agent/jobs/types/asset-generation/nativeEdge.ts`** (L42) and
  **`pipeline.ts`** (L176): branches for the model id and name.
- **`src/lib/guide/status.ts`** (L36-40): `IMAGE` map entries for
  `'llama-toolchest'` and the missing `'lemonade'`.

**Settings:**
- **`src/lib/stores/settings.ts`:** fields `imageToolchestBaseUrl` (`''`),
  `imageToolchestApiKeyId` (`null`), `imageToolchestModelId` (`''`), plus
  defaults.
- **`src/lib/components/settings/ImageSection.svelte`:**
  - a dropdown option;
  - a `SERVERS` entry;
  - `ServerFields.key` widened to `SettingSecret | { picker: ApiKeyIdField }`,
    where `type ApiKeyIdField = 'imageToolchestApiKeyId'` is exported from
    `src/lib/toolchest/models.ts` (Phase 05 adds `'musicToolchestApiKeyId'`);
  - the key row renders `ApiKeyPicker` for the picker variant;
  - the hint line;
  - the `ToolchestModels` branch at L510-516.
- **`src/lib/components/settings/ToolchestModels.svelte`** (new): props
  `{kind: 'image' | 'music', instances: ToolchestInstance[], baseUrl:
  string}`. It shows the instances table (name, state, capabilities, licence), a "Start it in
  llama-toolchest" note for stopped ones, and an "Open llama-toolchest" link
  to `<base>/`.
- **`src/lib/components/settings/ImageSection.test.ts`:** cases for the
  toolchest kind.

**Docs:**
- **`docs/guide/images.md`:** a "Set up llama-toolchest" section. Trim
  elsewhere to stay under 6 KB.
- **`docs/guide/settings.md`** (~L145-151): an Image section listing every
  backend, which fixes the stale list.
- **`docs/image-generation.md`:** a "## The llama-toolchest backend" section.
- **`CLAUDE.md`:** the Tech Stack image bullet names llama-toolchest.

## Steps
1. **Rust client.**
   - Add `bytes_from`, and the empty-secret guard in `effective_api_key`.
   - Create `toolchest.rs` with both commands; register them in `lib.rs`.
   - Run `node scripts/check-ipc.mjs --write` and
     `./scripts/export-ipc-types.sh`.
   - Calls share `comfy.rs`'s no-proxy client, cancel table and log, as
     Lemonade's do.
2. **Model parsing.** `parseGenerationModels` keeps entries where
   `owned_by === 'llama-toolchest'` and `meta.kind === kind`, and maps them to
   `ToolchestInstance`.
   - `api` is the `meta.api` array, or `['images.sync']` / `['music.jobs']`
     when it is absent (pre-Phase-01 builds).
   - Licence comes from matching `recipe` against `image_models` /
     `comfy_models` ids: `ming-image` → `licence: 'MIT', commercialUse:
     true`; `qwen-image-21*` → its licence name with `commercialUse: false`;
     anything else → `licence: 'unknown', commercialUse: null`.
3. **Probe.** `backend.probe()`:
   - `GET /v1/models` with the key;
   - returns `{ok, detail, models}`, where each model's label is
     `<id> — <state>` and its tip lists the capabilities;
   - `ok` is false and `detail` reads "No running image instance on <host>.
     Start one in llama-toolchest." when none is `running`;
   - an unreachable server is `ok:false` with "Can't reach <host>.";
   - 401 → "Wrong or missing API key."
4. **Capabilities.**
   - `transparency`: true when the instance has the `alpha` capability.
     Toolchest already sets it: its catalogue gives the `ming-image` set
     `capabilities: ["alpha"]` (`internal/generation/catalog.go`), and
     `/v1/models` emits it in `meta.capabilities`. Asmodean has no Ming instance
     today, so `models.test.ts` uses a second fixture,
     `fixtures/models-ming.json`, recorded from compute2.
   - **Before recording,** download the `ming-image` set from toolchest's
     catalogue on compute2 and create and start an instance of it there. That
     instance stays up and is the one Phase 07's transparent run uses.
   - The test asserts `alpha` on it.
   - `seamlessTiling`: false, with the same sd-server extras limit as Lemonade.
   - `loras`: false.
5. **Request building** (`adapter.ts`):
   - `size: "<w>x<h>"`, `n: 1`, `response_format: "b64_json"`, `model`.
   - Seed, negative prompt and sampler go into the `<sd_cpp_extra_args>`
     prefix, following `lemonade/adapter.ts`.
   - When `transparent` is set and the instance has `alpha`, prefix the prompt
     with `RGBA, 4-channel, transparent background.`, and put `init_image` (a
     transparent PNG from `sdcpp.transparentStart`) plus `strength: 0.9` in the
     extras.
6. **Generate with jobs** (when `api` includes `images.jobs`):
   - `POST /v1/images/jobs`, then poll `GET /v1/images/jobs/{id}` every
     1000 ms.
   - Map progress to `ImageProgress`: `queued` → `{phase:'queued', ahead:
     queue_position}`; `generating` → `'running'`; `saving` →
     `'downloading'`.
   - Extend `describeImageProgress` to say "Queued (N ahead)" when `ahead` is
     present.
   - On `succeeded`, fetch `/image/0` through `toolchestBytes`.
   - On `failed`, raise `ImageBackendError('rejected', error)`.
   - On abort, `DELETE` the job, then raise `cancelled`.
   - On 429, raise `rejected` with "llama-toolchest's queue is full; try again
     in a minute."
7. **Generate synchronously** (otherwise):
   - `POST /v1/images/generations` with a 15-minute `timeout_ms`;
   - progress is `{phase:'running'}` once, and the existing 1 s ticker shows
     elapsed time;
   - abort uses `comfy_cancel`, which drops the request so toolchest dequeues
     it if it is still waiting;
   - decode `data[0].b64_json`.
8. **Result meta.** `ImageResultMeta.model` is the instance id, `backend` is
   `'llama-toolchest'`, and the seed is the one sent (the tool always sends a
   seed).
9. **Settings UI.**
   - Add the `SERVERS` entry: url `imageToolchestBaseUrl`, model
     `imageToolchestModelId`, placeholder `http://host:3000`, and the
     key-picker variant.
   - `persistKind` already re-probes and calls `invalidateTypeAvailability`.
   - On switching to `llama-toolchest` with an empty address, call
     `inferenceToolchest()` and write both fields when it returns a server.
   - When the kind is `none` and `toolchestHint('image')` returns a host, show
     "llama-toolchest on <host> has image models." beside the dropdown.
   - Below the Connection section, `<ToolchestModels kind="image"
     instances={…} baseUrl={…}>` shows the instance table.
     Model selection itself stays in the shared dropdown.
10. **Branches.** Update `nonCommercialModel`, `nativeEdge.ts`, `pipeline.ts`
    and `status.ts` with the toolchest kind.
11. **Docs.** Run `scripts/guide-check.mjs` locally. The PR body names the
    `images` and `settings` pages.

## Build gate
```bash
npm run check
npm run lint
npm run test
npm run format:check
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt -- --check
./scripts/export-ipc-types.sh
git diff --exit-code src/lib/ipc
node scripts/guide-check.mjs
```

## Test plan
Automated:
- **`models.test.ts`:**
  - the asmodean fixture gives one image instance (`qwen-turbo-local`, running)
    and filters out text and music entries;
  - an entry without `meta.api` gets `images.sync`.
- **`adapter.test.ts`:**
  - the body for a transparent request on an `alpha` instance has the RGBA
    prefix and `init_image`;
  - a non-`alpha` instance drops it;
  - job-JSON mapping covers every status and phase.
- **`backend.test.ts`,** with a mocked `invoke`:
  - the jobs path covers poll, success and fetch;
  - abort sends `DELETE`;
  - the sync path is used when `api` lacks `images.jobs`;
  - 401, 429 and unreachable produce the right `detail` and error kinds.
- **`ImageSection.test.ts`:**
  - choosing toolchest with a toolchest inference server prefills the address
    and key id;
  - the address stays separate from Lemonade's and ComfyUI's;
  - stopped instances are labelled.
- **`toolchest.rs`:** with the empty-secret guard, no store lookup is made and
  the inline key is sent as Bearer.

Manual (`GDK_BACKEND=x11 npm run tauri dev`):
- Settings → Image → llama-toolchest, pointing at asmodean:3000. Probe lists
  `qwen-turbo-local — running`.
- Test generation shows "Queued", then "Generating", then the image.
- In Chat, ask for a picture; cancel one mid-run and check the toolchest queue
  history shows it was dropped.

## Commit
`feat(image): add llama-toolchest as an image backend`

## Rollback
Revert the PR. The settings fields are additive, and `load()` merges defaults,
so stale `imageToolchest*` fields are harmless. A saved `imageBackendKind` of
`'llama-toolchest'` resolves to `noneBackend` through the registry fallback,
and the user sees "Settings → Image".
