# Phase 01 — llama-toolchest upscale

**Depends on:** nothing · **Enables:** toolchest entries that upscale in Phase 04's
routing; ships value now for single-backend toolchest users.

## Goal
The toolchest image backend upscales through `POST /v1/images/upscale`, the way
the bundled engine, ComfyUI and Lemonade already do. As on those backends, the
upscaler belongs to the server: the backend can upscale when the server lists an
instance with `meta.kind: "upscale"`. Today `upscale_image` refuses on toolchest
with "Only the bundled engine, ComfyUI and Lemonade upscale."

## Files touched
- `src/lib/toolchest/models.ts` — `GenerationKind` gains `'upscale'`;
  `ToolchestInstance` gains `scale: number | null` from `meta.scale`.
- `src/lib/toolchest/kind.ts` — `toolchestKind('image')` also keeps the
  server's upscale instances from the same `/v1/models` read (`upscalers()`).
- `src/lib/image/toolchest/adapter.ts` — `ROUTES.upscale = '/v1/images/upscale'`
  and an `upscaleBody(model, b64)` builder.
- `src/lib/image/toolchest/backend.ts` — `upscale()` and `capabilities().upscale`.
- `src/lib/image/capabilityLine.ts` — `UPSCALE_HOW` for toolchest names the
  upscaler instance instead of saying toolchest can't upscale; `forTool.ts`
  `NO_UPSCALE_SENTENCE` lists toolchest.
- `src/lib/image/toolchest/backend.test.ts`, `src/lib/toolchest/models.test.ts`,
  `src/lib/image/capabilityLine.test.ts` — tests.
- `src/lib/toolchest/fixtures/` — add an upscale instance to a `/v1/models`
  fixture (asmodean's `real-esrgan` shape: `kind: "upscale"`,
  `api: ["images.upscale"]`, `scale: 4`).
- `docs/guide/images.md` — the upscale line lists llama-toolchest.

## Steps
1. In `models.ts`, widen `GenerationKind` to include `'upscale'`, parse
   `meta.scale` with `num()` into `scale`, and give `OLD_API.upscale = []`.
2. In `kind.ts`, when the image kind reads `/v1/models`, also parse the
   `upscale` instances and keep them beside `lastInstances`; export
   `upscalers()` returning the ones whose state is usable (`usable()` from `kind.ts`) and whose `api` includes `images.upscale`.
3. In the toolchest adapter, add the route and the JSON body
   `{ model, image: <base64> }` (toolchest forwards sd-server's
   `/sdcpp/v1/upscale` fields unchanged; the answer is
   `{ images: [{ b64_json }] }`, as in `local/backend.ts`'s `upscale`).
4. In the backend, `capabilities().upscale = upscalers().length > 0`.
   `upscale(input, opts)` takes the first upscaler, posts through
   `toolchest_json` with `SYNC_TIMEOUT_MS`, as the sync route does,
   reports `{phase:'running', detail:'Upscaling'}`, and returns the decoded
   bytes. No handle: the route is synchronous, so a background upscale on
   toolchest ends with the app, like Lemonade's.
5. An empty answer throws `ImageBackendError('rejected', 'llama-toolchest
   returned no upscaled picture.')`; other failures go through the backend's
   `asImageError`, like `generate`'s.
6. Update the capability hints and the guide line.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan
- Unit: `parseGenerationModels(json, 'upscale')` reads `scale`; the image
  backend reports `upscale: true` only when an upscale instance is listed and
  ready; `upscale()` posts `{model:'real-esrgan', image}` to
  `/v1/images/upscale` and returns the bytes; an answer with no image rejects.
- Live: with the backend set to asmodean's toolchest, ask Chat to upscale a
  drawn picture 2×; the result is twice the size (the tool's resize step) and
  the log shows the `/v1/images/upscale` call.

## Commit
`feat(image): upscale with a llama-toolchest server's upscaler`

## Rollback
Revert the commit. Nothing is saved in settings, so a revert leaves no data
behind; toolchest goes back to refusing upscales.
