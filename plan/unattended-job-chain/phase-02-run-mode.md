# Phase 02 — Run mode and the skippable final approval

**Depends on:** nothing · **Enables:** Phase 05 (the chain is a third value of this setting)

## Goal

Add the `run_mode` setting to guided planning and make the final approval
checkpoint conditional on it, so a user can leave a planning run and come back
to a finished plan. Ships two of the three values — `attended` (today's
behaviour) and `unattended_plan`. The third, `unattended_chain`, arrives in
Phase 05 with the machinery that makes it true; offering it earlier would name a
mode that does nothing.

## Files touched

- `src/lib/agent/jobs/types/guided-planning/config.ts` — add `run_mode: 'attended' | 'unattended_plan'` (widened in Phase 05), parsed with `attended` as the default so every existing job is unchanged.
- `src/lib/agent/jobs/types/guided-planning/config.test.ts` — parse, default, and unknown-value coverage.
- `src/lib/agent/jobs/types/guided-planning/pipeline.ts` — the APPROVAL stage starts and finishes in every mode, but skips its `askUserQuestion` loop when the mode is not `attended`.
- `src/lib/agent/jobs/types/guided-planning/Editor.svelte` — the mode selector.
- `src/lib/agent/jobs/runner.test.ts` — harness coverage that the run issues no approval prompt in the unattended mode.

## Steps

1. Add `run_mode` to `GuidedPlanningConfig`, parsed against the known set with anything unrecognised falling back to `attended` — a malformed config must not silently make a run unattended.
2. In the pipeline's APPROVAL stage, keep `startStep(APPROVAL)` and `finishStep(APPROVAL, …)` unconditional, and wrap only the `while (!planApproved)` loop in a mode check. This follows the VERIFY precedent: the stage index stays put and the run view shows what was skipped rather than renumbering the stages around it.
3. When the loop is skipped, finish the stage with text naming the mode, e.g. `Approved automatically — run mode is "Unattended plan"`, so the run view never implies a human approved it.
4. Leave the OVERVIEW and OUTLINE checkpoints untouched in every mode. They land inside the window where the user is already answering interview questions, and they are the cheapest place to catch a bad overview.
5. Add the selector to the Editor. Copy is one short sentence per the project convention; the detail about which prompts remain goes in a `title` tooltip.
6. Write the tests listed under Test plan.

## Build gate

```
npm run check && npm run lint && npm run test && npm run format:check
```

## Test plan

- `parseGuidedPlanningConfig(null).run_mode === 'attended'`; an explicit `unattended_plan` parses through; `'{"run_mode":"nonsense"}'` falls back to `attended`.
- Runner harness, `unattended_plan`: the run reaches `succeeded` with `askUserQuestion` called for the overview and outline checkpoints but **not** after them, and the APPROVAL stage (index 4, per the overview's numbering convention) finishes with output naming the mode.
- Runner harness, `attended`: the approval prompt is still issued — the existing tests cover this and must keep passing unchanged.
- The APPROVAL stage still starts and finishes in both modes, at an unchanged step index. Asserted as "the stage is present and reports its outcome", not as a total stage count — Phase 05 adds a sixth stage, and a count assertion here would become false the moment it lands.

## Commit

`feat(jobs): add a run mode to guided planning and make final approval optional`

## Rollback

Revert the commit. `run_mode` is additive and defaults to `attended`, so a job
authored with `unattended_plan` reverts to prompting for approval — which blocks
an unattended run rather than letting one proceed unsupervised, the safe
direction to fail.
