# Phase 07 — The 3D models job type, its editor and its spec stage

**Depends on:** 03 · **Enables:** 08, 09, 10, 11, 12

## Goal
Register `model_generation` ("3D models") in the Jobs tab with its config,
editor and a pipeline that reads or writes `models.json`. Runs end after the
spec stage in this phase; later phases add stages to the same pipeline. The
editor has the Creation and Animation model rows, using a stage-model row
extracted from guided planning's editor.

## Files touched
- `src/lib/stores/jobs.svelte.ts` — add `'model_generation'` to `JobType`.
- `src/lib/components/jobs/StageModelRow.svelte` (new) — the "Same as this job / Choose…" row + modal, lifted from `guided-planning/Editor.svelte` (`stageRow` snippet and its `Modal` with `JobModelFields`), plus an optional `warnNoVision` prop.
- `src/lib/agent/jobs/types/guided-planning/Editor.svelte` — uses `StageModelRow` (no behaviour change).
- `src/lib/agent/jobs/types/model-generation/config.ts` (new)
- `src/lib/agent/jobs/types/model-generation/config.test.ts` (new)
- `src/lib/agent/jobs/types/model-generation/definition.ts` (new)
- `src/lib/agent/jobs/types/model-generation/definition.test.ts` (new)
- `src/lib/agent/jobs/types/model-generation/Editor.svelte` (new)
- `src/lib/agent/jobs/types/model-generation/prompts.ts` (new) — spec-derive prompt.
- `src/lib/agent/jobs/types/model-generation/tools.ts` (new) — `submit_model_spec` tool.
- `src/lib/agent/jobs/types/model-generation/pipeline.ts` (new)
- `src/lib/agent/jobs/types/model-generation/pipeline.test.ts` (new)
- `src/lib/agent/jobs/types/index.ts` — register after `assetGenerationJobType`.
- `docs/guide/jobs.md` — a "3D models" paragraph under "The job types" pointing at the `3d-models` page.
- `docs/guide/3d-models.md` (new) — first version: what the job does, the spec, the two models, Allow textures, run modes, where files go, what it doesn't do.

## Steps
1. `config.ts`:
   ```ts
   export type ModelRunMode = 'attended' | 'unattended';
   export interface ModelGenerationConfig {
     spec_path: string | null;          // null = DEFAULT_MODELS_SPEC_PATH
     description: string | null;
     run_mode: ModelRunMode;            // unrecognised → 'attended'
     create_model: ChainModel | null;   // null = same as this job
     animate_model: ChainModel | null;  // null = same as this job
     allow_textures: boolean;           // default false
     create_turns: number;              // maxIterations per creation turn, default 40, 10–120
     animate_turns: number;             // maxIterations per animation turn, default 40, 10–120
     rounds: number;                    // turns per asset before "needs work", default 3, 1–6
     use_git: boolean;                  // default true, as the 2D job
   }
   ```
   `parseModelGenerationConfig` is defensive like `parseGuidedPlanningConfig`; models through `parseChainModel`.
   "Two explicit model fields" is met by the editor always showing both rows; null is the row's "Same as this job" choice so a job created by hand runs without picking anything.
2. `definition.ts`: `id: 'model_generation'`, `label: '3D models'`, `description: 'Build 3D models from a spec with check_3d, then animate them on a second model.'`, `badgeLabel: '3D'`, `hasPlannedSteps: false`, `supportsSchedule: false`, `workingDirPlaceholder: 'The project folder'`, no `available` (runs anywhere). Editor state converts the two models with `modelFormFromColumns`/`modelColumnsFromForm` as guided planning does (`chain_create_model`, `chain_animate_model` form keys). `validate`: working dir required; either an existing spec path or a description (checked at run, so here: `spec_path` or `description` non-empty); each chosen model passes `stageModelProblem`. `missingRequired` lists "Description or spec" when both are empty.
   `planSteps`: four named stages — `Spec`, `Create`, `Animate`, `Report` — with descriptions "Read or write models.json", "Build every model", "Animate the models with clips", "Write the report". (Phase 11 adds `Hand off`.)
3. `Editor.svelte` (one short sentence per section, details in `title` tooltips): Description textarea; Spec path input (placeholder `assets/haruspex-models.json`); Run mode select (Attended / Unattended, tooltip: "Attended stops after creation so you can accept or rebuild each model."); `StageModelRow` "Creation model" and "Animation model" with `warnNoVision` (line: "No vision: it works from the text report only."); checkbox "Allow textures" (tooltip: "The creation model may draw tiling textures and map them with kit.texture."); a collapsed "Limits" group with the three numbers.
4. `StageModelRow.svelte`: props `label`, `form` (bindable `JobModelForm | null`), `jobForm` (for the summary of "Same as this job"), `warnNoVision?: boolean`. Shows the vision line when the effective form's `vision === 'no'`, or `'auto'` and the probe says no. Guided planning's two rows switch to it.
5. Spec stage (`pipeline.ts`, stage 0): path = `cfg.spec_path ?? DEFAULT_MODELS_SPEC_PATH` relative to working dir. If the file exists: parse + validate; problems fail the run with them listed (do not overwrite a hand-written spec). Otherwise need `cfg.description` (else fail: "No models.json and no description."). Derive in up to 2 turns on the job's own model: allowlist `[...PROJECT_READ_TOOLS, SUBMIT_MODEL_SPEC_TOOL]`, `forceFinalTool`, `turnKind: 'models.derive'`; capture the payload in `onToolStart`; fill ids with `slugify`/`uniqueId`, dirs with `modelDir`; validate; retry once with the problems. Write with `renderModelSpec`.
6. `submit_model_spec` schema: `style` string; `entries[]` of `{ title, description, height_m, parts[], clips[{name, seconds, loop, action}] }`. Prompt (`prompts.ts`) tells the model: one entry per distinct model; heights in metres; every animated model lists its pivot names as `Side_Part` chains (e.g. `Hip_L`, `Knee_L`); static props have no parts or clips.
7. After the spec stage the pipeline marks the other stages skipped, finalizes `done`, and calls `onSettled` (phases 08–11 replace this).
8. Guide pages as listed. `3d-models.md` has `title`/`description` frontmatter and stays under 6 KB. All phases land in one PR, so write the page for the finished feature now, and keep it accurate in phases 08–12.

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/agent/jobs`, `npm run format:check`, `git diff --name-only origin/main...HEAD | node scripts/guide-check.mjs`.

## Test plan
- Unit: config parse defaults and clamps; malformed run mode → attended; model parse.
- Unit: definition validate/missingRequired.
- Unit (pipeline with fake ctx, following `asset-generation/pipeline.test.ts`): existing valid spec read, invalid spec fails, derive path writes a spec, derive retry on problems.
- Guided planning editor tests still pass after the `StageModelRow` extraction.

## Commit
`feat(jobs): 3D models job type with its spec stage`

## Rollback
Revert. Jobs of type `model_generation` saved meanwhile would show an unknown type; none exist outside development.
