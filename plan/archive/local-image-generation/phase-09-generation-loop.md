# Phase 09 — The generation loop: per-entry generation, normalization, output

**Depends on:** 02, 04, 05, 08 · **Enables:** 10 (the gate wraps this loop),
11 (the chain has something worth running).

## Goal

Walk the spec, generate each entry conditioned on the anchor, normalize it, and
write it to its output path. This is the stage that actually produces the asset
set. It also reads the backend's declared capabilities and degrades per entry
when a layer is unavailable, recording what it had to do without — the mechanism
that lets a weaker local engine still produce a usable, coherent set.

## Files touched

- `src/lib/agent/jobs/types/asset-generation/generate.ts` — new. The loop.
- `src/lib/agent/jobs/types/asset-generation/request.ts` — new. Build an
  `ImageRequest` from an entry, the spec's style and the backend's capabilities.
- `src/lib/agent/jobs/types/asset-generation/pipeline.ts` — implement
  `GENERATE`.
- `src/lib/agent/jobs/types/asset-generation/*.test.ts` — extend.

## Steps

1. Skip what exists. An entry whose `out` file is already present is skipped and
   counted, so deleting ten files and re-running regenerates exactly those ten.
   That behaviour is a success criterion in the overview, so it is tested here
   rather than assumed.
2. Build each request from the **effective profile** for the entry's kind,
   fetched once per kind via `image_effective_profile` so per-kind behaviour is
   resolved by the same Rust code that normalizes: the entry's prompt with
   `spec.style.prompt` appended, the negative prompt joined per phase 05's
   entry-then-style rule, a generation size of
   `target_size * upscale` (already clamped in phase 04), `model` from
   `spec.style.model`, `loras` from `spec.style.loras`, `seed` from
   `entry.seed` when set, and an ISOLATION scaffold (step 2a) plus a background
   instruction formatted from `profile.background.color` — the one source, so
   the prompt and the chroma key can never disagree. The anchor bytes go in
   `referenceImage` with the profile's `reference_strength`.
2a. **Every sprite and icon prompt is wrapped in an isolation scaffold**, and
   this is a precondition of the whole background-removal layer rather than a
   nicety. Measured against SD1.5: three prompts saying "a sword, game item
   icon, centered, on a flat solid magenta background" produced full-frame
   compositions whose borders were only 38%, 46% and 56% one colour — there
   was no background to remove, so every sprite came out fully opaque and
   failed its alpha check. Rewritten as

     "a single <subject>, one object only, small in frame, centred, isolated
      on a plain flat <background> background, solid <background> backdrop,
      lots of empty <background> space around it, product shot, simple"

   with a negative prompt of

     "background scenery, pattern, multiple objects, collage, tiled, busy,
      border, frame, texture background, gradient, landscape, cropped,
      close-up"

   the same subjects reached 88% and 95% border coherence and keyed cleanly.
   The scaffold is prepended and the negative appended, both before the
   style's own strings, so `spec.style` still has the last word on look. It
   is applied to `sprite` and `icon` only: a texture is meant to fill its
   frame, and telling it to leave empty space would ruin it.
3. Consult `capabilities()` once per run and degrade per entry:
   - no `referenceConditioning` → drop `referenceImage`, and record
     `degraded: 'no reference conditioning'` for that entry;
   - no `seamlessTiling` and the entry is a texture → generate anyway and
     record `degraded: 'not seamless'`, because a visible seam is better than a
     missing texture and the report will say which it is;
   - `loras: false`, or more LoRAs requested than `maxLoras` → drop the excess
     and record it.
   Degradation is recorded per entry, never silent. This is the honest reporting
   that the phase-that-passed-on-nothing lesson demands.
4. Normalize by calling `image_normalize(bytes, profile, kind)`, which returns
   the bytes **and the `ImageStats`** phase 10 evaluates. The per-kind branch
   lives in `effective_profile`, which already disables cropping and outlining
   for `texture`, so this loop does not re-decide it.
5. Write the PNG to the entry's `out` with the existing `fs_write_bytes`
   command path used elsewhere in the runner, creating parent directories.
   Re-check the path escape rule at write time rather than trusting phase 05's
   validation — the spec may have been edited between stages.
6. Concurrency: run up to `config.concurrency` requests in flight with a simple
   worker pool. Results are applied in entry order regardless of completion
   order, so the report and any rewritten spec are deterministic.
7. Progress: patch the stage's streaming line with `n/total — <id>`, and keep
   an `EntryOutcome { id, status: 'done' | 'skipped' | 'unresolved' | 'failed',
   attempts, seed, durationMs, degraded: string[], reason? }` per entry, in the
   `types.ts` phase 08 created. Phase 10's report renders these — a structure,
   for the same reason `AnchorOutcome` is one.
8. Cancellation: `abortIfCancelled()` between entries and an `AbortSignal` into
   every in-flight request, so Stop halts promptly rather than after the current
   batch.
9. A backend error on one entry fails that entry and continues — one missing
   model or one bad prompt must not cost the other ninety-nine. Branch on
   `ImageBackendError.kind`: `unreachable` and `timeout` are transient, so the
   entry is re-queued once at the end of the run in case the backend came back;
   `rejected` and `unconfigured` are not retried. `cancelled` aborts the loop.
   This is the overview's "survive a backend that disappears mid-run"
   constraint, and a run whose backend vanishes finishes with a report rather
   than a crash. Per-check retries arrive in phase 10.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Skip-existing: with two of five outputs present, the backend is called exactly
  three times and the report counts two skipped.
- Request building: style prompt is appended; anchor bytes are attached; entry
  size overrides the profile; a texture entry sets `seamless`.
- The isolation scaffold wraps a `sprite` and an `icon` prompt and is ABSENT
  from a `texture` prompt — a texture is meant to fill its frame. Asserted on
  both, since applying it everywhere is the easy mistake.
- The scaffold's background word is taken from `profile.background.color`, so
  the prompt and the chroma key cannot name different colours.
- Degradation: with a capabilities object reporting no reference conditioning,
  requests carry no `referenceImage` and every entry is recorded as degraded
  with that reason. Same for seamless; and with `maxLoras: 1` and two LoRAs
  requested, one is dropped and recorded.
- Normalization by kind: a texture entry is neither cropped nor outlined —
  asserted on output dimensions and edge pixels, since cropping a tiling texture
  is the failure that would be easiest to ship unnoticed.
- Path escape: an entry whose `out` is `../evil.png` fails that entry and writes
  nothing, even though phase 05 would also have caught it.
- Concurrency: with `concurrency: 4` and eight entries, at most four requests
  are in flight, and results appear in entry order despite out-of-order
  completion.
- Cancellation mid-run leaves the run `cancelled` and does not write a partial
  file.
- One entry's `rejected` error does not stop the others and is not retried; the
  report names it.
- A backend that becomes `unreachable` partway through: the remaining entries
  still run, the affected ones are re-queued once, and the run finishes with a
  report rather than throwing.

## Commit

```
feat(jobs): generate, normalize and write every asset in the spec
```

## Rollback

Revert `GENERATE` to a pass-through and delete `generate.ts` and `request.ts`.
Assets already written stay on disk and will be skipped by a later run, which is
correct.
