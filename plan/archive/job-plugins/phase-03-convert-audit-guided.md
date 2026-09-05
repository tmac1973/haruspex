# Phase 03 — Convert audit + guided planning; delete every `job_type` branch

**Depends on:** Phase 02 · **Enables:** Phase 04.

## Goal

Convert the remaining two types to plugins and delete every scattered
`job_type === ...` branch from the shared code. After this phase the registry
is the **only** dispatch mechanism, and the job-type picker is a
registry-driven `ModeSelector`.

## Files touched

- **NEW** `src/lib/agent/jobs/types/audit/` — `definition.ts` +
  `Editor.svelte`; `pipeline.ts` moves `runAuditPipeline` /
  `runAuditSampleStep` / `verifyClusterTurn` (~200 lines from
  `runner.svelte.ts:1249-1400`). The existing pure modules
  (`auditPipeline.ts`, `auditCluster.ts`, `auditReport.ts`, `tools/audit.ts`)
  move under the type dir (or stay put and are imported — mover's choice, but
  the type dir should be the one obvious home).
- **NEW** `src/lib/agent/jobs/types/guided-planning/` — `definition.ts` +
  `Editor.svelte`; Phase 01's extracted `pipeline.ts` moves in.
- **EDIT** `src/lib/agent/jobs/runner.svelte.ts` — delete the legacy branches
  in `planSteps`, `enqueue`, `startRun`, `runPipeline`; unknown `job_type` is
  now a surfaced error ("job type not registered"), not a silent research
  fallback.
- **EDIT** `src/lib/components/jobs/JobEditor.svelte` — replace the
  hand-rolled type toggle (`:546-571`) with `ModeSelector` over
  `listJobTypes()`; replace all `{#if jobType === ...}` form sections with
  `def.Editor`; reset/load/save go through the definitions' mappers. This is
  the phase where most of the 8+ editor conditionals die.
- **EDIT** `src/lib/components/jobs/JobList.svelte` — badge (`:102`) from
  `def.badgeLabel`; run-button rule (`:114`) from `def.hasPlannedSteps`
  (guided planning: `false`).
- **EDIT** `src/lib/components/jobs/JobRunView.svelte` — remove `isGuided`
  (`:21`): guided planning's named-stage rendering becomes the generic path
  (a `PlannedStep` already carries title/description; research/audit steps
  render the same way). If a true per-type view escape hatch is needed, defer
  it to Phase 07 where autonomous coding actually needs one.
- **EDIT** `src/lib/agent/tools/registry.ts` — the audit/planning category
  gating (`:105`) driven by `def.toolCategories` instead of hard-coded
  category checks.
- **EDIT** `src/lib/agent/jobs/promptCatalog.ts` — editor offers catalog
  prompts per `def.promptScope`; the `PromptScope` type itself keys off
  registry ids.
- **EDIT** `src/lib/agent/jobs/types/index.ts` — register all three.

## Implementation

- Add `hasPlannedSteps`, `badgeLabel`, `toolCategories`, `promptScope` to the
  contract now — each has a concrete consumer in this phase.
- Guided planning's `askUser` / `saveRunnerState` usage already flows through
  `JobRunContext` (Phase 02); this phase just relocates the module.
- Grep-verify at the end: `job_type ===` and `jobType ===` should have **zero
  hits** outside the type modules themselves and the DB layer's opaque string
  handling.

## Acceptance

- All three types behavior-identical: research steps, audit end-to-end
  (sample → cluster → verify → meta-report file), guided planning end-to-end
  (interview → checkpoints → phase files, resume via `planning_state`).
- Type picker renders as `ModeSelector` cards with label + description from
  the registry; selecting a type swaps the config form.
- The grep check above passes; `npm run check` / `lint` / `test` green;
  `cargo test` untouched-green.
