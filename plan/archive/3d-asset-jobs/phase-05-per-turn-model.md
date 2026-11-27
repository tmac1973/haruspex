# Phase 05 — A job turn can run on its own model

**Depends on:** nothing · **Enables:** 08, 10

## Goal
`runJobTurn` always uses the job's own backend. Add an optional `model`
(`ModelColumns`) to a turn, so one run can create on one server and animate on
another. Slot, vision and context come from that model for that turn.

## Files touched
- `src/lib/agent/jobs/runner.svelte.ts` — `runJobTurn` takes `model?: ModelColumns`.
- `src/lib/agent/jobs/jobBackend.ts` — `backendOverrideFor(columns)` split out of `jobBackendOverride(job)`.
- `src/lib/agent/jobs/types/types.ts` — `JobRunContext.runJobTurn` option type gains `model`; `JobRunContext` gains `describeModel(columns): { label: string; vision: boolean; contextSize: number }`.
- `src/lib/agent/jobs/runner.modelPolicy.test.ts` — override used.
- `src/lib/agent/jobs/jobBackend.test.ts` (new).

## Steps
1. `jobBackend.ts`: `backendOverrideFor(cols: ModelColumns)` holds today's body; `jobBackendOverride(job)` calls it with `modelColumnsOf(job)`.
2. `runJobTurn(job, runId, abort, opts)`: `const backend = opts.model ? backendOverrideFor(opts.model) : jobBackendOverride(job)`. Strip `model` from `opts` before spreading into `runEphemeralTurn`. `withInferenceSlot` uses that backend, so turns on different servers queue on their own lanes.
3. `visionSupported` for the turn: when `opts.model` is set and the pipeline did not pass `visionSupported`, set it from `describeModel(opts.model).vision`.
4. `describeModel` reuses the descriptor path `jobDescriptor` uses (`inference/descriptor.ts`) on a job-shaped object built from the columns; label is `modelFormSummary(modelFormFromColumns(cols))` from `jobModelForm.ts`.
5. Stats stay per step and per `turnKind`; the run-level environment label stays the job's. Pipelines that use `model` show which model a step ran on by patching the step's `description` (phase 08 does).

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/agent/jobs`, `npm run format:check`.

## Test plan
- Unit: a turn with `model` calls `runEphemeralTurn` with that backend and the job's policy; a turn without it is unchanged.
- Unit: `backendOverrideFor` returns null for the Settings-model override (`model_remote_base_url: null`).

## Commit
`feat(jobs): a pipeline can run one turn on a model other than the job's`

## Rollback
Revert; the option is unused until phase 08.
