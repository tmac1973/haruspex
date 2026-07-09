# Phase 01 — Extract guided planning from the runner

**Depends on:** — · **Enables:** Phase 02.

## Goal

Pure refactor, zero behavior change: move the ~575 lines of guided-planning
pipeline code inlined in `src/lib/agent/jobs/runner.svelte.ts` into its own
module directory, mirroring how audit already lives in isolated files
(`auditPipeline.ts` / `auditCluster.ts` / `auditReport.ts`). This is the
enabler for the registry: a type can only become a plugin once its logic is a
module with an explicit interface to the runner.

Research (~120 lines) is small enough to move later during its Phase 02
conversion; guided planning is the outlier that must be extracted first.

## Files touched

- **NEW** `src/lib/agent/jobs/guided-planning/pipeline.ts` —
  `runGuidedPlanningPipeline` (currently `runner.svelte.ts:832-~1248`) plus its
  8 prompt-builder helpers (`:640-812`).
- **NEW** `src/lib/agent/jobs/guided-planning/pipeline.test.ts` — move/adapt
  any existing runner tests that cover guided planning.
- **EDIT** `src/lib/agent/jobs/runner.svelte.ts` — delete the moved code;
  import and call the module from the existing `job_type === 'guided_planning'`
  branch (branch itself stays until Phase 03).

## Implementation

- Follow the audit precedent: the extracted pipeline takes an explicit deps
  object (the pieces of runner state it uses today — `patchStep`, the current
  `RunState`, `runJobTurn`, `finalizeRun`, the `planning_state` save/load
  calls, the `ask_user_question` wiring) rather than reaching into runner
  module scope. This deps object is the rough draft of Phase 02's
  `JobRunContext` — but do **not** design the general interface here; just
  pass what guided planning actually needs.
- The `PlanningStage` type and resume logic (`runner.svelte.ts:68`) move with
  the pipeline.
- No changes to prompts, stage sequencing, DB calls, or UI.

## Acceptance

- `npm run check`, `npm run lint`, `npm run test` green.
- Manual: a guided-planning job runs end to end identically (interview →
  checkpoint → planning → verifier → approval → phase files written).
- `runner.svelte.ts` shrinks by ~575 lines; no export from the new module is
  imported anywhere except the runner.
