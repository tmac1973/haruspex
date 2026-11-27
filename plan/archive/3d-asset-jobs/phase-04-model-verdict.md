# Phase 04 — A structured verdict for one model

**Depends on:** 01, 02, 03 · **Enables:** 08, 09, 10

## Goal
`check_3d` returns text only. The job must decide "done" in code, not by
parsing prose. Add `judgeModel()`: build (with anim and textures), check, and
compare with the spec entry, returning a verdict the pipeline gates on and the
same text and sheet the agent sees. `check_3d` is refactored onto the same
loader so both paths judge a model identically.

## Files touched
- `src/lib/glb/verdict.ts` (new) — `judgeModel`.
- `src/lib/glb/verdict.test.ts` (new).
- `src/lib/helpers/three/load.ts` (new) — `loadModuleRun(paths, io, signal)`: reads build/anim sources and their textures, calls `runBuildModule`. Extracted from `check-3d.ts`'s `source()`.
- `src/lib/agent/tools/check-3d.ts` — uses `loadModuleRun`.

## Steps
1. Move the module branch of `source()` plus phase 02's texture collection into `loadModuleRun({ build, anim? }, { read, cwd, signal })` returning `{ glb, missing, errors: ModuleError[] }`. `check-3d.ts` calls it; its output text must not change (existing tests stay green).
2. `judgeModel({ entry, files, stage: 'create' | 'animate', io, signal })`:
   - runs `loadModuleRun` with `anim` only when `stage === 'animate'`;
   - errors → `{ done: false, problems: [...error lines], glb: null }`;
   - `checkGlb(glb, {})` → hard problems become problems; `report.problems` become problems; `report.warnings` are kept as warnings and do not block;
   - height: measured bounds height vs `entry.height_m`, more than 10% off → problem `Height is X m; the spec says Y m (±10%).`;
   - parts: every `entry.parts` name must be a node in the GLB (load the GLB with `glb/load.ts` and use `scene.getObjectByName`; the report's part list holds meshes only, not pivot groups) → problem `Missing part "<name>": name the pivot exactly so.`;
   - `stage === 'animate'`: every spec clip name present (`Missing clip "Walk".`), `missing` tracks are problems, and each clip's `clipProblems` (from `glb/motionFormat.ts`) are problems; a clip marked `loop` whose seam check fails is a problem, a non-loop clip's seam line is ignored;
   - returns `{ done: problems.length === 0, problems, warnings, text, sheetPng, clipSheets: Record<string,string>, glb }` where `text` is exactly what `check_3d` would say for the same inputs and `clipSheets` holds a motion sheet per clip (animate stage only).
3. `judgeModel` never writes files; the pipeline writes.
4. Tests with the fixtures in `src/lib/glb/motionFixtures.ts`: height off, part missing, clip missing, clean → done.

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/glb src/lib/helpers/three src/lib/agent/tools/check-3d`, `npm run format:check`.

## Test plan
Unit tests above. `check-3d.test.ts` unchanged and passing proves the refactor kept the tool's output.

## Commit
`feat(glb): judgeModel gives a structured verdict against a models.json entry`

## Rollback
Revert; `check_3d` goes back to its inline loader.
