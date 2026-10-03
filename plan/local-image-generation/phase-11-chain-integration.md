# Phase 11 — Chain integration: planning → assets → coding

**Depends on:** 10 (only a checked run is safe to chain unattended) ·
**Enables:** the overnight flow the overview's chained path describes.

## Goal

Put the asset job into the unattended chain between planning and coding. Guided
planning gains a stage that writes the asset spec from the plan it just wrote,
and its handoff starts the asset job instead of the coding job when assets are
wanted. The asset job's own handoff then starts the coding job, so the coding run
builds against art that already exists on disk. Nothing asks a question anywhere
after guided planning's step 2.

## Files touched

- `src/lib/agent/jobs/types/guided-planning/config.ts` — add
  `generate_assets: boolean`. There is deliberately no `asset_run` override
  block: the handoff passes the three fields it actually sets (spec path, run
  mode, carried coding config), and an override object nothing reads would be
  the same unchecked claim `controlNet` was.
- `src/lib/agent/jobs/types/guided-planning/pipeline.ts` — add the `ASSETS`
  stage and rework `handoff()` to start the asset job when enabled.
- `src/lib/agent/jobs/types/guided-planning/prompts.ts` — add
  `assetSpecPrompt(planDir, outDir)`.
- `src/lib/agent/jobs/types/guided-planning/definition.ts` — new stage in the
  stage list; editor state for the new fields.
- `src/lib/agent/jobs/types/guided-planning/Editor.svelte` — an "Also generate
  assets" toggle inside the chain settings.
- `src/lib/agent/jobs/types/asset-generation/pipeline.ts` — fill in the
  `HANDOFF` stage phase 06 already declared, starting the coding job on a
  chained run. No stage is added and no stage index moves, so phase 06's
  stage-title test is untouched.
- `src/lib/agent/jobs/types/asset-generation/tools.ts` — add
  `submit_plan_asset_spec`, the chained-derivation tool whose entries carry an
  explicit `id`. It is invoked by guided planning's `ASSETS` stage, not by the
  asset job, which on a chained run receives a finished spec and derives
  nothing.
- `src/lib/agent/jobs/types/autonomous-coding/config.ts` — add
  `asset_spec_path: string | null`, default null.
- `src/lib/agent/jobs/types/autonomous-coding/prompts.ts` — when it is set,
  preflight checks the plan's asset ids against the spec.
- `src/lib/agent/jobs/runner.test.ts` — chain tests.

## Steps

1. Guided planning's new `ASSETS` stage runs after verification and before the
   approval checkpoint — which in `unattended_chain` is already auto-approved
   and asks nothing, so the stage's position does not put a question after the
   outline stage. (In `attended` mode the checkpoint still asks, and
   `generate_assets` chains nothing there.) It reads the finished plan and emits an asset spec with
   the same forced-tool mechanism phase 07 uses, then validates and writes it.
   Skipped entirely when `generate_assets` is false, but the stage still starts
   and finishes so stage indices never shift — the same rule the verification
   stage already follows.
2. The spec's entry ids **must** be the content ids the plan names. Unlike
   phase 07's standalone derivation — where the runner slugifies titles because
   there is no plan to take ids from — this stage uses `submit_plan_asset_spec`,
   whose entries carry an explicit `id`, and the runner validates each against
   phase 05's shape rule rather than inventing or slugifying it. The stage output lists them.
   To make "the coding run must honour them" real rather than hoped:
   - the stage appends an "## Assets" section to the plan's `overview.md`
     listing every id and its output path, so the ids are in the document the
     coding run reads;
   - the created coding job's `type_config` carries `asset_spec_path`, and its
     preflight is told to check that every asset id it plans to reference
     appears in that spec. That is a one-line addition to
     `autonomous-coding/config.ts` and to `preflightPrompt`, listed below.
3. Rework `handoff()`. With `generate_assets` on **and an image backend
   configured**, it creates and starts the **asset** job with the `chained`
   trigger, passing the spec path, `run_mode: 'unattended'`, and the coding
   job's configuration nested for the asset job to forward. With
   `generate_assets` on but no backend configured, it skips the asset job,
   starts the coding job directly, and says so in the handoff output — a night's
   work must not be lost to a setting, and the editor's toggle is disabled with
   the same explanation so the case is rare. With it off, behaviour is exactly
   as today.
4. The asset job's `HANDOFF` stage, on a `chained` run, creates and starts the
   coding job from the carried configuration. On a manual run it reports that
   nothing was chained and why, the same shape guided planning's handoff uses.
5. `run_mode` for an asset job is forced to `unattended` whenever the run's
   trigger is `chained`, resolved in the pipeline next to the other
   trigger-derived values — a hand-edited config must not be able to park an
   overnight chain on the anchor modal. (Note the two distinct names: `chained`
   is the `RunTrigger` value; `unattended_chain` is guided planning's own
   `run_mode`. This rule keys on the trigger.)
6. Reuse `startChainedRun` on `JobRunContext` for both new handoffs. It exists
   precisely to avoid the circular import a direct runner call would create, and
   the Editor test that caught that cycle must keep passing.
7. The asset job's handoff reports what it started and carries forward any
   unresolved entries as a note on the coding job's description, so the coding
   run's preflight can see which art is missing.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Guided planning with `generate_assets` off behaves exactly as today: the
  coding job is created and started, and the asset job is never created.
- With it on: an asset job is created with the spec path and
  `run_mode: 'unattended'`, started with the `chained` trigger, and no coding
  job is created by guided planning.
- The asset job on a chained run creates and starts the coding job; on a manual
  run it creates none and says so.
- `generate_assets` on with no image backend configured: no asset job is
  created, the coding job is started directly, and the handoff output says why.
- End-to-end in the runner harness: planning → assets → coding, asserting the
  order of `createJob` / `createJobRun` calls and that **no turn anywhere after
  guided planning's outline stage has `ask_user_question` in its allowlist**.
  That single assertion is the guarantee this whole branch exists to protect.
- A hand-edited asset config with `run_mode: 'attended'` and a `chained`
  trigger still runs unattended. Verify it has teeth by removing the forcing
  line.
- The plan's `overview.md` gains an "## Assets" section listing every id, and
  the created coding job's config carries `asset_spec_path`.
- A chained-stage tool payload with an id failing the shape rule is rejected,
  rather than silently slugified the way phase 07 would.
- Stage indices: a guided-planning run with `generate_assets` off still reports
  the same number of stages, with the assets stage marked skipped; the asset
  job still reports five stages in both trigger modes.
- No circular import: the existing Editor import-cycle test still passes.

## Commit

```
feat(jobs): chain guided planning through asset generation into coding
```

## Rollback

Revert `handoff()` to starting the coding job directly, delete the `ASSETS`
stage and the asset job's `HANDOFF`, and drop the two config fields. Existing
guided-planning jobs are unaffected because `generate_assets` defaults to false;
an asset job already created keeps working standalone.
