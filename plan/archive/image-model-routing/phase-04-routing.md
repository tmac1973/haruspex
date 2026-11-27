# Phase 04 — Routing by need, with failover

**Depends on:** 01, 02, 03 · **Enables:** 05 (a list longer than one entry does
something useful), 06 (the `model` argument and the entry list in prompts).

## Goal
Each image call works out what it needs and runs on the first saved entry, in
list order, that can do it. Unreachable or unconfigured entries fall through to
the next capable one; rejected requests don't. Background tasks keep the entry
they started on. The licence note, the asset job's model name and native edge,
and the GPU-full rewrite use the entry that ran. With one entry, behaviour is
what it was.

## Files touched
- `src/lib/image/route.ts` (new) — `needOf(req)`, `capableEntries(need,
  entries)`, `routeImage(need, opts)`, and `capabilitiesFor(need):
  ImageBackendCapabilities | null` — the snapshot of the first entry
  `capableEntries` returns (no probe), or null when none is capable.
- `src/lib/image/forTool.ts` — `generateForTool` and `upscaleForTool` run
  through the router (`resumeForTool` does not route: it keeps Phase 02's
  handle-based entry); `fitRequest` and `checkEdit` check the
  chosen entry; `nonCommercialModel(entry)` takes the entry that ran; the
  GPU-full rewrite tests `entry.backend === 'local'`.
- `src/lib/image/backend.ts` — `resolveImageBackend()` is removed. Callers
  that run a job (`forTool.ts`, `_imageJob.ts`, `src/lib/assets/single.ts`,
  asset-generation `pipeline.ts` and `anchor.ts`) use the router. Callers that
  show or probe one entry (`ImageSection.svelte`'s Probe and Test generation,
  `ReviewAssets.svelte`'s probe) use `backendForEntry(firstImageEntry())`;
  Phase 05 points them at the open entry.
- `src/lib/agent/tools/_imageJob.ts` — `ImageTaskSpec` gains `entry` (a
  snapshot of the entry chosen when the task starts); `runImageJob` uses it.
- `src/lib/agent/tools/_imageAnswer.ts` — the result line names the entry
  ("Drawn with klein.") when the list has more than one entry.
- `src/lib/agent/jobs/types/asset-generation/pipeline.ts`, `anchor.ts`,
  `nativeEdge.ts` — each draw, edit and upscale routes on
  its own; `configuredModelName()` and `nativeEdgeFor()` take the entry from the
  result's `meta.entryId`; capabilities are asked per step
  (`capabilitiesFor(need)`), not once per run (pipeline.ts:691-698).
- `src/lib/image/generateOne.ts` — takes an entry; Settings passes entry 1.
- `src/lib/assets/single.ts` — `make_asset`'s path: capabilities per step
  through `capabilitiesFor(need)` instead of `resolveImageBackend()`, and
  `generateForTool` routes as above.
- `docs/guide/images.md` and `docs/guide/image-editing.md` — failover, the
  "Drawn with …" line, and that a model too weak for the job is skipped.
- Tests: `route.test.ts` (new), `forTool.test.ts`, `_imageJob.test.ts`,
  asset-generation tests.

## Steps
1. `needOf(req)` returns
   `{ op: 'draw'|'edit'|'extend'|'upscale', pictures: number, mask: boolean,
   transparent: boolean, seamless: boolean, loras: number }`. Hard needs: `op`
   (draw: every entry, edit models included; edit needs `caps.edit` and `maxEditImages >= pictures`; a mask
   needs `caps.edit`, as `checkEdit` does today; extend needs `caps.inpaint`; upscale needs
   `caps.upscale`) and `loras <= maxLoras`. Soft needs: `transparent`,
   `seamless`.
2. `capableEntries(need, entries)`: entries whose snapshot meets every hard
   need, in list order, with the ones that also meet every soft need first.
   An entry with `caps: null` counts as capable and sorts after the known ones.
3. `routeImage(need, { named?, run })`:
   - With `named`: the entry with that name, or an error listing the names. A
     named entry with `caps: null` is probed first and judged on the live
     answer. If it fails a hard need, refuse with
     "<name> can't <op>. <names that can> can." A named entry never falls
     through: if it is unreachable, or its live capabilities fail a hard
     need after the probe, the call fails and the error names it.
   - Otherwise walk `capableEntries`. For each: build the backend and probe.
     A probe that throws, or answers `ok: false` for any reason (server down,
     model missing on the server), moves on; so does an `ImageBackendError`
     of kind `unreachable` or `unconfigured` from the run. Each is logged with
     `logDebug`. (This walk is for unnamed calls only.) `rejected`,
     `timeout` and `cancelled` stop the walk and surface. A named entry that
     is unreachable also stops; the error names it.
   - After a probe, refresh the snapshot (Phase 03 step 4) and re-check the
     hard needs against the live capabilities; if they now fail, move on.
   - None capable: today's sentences (`NO_EDIT_SENTENCE`,
     `NO_UPSCALE_SENTENCE`, `NO_EXTEND_SENTENCE`, "combines at most N") with
     N the largest any entry takes.
   - All capable entries unreachable: "No image model answered: klein
     (asmodean:3000), Ming (comfy:8188)." with each entry's error detail.
4. Soft needs keep today's notes: when the chosen entry lacks transparency or
   tiling, `fitRequest` drops it and adds the existing note.
5. Background tasks: `startImageTask` picks the first entry from
   `capableEntries` without probing (the tool call returns at once), and
   stores that entry's snapshot in the spec. The runner routes with the
   snapshot entry first and the current capable entries after it, so it fails
   over like a foreground call; the entry that actually ran is saved in the
   spec before the handle. A resumed task uses the handle (Phase 02 step 5).
   A task not yet started when the app quit re-runs on its snapshot entry, not
   on the current list.
6. Everything that read "the model" from settings reads the entry that ran:
   `nonCommercialModel(entry)`, the asset job's model name and native edge,
   `GPU_FULL` handling.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan
- `route.test.ts` with three mocked entries (A draws only, B edits 4, C edits
  3 and upscales):
  - draw → A; edit with 2 → B; edit with 4 → B; edit with 5 → refused, "at most
    4"; upscale → C;
  - transparent draw prefers an entry with transparency even if later;
  - B unreachable → edit goes to C; B rejects → error, C not tried;
  - named A for an edit → refused, names B and C;
  - `caps: null` entry is tried after known capable ones.
- `_imageJob.test.ts`: a task started on B runs on B after the list is
  reordered; a resumed handle uses its own entry.
- Asset-generation tests: a run with A (draw) and B (edit) draws on A and edits
  on B; the model name in the run record is per step.
- With one entry, every existing tool test passes unchanged.

## Commit
`feat(image): route each image call to a saved entry that can do it`

## Rollback
Revert the commit. Saved data is unchanged apart from task specs carrying an
`entry` field, which the previous build ignores (it routes by the first entry,
as Phase 03 did).
