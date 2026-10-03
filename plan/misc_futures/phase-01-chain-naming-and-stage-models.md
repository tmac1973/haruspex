# Phase 01 — Chain naming and a model per chained stage

Depends on: — / Enables: —

## As built — notes

- **`ChainModel` uses the job's column names** (`model_remote_base_url`, …,
  `model_advanced`), not the renamed fields in step 1. `stageModelColumns` is
  then a straight pick, and a stored override is exactly what `createJob`
  takes.
- **Two parsers.** `parseChainModel` is for an override and needs a URL and a
  model id. `parseModelColumns` is for the resolved columns the asset job is
  handed, where all-null is valid and means "the Settings model". With a
  single parser, a planner on Settings with an asset-stage override would
  have leaked that override into the coding job.
- **The form lives in a plain-TS module,** `src/lib/agent/jobs/jobModelForm.ts`
  (`JobModelForm`, `modelFormFromColumns`, `modelColumnsFromForm`). The same
  form is a job's own model in JobEditor and a stage's model inside the
  guided-planning type config, which has to be plain JSON.
  `JobModelFields.svelte` keeps only transient state: probe results, the
  OpenRouter catalog. JobEditor went from 1476 lines to 736.
- **JobEditor's load effect now tracks `jobId` only,** through `untrack`.
  Loading bumps the fields' remount counter, a read as well as a write, and a
  tracked read looped the effect.
- **A chosen stage with no server or model fails validation,** instead of
  saving as "same as this job".
- The handoff names the model in both the started and the not-started
  messages.
- **Not done:** the manual chain run in the test plan. It needs the app and
  two inference models.

## Goal

Two fixes to chains (guided planning → assets → coding):

- **Naming.** A chained coding job is named "<planning job> — coding" whether
  or not an asset stage ran. Today the asset job appends " — coding" to its
  own name, which gives "<job> — assets — coding".
- **A model per stage.** The guided-planning editor gets an optional model for
  the asset run and one for the coding run, each defaulting to "Same as this
  job". A chain can then plan with a strong model and code with a fast one.
  Today every chained job inherits the planning job's server, model, key,
  context size, vision flag and `model_advanced`, with no way to change it.

## Files touched

- `src/lib/agent/jobs/types/guided-planning/config.ts`: a new `chain_models`
  block.
- `src/lib/agent/jobs/types/guided-planning/definition.ts`: editor state,
  defaults, `configToJson` and `configFromJob` (around :8, :110, :126,
  :134-146). These copy fields one by one, so a field missing from them is
  dropped on save.
- New `src/lib/agent/jobs/chainModel.ts`: `ChainModel` and
  `stageModelColumns`, shared by both pipelines.
- `src/lib/agent/jobs/types/guided-planning/pipeline.ts`: creating the asset
  job (around :1571) and the coding job (around :1613).
- `src/lib/agent/jobs/types/asset-generation/config.ts` and `pipeline.ts`
  (around :346): carry the chain's base name, apply the coding-stage model.
- `src/lib/components/jobs/JobEditor.svelte`: extract the model override
  fields into a component.
- New `src/lib/components/jobs/JobModelFields.svelte`.
- `src/lib/agent/jobs/types/guided-planning/Editor.svelte`: two stage pickers,
  shown only in `unattended_chain` mode.
- Tests beside each.

## Steps

1. **`ChainModel` type.** Its fields mirror the job's model columns:
   `base_url`, `api_key`, `api_key_id`, `model_id`, `context_size`,
   `vision_supported` and `advanced`.
   - `GuidedPlanningConfig.chain_models` is
     `{ assets: ChainModel | null; coding: ChainModel | null }`.
   - Null means "same as this job".
   - `parseGuidedPlanningConfig` reads it defensively: a malformed entry
     becomes null, never a half-filled override.
2. **One helper decides a stage's model.** `stageModelColumns(job, override)`,
   in `src/lib/agent/jobs/chainModel.ts`,
   returns the job's `model_remote_*` and `model_advanced` columns: the
   override's values when the override is set, otherwise the job's own.
   - Both job creations call it, replacing the inline copies.
   - A key held by `api_key_id` is copied as the id, never resolved into
     plain text.
3. **The asset job passes on the rest of the chain.** It carries
   `chain_base_name` (the planning job's name) and `chain_coding_model` in its
   `type_config`.
   - `chain_coding_model` holds the coding stage's **resolved** columns: the
     planning job computes `stageModelColumns(planningJob,
     chain_models.coding)` before creating the asset job. So "Same as this
     job" means the planning job's model, never the asset stage's override.
   - When the asset job creates the coding job (`asset-generation/pipeline.ts`
     around :346-363), it names it `${chain_base_name ?? job.name} — coding`.
   - It takes the model columns from `chain_coding_model` when present, and
     from itself otherwise.
   - A hand-made asset job has neither field and keeps today's behaviour.
4. **Extract `JobModelFields.svelte`** from JobEditor's model override section
   (`JobEditor.svelte` around :277 and :472-528).
   - The probe (`probeModel`), its state (`probedModels`,
     `modelContextSize`) and the advanced sub-state (`advDiscovered`, the
     advanced fields) move into the component with it. They belong to the
     same section.
   - Props: the current values as one plain object, and `onchange(next)`.
   - JobEditor uses the component, with no visible change.
5. **Stage pickers in the guided-planning editor.** Under the run-mode
   control, in `unattended_chain` only, add "Asset run model" and "Coding run
   model".
   - Each is a select: "Same as this job" or "Choose…". "Choose…" reveals
     `JobModelFields`.
   - The asset picker shows only when `generate_assets` is on.
   - Values are saved through `definition.ts`'s converters as plain objects:
     add `chain_models` to the editor state, the defaults and both
     converters.
6. **The handoff says which model each stage got.** The text returned to the
   run view names the model id of each stage it started, for example
   "coding on qwen3.8-flash".

## Build gate

The overview's gate. Prettier only on files under `src`.

## Test plan

- **Unit, config:** a missing, malformed or half-filled `chain_models` parses
  to nulls; a full one round-trips through `configToJson` and
  `configFromJob`.
- **Unit, helper:** `stageModelColumns` returns the job's columns for null,
  and the override's for a value; an `api_key_id` stays an id.
- **Unit, naming:**
  - planning with assets → the coding job is "<job> — coding";
  - planning without assets → "<job> — coding";
  - a hand-made asset job → "<asset job> — coding".
- **Unit, routing:**
  - a coding override set on the planning job reaches the coding job created
    by the asset job;
  - with only an asset override set, the coding job gets the planning job's
    model.
- **Component:** the stage pickers appear only in `unattended_chain`, and the
  asset picker only when `generate_assets` is on; JobEditor's model fields
  behave as before.
- **Manual:** run a small chain with the coding stage on a different model.
  The job list shows "<job> — coding", and that job's editor shows the chosen
  model.

## Commit

`feat(jobs): name chained coding jobs after the plan, and let each chained stage pick its model`

## Rollback

Revert the commit. Saved configs that have `chain_models` or `chain_*` fields
are ignored by the old parser, so nothing else needs undoing.
