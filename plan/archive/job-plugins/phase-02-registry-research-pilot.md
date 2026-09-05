# Phase 02 — `JobTypeDefinition` + registry; research as pilot

**Depends on:** Phase 01 · **Enables:** Phase 03.

## Goal

Introduce the plugin contract and registry, and convert **research** (the
lightest type, ~200 lines total) as the pilot. After this phase the registry
coexists with the old branches: research dispatches through the registry;
audit and guided planning still dispatch through their `job_type === ...`
branches. The app works throughout.

## Files touched

- **NEW** `src/lib/agent/jobs/types/types.ts` — `JobTypeDefinition`,
  `JobRunContext`, `PlannedStep` (contract sketch in `overview.md`; trim to
  what research + the known consumers actually need — no speculative fields).
- **NEW** `src/lib/agent/jobs/types/registry.ts` — `registerJobType`,
  `getJobType`, `listJobTypes`; model directly on
  `src/lib/agent/tools/registry.ts` (`registerTool`).
- **NEW** `src/lib/agent/jobs/types/index.ts` — barrel that imports each type
  module for its registration side effect (research only, this phase).
- **NEW** `src/lib/agent/jobs/types/research/` — `definition.ts` (the
  `JobTypeDefinition`), `pipeline.ts` (moves `runPipeline`/`runOneStep`/
  `renderPrompt` from `runner.svelte.ts:482-590`), `Editor.svelte` (the ~40
  research-specific lines of `JobEditor.svelte` form markup).
- **EDIT** `src/lib/agent/jobs/runner.svelte.ts` — dispatch: look up
  `getJobType(job.job_type)`; if found, use `def.planSteps`/`def.runPipeline`;
  else fall through to the legacy branches (audit/guided until Phase 03).
- **EDIT** `src/lib/components/jobs/JobEditor.svelte` — render research's
  config section via `def.Editor`; the type toggle and other sections
  unchanged this phase.
- **NEW** `src/lib/agent/jobs/types/registry.test.ts` + a definition test for
  research.

## Implementation

### `JobRunContext`

Formalize Phase 01's ad-hoc deps object: `{ job, run, config, patchStep,
runJobTurn, finalizeRun, saveRunnerState, loadRunnerState, askUser }`. The
runner builds one per run and hands it to `def.runPipeline`. `askUser` and the
runner-state pair are pass-throughs to existing machinery
(`userQuestion.svelte.ts` / `job_runs.planning_state`) — no new plumbing, just
plumbed through the context instead of imported ad hoc.

### Editor components

`def.Editor` is a Svelte component receiving `bind:config` (a typed object)
— it renders only the type-specific section. `JobEditor` keeps owning the
shared fields (name, working dir, schedule, model source). Research's config
is small enough to validate the component contract without much migration
pain.

### Config handling (interim)

`type_config` JSON does not exist until Phase 04. For this phase,
`def.configDefaults()` / load / save map to the **existing flat fields** on
`JobInput` — each definition gets temporary `toJobInput(config)` /
`fromJob(job)` mappers that Phase 04 deletes. This keeps Rust untouched and
the conversion honest (no schema change smuggled into a refactor phase).

### Deliberately not in this phase

`available()`, `toolCategories`, `promptScope`, custom run views — added in
Phase 03/05 when their first consumer converts. Keep the contract minimal.

## Acceptance

- Research jobs: create/edit/run/history identical to before.
- Audit + guided planning: untouched, still on legacy branches.
- Registry unit tests: register/lookup/list, unknown-type lookup returns
  undefined (runner falls back cleanly).
- `npm run check`, `npm run lint`, `npm run test` green.
