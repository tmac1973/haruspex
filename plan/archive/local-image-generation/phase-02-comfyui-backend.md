# Phase 02 — ComfyUI backend: workflow templates, field map, submit and collect

**Depends on:** 01 · **Enables:** 03 (the Settings UI has something to probe),
and every generating phase from 08 onward.

## Goal

The first real `ImageBackend`. It loads an API-format ComfyUI workflow graph,
substitutes the request's parameters into it through a field map, submits it,
follows progress over the WebSocket, and returns the resulting bytes. Three
bundled templates ship with it — plain text-to-image, reference-conditioned
image-to-image, and seamless texture — and the same field-map mechanism accepts
a user-exported workflow, so custom workflows cost nothing extra.

## Files touched

- `src/lib/image/comfyui/fieldMap.ts` — new. The `FieldMap` type, binding kinds,
  `applyFieldMap()` and `validateFieldMap()`.
- `src/lib/image/comfyui/client.ts` — new. `POST /prompt`, `POST /upload/image`,
  `GET /history/{id}`, `GET /view`, `POST /interrupt`, and `/ws?clientId=`.
- `src/lib/image/comfyui/backend.ts` — new. The `ImageBackend` implementation.
- `src/lib/image/comfyui/templates/{txt2img,reference,seamless,seamless_reference}.json`
  — new. The fourth exists because a texture entry is both seamless and
  anchor-conditioned, and a three-template set silently drops one of the two.
- `src/lib/image/comfyui/templates/README.md` — new. Provenance in prose.
- `src/lib/image/comfyui/templates/index.ts` — new. Each template paired with
  its field map and the capabilities it provides.
- `src/lib/image/index.ts` — new barrel; registers the ComfyUI backend.
- `src/lib/image/comfyui/*.test.ts` — new.

## Steps

1. `FieldMap` has three binding kinds, because one `{node, input}` slot cannot
   express every field:
   - **scalar** — `{ kind: 'scalar', node, input }` for `prompt`,
     `negativePrompt`, `seed`, `width`, `height`, `model`, and each `sampler`
     member. The `model` binding points at the template's
     checkpoint-loader node, which is how a user chooses what generates their
     art; an unset request `model` resolves to `imageComfyCheckpoint` from
     settings before substitution, and the resolved value is what
     `ImageResult.meta.model` reports.
   - **uploaded** — `{ kind: 'uploaded', node, input }` for `referenceImage`.
     The client uploads the bytes first and substitutes the **server-side
     filename** the upload returned, not the bytes. This is the one binding
     where the substituted value is derived rather than copied.
   - **loraSlots** — `{ kind: 'loraSlots', nodes: string[] }`. The template
     contains a fixed number of LoRA loader nodes; slot *i* takes `loras[i]`
     and any unused slot has its strength set to 0. `maxLoras` is
     `nodes.length`.
   Plus `outputNode: string`, naming the SaveImage node whose results are
   collected.
2. `applyFieldMap(graph, map, req, uploads)`: deep-clone the graph, then apply
   each binding for the fields present on the request. A binding naming a node
   or input the graph does not contain is an error, never a silent no-op — a
   typo in a map must not yield a picture made with default parameters.
3. `validateFieldMap(graph, map)` runs at load time, so a broken bundled
   template or a bad user map fails when the backend is configured rather than
   forty images into a run.
4. Client, in this order:
   - `uploadImage(bytes, name)` → `POST /upload/image` (multipart), returning
     the server-side filename;
   - `submit(graph, clientId)` → `POST /prompt`, returning `prompt_id`;
   - `subscribe(clientId, onProgress)` → `/ws?clientId=`, translating ComfyUI's
     `progress` and `executing` messages into `ImageProgress`;
   - `collect(promptId)` → `GET /history/{promptId}`, walk the output node's
     images, fetch each via `GET /view`, return bytes;
   - `interrupt()` → `POST /interrupt`.
   Use `fetch` and `WebSocket` directly; the CSP already allows `http:` and
   `ws:`, and this mirrors `src/lib/api.ts`.
5. Auth: when `imageBackendApiKey` is set, send it as `Authorization: Bearer
   <key>` on every HTTP request. The WebSocket carries **no key** — it cannot
   send headers, and putting a secret in a URL writes it into logs and
   histories. When the socket is refused, fall back to polling
   `GET /history/{id}` every 2 s: progress reporting degrades to
   indeterminate, and nothing else changes. When no key is set, send nothing —
   a bare local ComfyUI has no auth and must not receive an empty header.
6. Unique `clientId` per backend instance and unique `filename_prefix` per
   request, so concurrent submissions cannot be confused in `/history`.
