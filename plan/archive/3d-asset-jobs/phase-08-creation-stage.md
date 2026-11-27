# Phase 08 — The creation stage

**Depends on:** 04, 05, 06, 07 · **Enables:** 09, 10

## Goal
Build every spec entry on the creation model: one or more agent turns per
entry, each writing `<id>.js` and checking it with `check_3d`, gated by
`judgeModel` in code. Out of rounds, the entry is "needs work" and the run
moves on.

## Files touched
- `src/lib/agent/jobs/types/model-generation/pipeline.ts` — CREATE stage.
- `src/lib/agent/jobs/types/model-generation/create.ts` (new) — per-entry loop.
- `src/lib/agent/jobs/types/model-generation/create.test.ts` (new)
- `src/lib/agent/jobs/types/model-generation/prompts.ts` — creation system prompt and per-entry/repair messages.
- `src/lib/agent/jobs/types/model-generation/state.ts` (new) — `EntryState` per entry: `{ id, status: 'pending'|'done'|'needs_work'|'skipped', problems: string[], rounds: number, note: string|null }`.

## Steps
1. Allowlist for creation turns: `fs_read_text`, `fs_list_dir`, `fs_write_text`, `fs_edit_text`, `check_3d`, plus `draw_texture` when `cfg.allow_textures`. `writeRoot` = the entry's `dir`, so writes outside the model's folder are refused.
2. System prompt (`createSystemPrompt(spec, allowTextures)`): the build-module contract (`export default function build(THREE, kit)` returns an Object3D; no imports; kit members listed); y-up, metres, feet on y = 0; the style line; the rig rule: "Every name in Parts is an Object3D pivot placed at the joint it turns about, holding the meshes it moves, nested parent → child (Hip_L > Knee_L). Animation rotates these pivots and nothing else."; no clips (`build` returns the object only); check with `check_3d` (`path` = the `.js`, `out` = the `.glb`) and fix what it reports; look at the sheet. With textures: "draw_texture into `<dir>textures/`, then `kit.texture('textures/<name>.png')`."
3. Per entry, round 1 user message: title, description, height, parts, the files to write. Turn: `runJobTurn({ model: cfg.create_model ?? undefined, toolAllowlist, maxIterations: cfg.create_turns, turnKind: 'models.create', systemPrompt, ...buildStreamCallbacks(CREATE) })`.
4. After each turn, `judgeModel({ entry, stage: 'create' })` (phase 04). Done → write the GLB bytes it returned to `files.glb` and the sheet PNG to `files.sheet`; status `done`. Not done and `rounds < cfg.rounds` → next turn's message is the repair message: the problems list, "Fix <id>.js and check it again." Out of rounds → keep any GLB the last good build exported (write it if `judgeModel` produced one), status `needs_work`, problems kept.
5. A missing `<id>.js` after a turn is a problem "No <id>.js was written." and counts as a round.
6. The stage's step `checklist` has one entry per model (title, status). Its `description` is patched to `Build every model · <describeModel(create_model or job).label>`.
7. Cancel: the abort signal ends the current turn; the stage stops between entries when `!ctx.isLive()`.
8. Entries are done in spec order, one at a time (one inference slot per lane; no concurrency setting).
9. Keep entry states on the run (module-level map keyed by run id, as the 2D pipeline keeps its results) for phases 09–10.

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/agent/jobs/types/model-generation`, `npm run format:check`.

## Test plan
- Unit with a fake `runJobTurn` and a stubbed `judgeModel`: done first round; done on round 2 after a repair message that lists the problems; needs-work after `rounds`; `draw_texture` only in the allowlist with the box on; the turn gets `model` = `create_model`.
- Unit: `writeRoot` is the entry dir.

## Commit
`feat(jobs): 3D models creation stage, gated by judgeModel`

## Rollback
Revert; the pipeline returns to ending after the spec stage.
