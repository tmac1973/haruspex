# Phase 09 — Attended review after creation

**Depends on:** 08 · **Enables:** 10

## Goal
In Attended mode the run stops after creation and shows each model's render
sheet. The user accepts it, or types a note to rebuild it with that note.
Rebuilt models are judged again, then animation starts.

## Files touched
- `src/lib/agent/jobs/types/model-generation/review.ts` (new)
- `src/lib/agent/jobs/types/model-generation/review.test.ts` (new)
- `src/lib/agent/jobs/types/model-generation/pipeline.ts` — calls review between CREATE and ANIMATE.

## Steps
1. `attended = ctx.trigger !== 'chained' && cfg.run_mode === 'attended'` (the 2D job's rule).
2. For each entry with a sheet (done or needs work), in order: `askUserQuestion({ runId, question: '<title>: keep this model?', body: needs_work ? 'Open problems: …' : undefined, imageUrl: <sheet data URL>, options: [{ label: 'Keep', recommended: true }, { label: 'Skip it', description: 'Leave it out of animation and the report marks it skipped.' }] }, ctx.abort.signal)`. A free-text answer is a rebuild note. An entry with no sheet (its build never ran) is asked with no image and the same options.
3. Collect all answers first, then rebuild each noted entry with phase 08's loop, up to `cfg.rounds` rounds counted afresh, whose first message is the user's note plus the description, and whose system prompt is unchanged. The rebuilt model is shown once more only if the user asked for a rebuild of it; a second note rebuilds again; the review ends when every answer is Keep or Skip it.
4. Stop / dismiss of the modal throws AbortError, which cancels the run like the 2D anchor checkpoint.
5. Unattended or chained: no review.

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/agent/jobs/types/model-generation`, `npm run format:check`.

## Test plan
- Unit with a fake `askUserQuestion`: Keep all → no rebuild; a note → one rebuild turn whose message contains the note, then asked again; Skip → status skipped; chained trigger → never asks.

## Commit
`feat(jobs): attended review of 3D models before animation`

## Rollback
Revert; runs go straight from creation to the end.