7. Template selection in `generate()` covers all four combinations:
   `seamless` + `referenceImage` → the seamless-reference graph; `seamless`
   alone → seamless; `referenceImage` alone → reference; neither → txt2img.
   Three templates would have made every texture lose its anchor conditioning
   without anything recording a degradation, since the request carries both. When
   `imageComfyWorkflowPath` and `imageComfyFieldMapPath` are both set, that pair
   replaces all three and its own declared capabilities are reported instead.
   Setting only one of the two is a configuration error reported by `probe()`.
8. `capabilities()` is computed from the active templates, not asserted:
   `referenceConditioning` is true when a reference template is available,
   `seamlessTiling` when a seamless one is, `loras` when the active template's
   map has a `loraSlots` binding, and `maxLoras` is that binding's node count.
   A user workflow with no LoRA slots therefore reports `loras: false`, and
   phase 09 degrades rather than silently dropping them.
9. `probe()` does `GET /system_stats`; `ok` on 200, with `detail` carrying the
   reported device name so Settings can show what it found. It also fails,
   before any run starts, when `imageComfyCheckpoint` is empty or names a
   checkpoint `GET /object_info` does not list, and when a custom workflow is
   half-configured — each with a sentence naming the setting. A bad checkpoint
   must surface at Probe, not forty images into a run.
10. Honour `signal` everywhere: abort the fetch, close the socket, and call
    `interrupt()` so a cancelled run does not leave the server working. Throw
    `ImageBackendError` with `kind: 'cancelled'`.
11. Map failures to `ImageBackendError.kind`: a connection refusal or socket
    drop is `unreachable`, a non-2xx is `rejected` with status and the first 200
    characters of the body, an exhausted timeout is `timeout`. Phase 09 branches
    on these, so the mapping is part of the contract.
12. Licensing provenance lives in `templates/index.ts`, not in the JSON —
    ComfyUI API-format graphs must parse as strict JSON and JSON has no
    comments. Each registry entry is `{ file, fieldMap, license, source }` with
    `license` set to this repository's licence and `source` naming who authored
    the graph, and `templates/README.md` states the same in prose. A test
    asserts every entry has a non-empty `license` and `source`.
13. Timeouts, so "an exhausted timeout is `timeout`" means something: 120 s for
    any single HTTP call, 300 s of WebSocket silence, and 600 s for one
    end-to-end `generate()`. All three are module constants, not settings — a
    user who needs longer has a backend problem, not a configuration one.
14. The bundled templates ship `SamplerSettings` defaults of
    `{ name: 'euler_ancestral', steps: 28, cfg: 7.0 }`, used when the request
    leaves `sampler` unset and echoed back in `ImageResult.meta.sampler`.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- `fieldMap.test.ts` — each binding kind substitutes correctly; an `uploaded`
  binding receives the filename, not the bytes; `loraSlots` fills slot 0 and
  zeroes slot 1 when given one LoRA; a binding naming a missing node or input
  throws; the source graph is not mutated.
- `validateFieldMap` accepts all three bundled templates paired with their maps
  — the test that catches a template edited out of sync with its map.
- Every template registry entry has a non-empty `license` and `source`, and
  every referenced JSON file parses as strict JSON.
- A request with `model` unset resolves to `imageComfyCheckpoint` and that value
  reaches the checkpoint node and `meta.model`; a request naming a model
  overrides it; an empty `imageComfyCheckpoint` fails `probe()` rather than the
  run.
- Template selection covers all four combinations, and a request that is both
  seamless and reference-conditioned keeps its reference image.
- The API key never appears in the WebSocket URL; a refused socket falls back to
  history polling and still completes.
- A request with `sampler` unset comes back with the template's defaults in
  `meta.sampler`, not with the field absent.
- A call exceeding the 120 s HTTP timeout throws `kind: 'timeout'`.
- `client.test.ts` — against a mocked `fetch`: submit posts the graph under a
  `prompt` key; collect walks history and fetches each image; the API key is
  sent when set and absent when not; a 500 surfaces status and body text as
  `kind: 'rejected'`; a connection refusal is `kind: 'unreachable'`.
- `backend.test.ts` — template selection picks seamless / reference / txt2img
  for the right requests; a reference request uploads before submitting; abort
  closes the socket, calls interrupt, and throws `kind: 'cancelled'`.
- Capabilities are computed: with the reference template removed from the
  registry, `referenceConditioning` reports false; a user map with no
  `loraSlots` reports `loras: false` and `maxLoras: 0`.
- Half-configured custom workflow (path set, map path empty) fails `probe()`
  with a message naming the missing setting.
- Manual: point at a real ComfyUI and confirm bytes come back for a one-line
  prompt.

## Commit

```
feat(image): add a ComfyUI backend with bundled, field-mapped workflows
```

## Rollback

Delete `src/lib/image/comfyui/` and the registration in
`src/lib/image/index.ts`. `resolveImageBackend()` then falls back to `none` for
any install configured for ComfyUI, which degrades to phase-01 behaviour rather
than throwing.
