# Phase 09 — Camera digest job

**Depends on:** 03, 04, 07, 08 · **Enables:** completes the feature

## Goal

A scheduled job type, modelled on Email digest, that summarises what one or
more cameras' ambient logs recorded over a period ("every evening at 7pm,
summarise today in the kitchen"), optionally with a fresh snapshot, into the
job's result card. This is how cameras reach jobs; only cameras set to Allow
are used.

## Files touched

- `src/lib/agent/jobs/types/camera-digest/config.ts` — new: config shape,
  defaults, `configFromJob` / `configToJson`, `validate`.
- `src/lib/agent/jobs/types/camera-digest/definition.ts` — new:
  `registerJobType` entry (`supportsSchedule: true`, `background: true`,
  `available()`).
- `src/lib/agent/jobs/types/camera-digest/Editor.svelte` — new.
- `src/lib/agent/jobs/types/camera-digest/pipeline.ts` — new: planned steps,
  result schema, prompt, `runPipeline`.
- `src/lib/agent/jobs/types/camera-digest/pipeline.test.ts` — new.
- `src/lib/agent/jobs/types/index.ts` — import the new type.
- `src/lib/stores/jobs.svelte.ts` — add `'camera_digest'` to `JobType`.
- `docs/guide/jobs.md` — Camera digest section; `docs/guide/cameras.md` —
  link to it.

## Steps

1. Config: `{ cameras: string[] (camera ids; empty = every Allow camera),
   period: 'since_last_run' | 'last_24h' | 'today' (since_last_run falls back
   to the last 24 h on the first run), include_snapshot: boolean
   = false, focus: string = '' }` (focus: optional instruction such as
   "only mention people and deliveries").
2. `available()`: true when at least one camera is set to Allow and
   `cameraDataAllowed(resolveBackendDescriptor(job backend override))` holds
   (the same descriptor the phase-04 gate sees for the job's turns); otherwise
   the editor shows "Needs a camera set to Allow in Settings → Cameras, and a
   local or trusted model."
3. `runPipeline`:
   - Resolve the cameras; drop any set to Ask with a step note "Skipped
     <name>: set to Ask (Settings → Cameras)".
   - Load entries with `camera_events_list` for the period (cap 200 per
     camera, newest first).
   - Run one `runJobTurn` with `toolAllowlist: ['camera_log',
     'camera_snapshot']` (snapshot only when `include_snapshot`), the entries
     pre-rendered into the prompt (time, trigger, transcript, caption), and
     the focus. The tools pass through the phase-04 gate, so Ask cameras are
     refused there too.
   - Result schema: `{ summary: string, highlights: {time, camera, text}[] }`.
4. Editor: camera checklist (Ask cameras greyed with a tooltip), period
   select, snapshot switch, focus field.
5. With `include_snapshot` on and a model without vision, the snapshot tool
   is dropped by `requiresVision` and the result notes "Snapshot skipped: the
   model can't see images."
6. Empty period → result "Nothing was logged." without calling the model.

## Build gate

- `npm run check`, `npm run lint`, `npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- Unit: config round-trip and validation; Ask cameras skipped with a note;
  empty period short-circuits; the allowlist only includes `camera_snapshot`
  when enabled; registry test sees the new type.
- Manual: schedule a digest for the D1 a few minutes ahead after generating
  some events; the result card summarises them; switching the D1 to Ask
  makes the next run skip it.

## Commit

`feat(camera): add a Camera digest job that summarises camera logs on a schedule`

## Rollback

Revert: the job type disappears; existing camera_digest jobs fail to load
their type and show as unavailable, so delete them first or accept that.
