# Phase 12 — Guided planning writes models.json and creates or chains the 3D job

**Depends on:** 03, 07, 11 · **Enables:** 13

## Goal
A **Generate 3D models** switch in guided planning. With it on, a stage after
the asset stage writes `plan/<slug>/models.json` from the finished plan, in
every run mode except Overview only, which has no plan. In Unattended plan + code the handoff chains
plan → (2D) → 3D → coding. In the other modes the run creates the 3D job,
not started, and says so.

## Files touched
- `src/lib/agent/jobs/types/guided-planning/config.ts` — `generate_models: boolean` (default false); `chain_models.models_create`, `chain_models.models_animate` (`ChainModel | null`).
- `src/lib/agent/jobs/types/guided-planning/config.test.ts`
- `src/lib/agent/jobs/types/guided-planning/definition.ts` — form keys `chain_models_create_model`, `chain_models_animate_model`; new MODELS stage in `planSteps`.
- `src/lib/agent/jobs/types/guided-planning/Editor.svelte` — the switch and two `StageModelRow`s.
- `src/lib/agent/jobs/types/guided-planning/pipeline.ts` — `modelsNote()`, `modelSpecPrompt()`, `writeModelSpec()`, MODELS stage, handoff changes, create-unstarted path.
- `src/lib/agent/jobs/types/guided-planning/pipeline.models.test.ts` (new)
- `src/lib/agent/jobs/types/model-generation/tools.ts` — `SUBMIT_PLAN_MODEL_SPEC_TOOL` (explicit ids).
- `src/lib/models3d/spec/derive.ts` (new) — `derivePlanModelSpec(payload)` validates explicit plan ids, like `derivePlanSpec`.
- `docs/guide/jobs.md` — the Guided planning bullet names the switch and the two stage rows.
- `docs/guide/3d-models.md` — "From guided planning" section.

## Steps
1. Config: parse `generate_models` (boolean, default false) and the two chain models via `parseChainModel`. Unknown → null.
2. Stage indices: insert `MODELS` right after `ASSETS`: OVERVIEW 0, OUTLINE 1, PHASES 2, VERIFY 3, ASSETS 4, MODELS 5, APPROVAL 6, HANDOFF 7. Update every use of `APPROVAL`/`HANDOFF` constants and `planSteps` (the MODELS step's description: "List the 3D models the plan needs"). Runs with the switch off mark MODELS skipped, as ASSETS is when off.
3. `wantsModels = cfg.generate_models && !cfg.overview_only` (every run mode; no backend needed). An overview-only run has no plan to read, so it writes no models.json. When true, every non-models turn's system prompt gets `modelsNote()` appended (as `generatedArtNote()` is): "3D MODELS ARE BUILT FOR THIS PLAN … each is `assets/generated/model/<id>/<id>.glb`, with named pivots and the clips the spec gives; code loads them, it does not build them." The models stage's own turn is excluded (`turnKind === 'models.derive'`).
4. `writeModelSpec()` mirrors `writeAssetSpec()`: one turn, `turnKind: 'models.derive'`, allowlist fs_read_text/fs_list_dir/code_grep/code_glob + `submit_plan_model_spec`, forced; `derivePlanModelSpec` → `validateModelSpec` → write `${outDir}models.json` → append a `## 3D models` table (id, height, clips) to overview.md idempotently (split on `\n## 3D models\n`). Never throws; on failure sets `noModelsReason` and the stage finishes with it. It runs after `writeAssetSpec` and before approval.
5. Handoff in `unattended_chain` (needs `verified`, as today):
   - `modelsReady = modelIds.length > 0`.
   - Build `codingConfig` as today.
   - When `modelsReady`: create the 3D job (unstarted) with `job_type: 'model_generation'`, `...stageModelColumns(job, null)` (the job's own model writes nothing since the spec exists), `type_config` = `{ spec_path: modelsSpecPath, run_mode: 'unattended', create_model: stageModelColumns(job, cfg.chain_models.models_create), animate_model: stageModelColumns(job, cfg.chain_models.models_animate), allow_textures: false, chain_base_name: job.name, chain_coding_model: codingModel, coding_run: assetIds.length ? { ...codingConfig, asset_spec_path: specPath } : codingConfig }`.
   - When `assetIds.length` too: the 2D job is created as today but with `chain_next_job_id: modelsJobId` (its own `coding_run` stays as a fallback), then started. Its start failing → start the 3D job directly. Return text names both.
   - Only models: start the 3D job; failure → create coding as today and say so.
   - Neither: unchanged.
   - The handoff message names each stage's model with `describeStageModel`.
6. `allow_textures` is false for jobs guided planning creates, the job's default; the user turns it on in the 3D job.
7. Every other mode (`attended`, `unattended_plan`), after approval when the run reaches its end and `modelIds.length > 0`: create the 3D job as in step 5 but with `run_mode: 'attended'`, no `coding_run`, no `chain_*` fields, and do not start it. The HANDOFF step finishes with "Created 3D models job <id> from <path>; start it from the Jobs tab." (In these modes the 2D path stays unchanged: it does nothing.)
8. Editor: checkbox "Also generate 3D models" (tooltip: "Writes models.json from the plan. Plan + code chains a 3D run before coding; other modes create the job for you to start."), shown in every mode. Under it, when on, `StageModelRow` "3D creation" and "3D animation" with `warnNoVision`. The existing "Later stages" rows stay.
9. `overview_only` disables the switch's effect (the stage needs a plan).

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/agent/jobs src/lib/models3d`, `npm run format:check`.

## Test plan
- Unit: config parse; stage indices (existing guided-planning tests updated for the shifted APPROVAL/HANDOFF).
- Unit (`pipeline.models.test.ts`, fixtures like `pipeline.assetSpec.test.ts`): models stage writes the spec and the overview table; note appended to other turns only when on; chain with models only, with 2D + models (2D job has `chain_next_job_id`, 3D job has the coding config with `asset_spec_path`), 2D start failure falls to 3D, attended mode creates the 3D job unstarted.

## Commit
`feat(planning): guided planning writes models.json and chains or creates the 3D models job`

## Rollback
Revert. Plans already written keep their models.json; nothing reads it.
