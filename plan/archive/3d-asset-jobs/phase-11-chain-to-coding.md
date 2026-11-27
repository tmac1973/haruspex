# Phase 11 — A 3D run hands off to coding, and a 2D run can hand off to it

**Depends on:** 07, 08, 10 · **Enables:** 12

## Goal
A chained 3D run must start the coding run when it finishes, as the 2D asset
run does, and the coding run must know where the models are. When guided
planning chains both 2D and 3D, the 2D run starts the 3D run instead of
coding. Extract the 2D job's `handoffToCoding` so both jobs share it.

## Files touched
- `src/lib/agent/jobs/chainCoding.ts` (new) — `handoffToCoding(ctx, opts)` lifted from `asset-generation/pipeline.ts`, plus `handoffToNextJob`.
- `src/lib/agent/jobs/chainCoding.test.ts` (new)
- `src/lib/agent/jobs/types/asset-generation/pipeline.ts` — uses the shared handoff; honours `chain_next_job_id`.
- `src/lib/agent/jobs/types/asset-generation/config.ts` — `chain_next_job_id: number | null`.
- `src/lib/agent/jobs/types/model-generation/pipeline.ts` — HANDOFF stage.
- `src/lib/agent/jobs/types/model-generation/definition.ts` — fifth stage `Hand off` in `planSteps`.
- `src/lib/agent/jobs/types/model-generation/config.ts` — `coding_run: Record<string, unknown> | null`, `hand_off: boolean | null`, `chain_base_name: string | null`, `chain_coding_model: ChainModel | null`, parsed as the 2D job's same-named fields.
- `src/lib/agent/jobs/types/autonomous-coding/config.ts`, `definition.ts`, `pipeline.ts`, `prompts.ts` — `models_spec_path`, `missing_models`.

## Steps
1. `chainCoding.ts`: `handoffToCoding(ctx, { codingRun, handOff, baseName, codingModel, extraConfig, missingNote, description })` — the body of today's function, generic over what it adds to the coding `type_config` (`extraConfig`). It never throws.
2. 2D pipeline: call it with `extraConfig = { asset_spec_path, missing_assets }`. New first branch: when `cfg.chain_next_job_id` is a number, call `handoffToNextJob(ctx, id)` = `ctx.startChainedRun(id)` and return `Started job <id> (run <r>).` or, when it returns null, fall back to `handoffToCoding` and say the next job could not start. Existing 2D tests stay green.
3. Add `models_spec_path: string | null` and `missing_models: string[]` to the autonomous-coding config parse/defaults (mirroring `asset_spec_path`/`missing_assets`). Pass them to `runPreflightTurn`/`preflightPrompt` beside the asset fields; the preflight prompt gains: "3D models were built from <models_spec_path>; each model is `assets/generated/model/<id>/<id>.glb` with the clips the spec names. Not built: <ids>." (only when set).
4. 3D pipeline HANDOFF stage: needs-work entries are on disk and listed as "built with open problems"; skipped entries and entries with no GLB are `missing_models`. Call `handoffToCoding` with `extraConfig = { models_spec_path: specPath, missing_models }`, the job's `chain_coding_model`, `chain_base_name`, `coding_run`, `hand_off`. Finish the step with the handoff text.
5. `extraConfig` is spread after `coding_run`, so a `coding_run` that already holds `asset_spec_path` keeps it and the coding run knows both specs.

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/agent/jobs`, `npm run format:check`.

## Test plan
- Unit (`chainCoding.test.ts`): no coding_run → nothing chained; hand-started with hand_off false → nothing; createJob null; start null; success text.
- Unit: 2D run with `chain_next_job_id` starts that job and not a coding job; fallback when it cannot.
- Unit: 3D handoff puts `models_spec_path` and `missing_models` in the coding job's config.
- Unit: coding config parses the new fields; preflight prompt includes the models line only when set.

## Commit
`feat(jobs): 3D runs chain to coding, and a 2D run can chain to a 3D run`

## Rollback
Revert. The 2D job returns to its own handoff; 3D runs end at the report.
