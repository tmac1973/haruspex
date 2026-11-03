# Phase 10 — The animation stage, final export and report

**Depends on:** 01, 03, 04, 05, 08, 09 · **Enables:** 11, 12, 13

## Goal
For every kept entry with clips, the animation model writes `<id>.anim.js`
and checks each clip. The final GLB holds model and clips. The run writes
`REPORT-models.md` with each model's state, sheets and problems.

## Files touched
- `src/lib/agent/jobs/types/model-generation/animate.ts` (new)
- `src/lib/agent/jobs/types/model-generation/animate.test.ts` (new)
- `src/lib/agent/jobs/types/model-generation/report.ts` (new)
- `src/lib/agent/jobs/types/model-generation/report.test.ts` (new)
- `src/lib/agent/jobs/types/model-generation/prompts.ts` — animation prompt.
- `src/lib/agent/jobs/types/model-generation/pipeline.ts` — ANIMATE and REPORT stages.

## Steps
1. Entries animated: status `done` or `needs_work` (a needs-work model that built still gets clips), clips non-empty, not skipped. Others pass through.
2. Before the first animation turn of an entry, hash `<id>.js` (SHA-256 of its bytes via `crypto.subtle`).
3. Allowlist: `fs_read_text`, `fs_list_dir`, `fs_write_text`, `fs_edit_text`, `check_3d`. `writeRoot` = entry dir. A write to `<id>.js` is caught after the turn by the hash (step 6).
4. System prompt (`animateSystemPrompt`): the animation-module contract (`export default function animate(THREE, object, kit)` returns `AnimationClip[]`; no imports; find pivots with `object.getObjectByName`; animate only the named pivots with `QuaternionKeyframeTrack` / `VectorKeyframeTrack` on `<name>.quaternion` / `<name>.position`; looping clips end on their first pose); "Do not edit <id>.js."; check each clip with `check_3d` `path` = `<id>.js`, `anim` = `<id>.anim.js`, `out` = `<id>.glb`, `clip` = the name; look at the motion sheet.
5. First message: the entry, its parts, its clips (name, seconds, loop, action), and `<id>.js` content so the model sees the hierarchy. Turn on `cfg.animate_model`, `maxIterations: cfg.animate_turns`, `turnKind: 'models.animate'`.
6. After each turn: if the hash of `<id>.js` changed, restore it from the bytes read at step 2 and add problem "<id>.js was changed; it was put back. Change only <id>.anim.js." Then `judgeModel({ stage: 'animate' })`. Done → write the GLB and each clip sheet (`files.clipSheet(name)`). Not done → repair rounds as in creation, up to `cfg.rounds`; out of rounds → status `needs_work` with clip problems, and the GLB written is the last one that built (model plus whatever clips exported), or the creation GLB if none did.
7. Stage `description` patched to `Animate the models with clips · <animation model label>`; checklist per animated entry.
8. Report (`renderModelReport`): `# 3D models report`; a table `| Model | State | Height | Parts | Clips | Problems |`; per model a section with its `sheet.png` and each clip sheet, linked by a path relative to the report's folder (`relativePath(reportDir, files.sheet)`, a small helper in `report.ts`; the 2D report sits beside its spec the same way), open problems and warnings; a line naming the creation and animation model labels. Written to `REPORT-models.md` beside the spec. The run's final output is the table plus the report path.
9. A run where any model is needs-work still ends `done` (the report says what is open); a run where no model built ends `error` with "No model built."

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/agent/jobs/types/model-generation`, `npm run format:check`.

## Test plan
- Unit with fakes: animation turn uses `animate_model`; changed `<id>.js` is restored and reported; clip missing → repair round; out of rounds → needs work keeps creation GLB; entries without clips skip the stage.
- Unit: report renders done, needs-work and skipped rows and both model labels.

## Commit
`feat(jobs): 3D models animation stage and report`

## Rollback
Revert; runs end after creation (and review).
