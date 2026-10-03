# Phase 06 — The asset-generation job type: registration, stages, config, editor

**Depends on:** 05 · **Enables:** 07, 08, 09, 10, 11 — the stages those phases
fill in.

## Goal

Register a fourth job type with its stage list, config, editor and platform
gate, and a pipeline that runs end to end while doing almost nothing: it
resolves the backend, loads or reports a missing spec, and writes a report. Every
later phase fills in one stage. Shipping the skeleton first means the run view,
the queue, cancellation, the config round-trip and the report all work before any
generation logic exists to confuse them.

## Files touched

- `src/lib/agent/jobs/types/asset-generation/config.ts` — new.
- `src/lib/agent/jobs/types/asset-generation/definition.ts` — new.
- `src/lib/agent/jobs/types/asset-generation/pipeline.ts` — new.
- `src/lib/agent/jobs/types/asset-generation/Editor.svelte` — new.
- `src/lib/agent/jobs/types/index.ts` — register the new type.
- `src/lib/agent/jobs/types/asset-generation/*.test.ts` — new.
- `src/lib/agent/jobs/types/registry.test.ts` — extend the barrel-order test.

## Steps

1. `AssetGenerationConfig`, following the autonomous-coding config's shape and
   its null-means-default convention:
   - `spec_path: string | null` — defaults to `DEFAULT_SPEC_PATH`.
   - `description: string | null` — the prompt a standalone run derives a spec
     from.
   - `run_mode: 'attended' | 'unattended'` — `unattended` auto-accepts the
     anchor. Anything unrecognised reads as `attended`, so a malformed config
     cannot silently make a run unattended. This mirrors the guided-planning
     rule exactly.
   - `target_size: number | null` — the output edge in pixels, default 32. The
     **parser clamps** to the nearest power of two in 8–512 (a hand-edited
     config must still run); the **editor rejects** a non-power-of-two before
     saving (a user typing 30 should be told, not silently given 32). It seeds the spec's `NormalizeProfile`
     in phase 07.
   - `max_attempts: number | null` — **per-entry generation** retries, default
     3, clamped 1–10.
   - `anchor_attempts: number | null` — how many times the anchor may be
     regenerated, default 5, clamped 1–10. Separate from `max_attempts` on
     purpose: they are different questions, and one knob for both would mean
     raising per-asset retries also raised how many times the approval modal
     can be re-rolled.
   - `concurrency: number | null` — simultaneous backend requests, default 1,
     clamped 1–8. A remote box with several GPUs is the reason this exists.
   - `vision_judge: boolean | null` — default true, consumed in phase 10.
   - `use_git: boolean | null` — default true, same meaning as the other jobs.
   - `coding_run: Record<string, unknown> | null` — an autonomous-coding
     configuration carried through to be started after this job, the way guided
     planning carries its own `coding_run`. Null for a standalone run, and only
     acted on by a chained one (phase 11).
2. Stage list, matching the pipeline's index constants exactly:
   `SPEC = 0` (Spec), `ANCHOR = 1` (Style anchor), `GENERATE = 2` (Generate),
   `REPORT = 3` (Report), `HANDOFF = 4` (Handoff). Five from the start —
   phase 11 fills `HANDOFF` in rather than adding it, so stage indices never
   shift and this phase's stage-title test is never invalidated. Descriptions
   follow the UI-copy rule.
3. `available()` returns true only when `resolveImageBackend()` is not the
   `none` backend — the same shape as autonomous coding's availability gate, so
   the job is not offered to someone with nothing configured. A run whose
   backend has become `none` since the job was created fails at the Spec stage
   with one sentence naming Settings → Image, rather than partway through
   generating.
4. `supportsSchedule: false`, for the same reason guided planning sets it: an
   attended run's anchor checkpoint would park on a modal with nobody present.
5. Pipeline skeleton: start each stage, and for now — read the spec if present
   and report its entry count, otherwise finish the Spec stage saying no spec was
   found; pass through Anchor and Generate with "not implemented yet"; write
   `REPORT-assets.md` **in the spec's own directory** — defined here, not left
   for phase 10 to relocate — naming what it saw; finish Handoff with "Nothing chained —
   this run was started manually". Cancellation is checked between stages with
   the same `abortIfCancelled` pattern the other pipelines use.
6. Editor: spec path with a file picker, description textarea, run mode select,
   target size, max attempts, anchor attempts, concurrency, vision judge toggle,
   git toggle. `coding_run` has no editor control — it is set by the chain.
   Validation refuses an empty working directory and an out-of-range numeric field.
7. Extend the registry barrel test to expect four job types in picker order and
   this type's five stage titles.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- `config.test.ts` — every field defaults correctly from `{}`; each clamp holds
  at both ends; `target_size` rejects a non-power-of-two; `max_attempts` and
  `anchor_attempts` are independent, asserted by setting one and checking the
  other is unchanged; a non-boolean `vision_judge` reads as null rather than
  true; an unrecognised `run_mode` reads as `attended`, which is the
  safety-relevant case and gets its own test.
- `definition.test.ts` — `configFromJob` / `configToJson` round-trip; validation
  messages for each refusal; `available()` is false with no backend configured
  and true with one.
- Runner integration, in `runner.test.ts` alongside the existing job tests: a
  run with no spec finishes `succeeded` and the report names the missing file
  (phase 07 changes this behaviour and updates this test, and says so); a run
  with a spec reports the entry count; a manual run's Handoff says nothing was
  chained; cancelling between stages leaves the run `cancelled`, not `failed`.
- `Editor.test.ts` — fields round-trip; an out-of-range concurrency is refused;
  a non-power-of-two `target_size` is refused by the editor even though the
  parser would clamp it.
- The report lands next to the spec, asserted by path, so phase 10 inherits the
  location rather than choosing one.
- Queueing: enqueuing an asset job while a coding run is active parks it behind
  that run rather than starting concurrently — the overview's single-slot FIFO
  constraint, which nothing else asserts for this job type.

## Commit

```
feat(jobs): add the asset-generation job type
```

## Rollback

Delete `src/lib/agent/jobs/types/asset-generation/`, drop the registration line,
and revert the registry test. Existing jobs of other types are untouched; a
persisted job row of the removed type simply fails to resolve, which the runner
already handles (`enqueue failed: job type not registered`).
