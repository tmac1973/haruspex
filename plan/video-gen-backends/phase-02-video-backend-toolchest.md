# Phase 02 — Video backend interface and the toolchest backend per entry

**Depends on:** 01 · **Enables:** 03 (routing builds backends from entries), 07 (ComfyUI registers a second kind)

## Goal

Give video the image module's shape: a `VideoBackend` built from an entry by a
registry, so two entries of one kind work side by side. Move today's toolchest
code behind it, using `toolchestServer(kind, source)` per entry the way
`src/lib/image/toolchest/backend.ts` does. The tool still calls the old
functions in this phase; they become thin wrappers over the first entry.

## Files touched

- `src/lib/videogen/backend.ts` (new) — `VideoBackend`, `VideoBackendError`.
- `src/lib/videogen/registry.ts` (new) — `registerVideoBackendKind`, `videoBackendForEntry`.
- `src/lib/videogen/toolchest/backend.ts` (new) — the toolchest backend; moved
  from `src/lib/videogen/toolchest.ts`.
- `src/lib/videogen/toolchest.ts` — keeps the wire code (`ROUTES`, `readVideoJob`,
  `videoProgressOf`, `buildVideoBody`, `videoFiles`, `clipHasAudio`);
  `generateVideo`, `resumeVideo`, `readyVideoInstance`, `listVideoInstances`,
  `probeVideo`, `chosenVideoInstanceId` delegate to the first entry.
- `src/lib/videogen/capsOf.ts` (new) — `capsFromInstance(instance): VideoCaps`.
- `src/lib/videogen/refreshCaps.ts` (new) — `refreshMissingVideoCaps()`.
- `src/lib/videogen/index.ts` (new) — barrel that imports each backend so it registers.
- `src/routes/+layout.svelte` — call `refreshMissingVideoCaps()` beside `refreshMissingImageCaps()`.
- Tests: `backend.test.ts`, `registry.test.ts`, `toolchest/backend.test.ts`,
  `capsOf.test.ts`, `refreshCaps.test.ts`; move cases from `toolchest.test.ts` as needed.

## Steps

1. `backend.ts`:
   - `VideoBackendError extends Error` with `kind: 'unconfigured' | 'unreachable' | 'rejected' | 'cancelled'` and optional `status`, matching `ImageBackendError`'s kinds so routing can share the "pass over" rule.
   - `interface VideoBackend { kind: VideoBackendKind; probe(signal?): Promise<ProbeResult>; capabilities(signal?): Promise<VideoCaps>; generate(req: VideoRequest, opts: VideoGenerateOptions): Promise<VideoResult>; resume(handle: VideoJobHandle, req: VideoRequest, opts: VideoGenerateOptions): Promise<VideoResult>; models?(signal?): Promise<ModelOption[]> }`.
     `ProbeResult` and `ModelOption` come from `#lib/image/backend.ts`, as music does.
   - Keep `instanceId` in `VideoGenerateOptions` for now: the toolchest backend
     uses it in place of `entry.model` when set, on the entry's server, so the
     video-sequence job's separate speaking instance keeps working. Phase 05
     removes it once the job names entries.
2. `registry.ts`: copy `src/lib/image/registry.ts`'s `kinds`/`built` maps,
   caching by `entryConfigKey`, and the wrapper that adds `entryId` to every
   handle passed to `onHandle`. No legacy helpers.
3. `capsOf.ts`: `capsFromInstance(i)` →
   `{ text: caps.includes('text'), startImage: 'start_image', endImage: 'end_image', speech: 'audio', needsSpeech: 'audio' (toolchest's speaking instances are S2V, which needs speech), sound: i.recipe or modelSet matches /ltx/i, limits: i.video, frameStep: /ltx/i ? 8 : 4, licence: i.licence, commercialUse: i.commercialUse }`.
   An instance with `video === null` is not a video instance: `capabilities()` throws
   `VideoBackendError('unconfigured', '<id> is not a video model.')`.
4. `toolchest/backend.ts`: `toolchestVideoFor(entry)` builds
   `toolchestServer('video', () => ({ baseUrl: entry.url, keyId: entry.keyId, modelId: entry.model }))`
   and implements the interface with the code moved from `toolchest.ts`'s
   `generateVideo`, `finish` and `resumeVideo`. `probe()` is the server's probe;
   `capabilities()` readies the instance and maps it; `models()` lists video
   instances. Its handle is `{ backend: 'llama-toolchest', baseUrl, id, model, keyId }`.
   Its `VideoResult.model` is `entry.name`. The migrated entry's name is its
   instance id, so answers read as before.
   Errors from `ToolchestError` map to `VideoBackendError` kinds: network and 5xx
   → `unreachable`, instance missing or stopped → `unconfigured`, 4xx → `rejected`.
   Register it with `registerVideoBackendKind('llama-toolchest', toolchestVideoFor)`.
5. In `toolchest.ts`, the exported functions the tool, job and Settings still
   call delegate to `videoBackendForEntry(firstVideoEntry())`. `resumeVideo`
   uses `videoEntryForHandle(handle)`, so a handle saved before phase 01 still resumes.
6. `refreshCaps.ts`: for each entry with `caps === null` whose probe is `ok`,
   `saveVideoCaps(id, await capabilities())`. An entry that doesn't answer stays unknown.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan

- `registry.test.ts`: same entry config → same backend object; changed URL →
  new object; `onHandle` handles carry `entryId`.
- `toolchest/backend.test.ts`: with a stubbed toolchest call, probe,
  capabilities for LTX (sound, step 8) and Wan S2V (speech), a refused
  non-video instance, generate posts the same body as before, resume uses the
  handle's server and key.
- Existing `toolchest.test.ts`, `video-gen.test.ts`, `video-gen.speech.test.ts`,
  `followers.video.test.ts` and the video-sequence tests pass unchanged: the
  first entry is the migrated one.

## Commit

`refactor(videogen): video backends built from entries, toolchest first`

## Rollback

Revert the commit. Nothing stored changes shape in this phase, except caps
saved on entries, which phase 01's code already accepts.
