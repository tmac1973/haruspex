# Phase 07 — Live rerun against the spike

**Depends on:** 06 · **Enables:** release, and a measured baseline for future
helpers

## Goal

Prove the feature against the overview's bar: Qwen 3.8 on compute:3000, in the
driven e2e app with only the 3D helper on, runs the spike's potion and demon
prompts; both export on the first call with no script error, come out
grounded at a sensible size, and render at least as well as spike setup B.
Keep the judge script so the comparison can be repeated.

## Files touched

- `scripts/drive/judge3d.mjs` — new: renders GLBs from four angles (front,
  three-quarter, side, back) in Playwright Chromium with the repo's `three`,
  one row per GLB, into a PNG (the spike's scratch judge, cleaned up).
- `docs/testing.md` — a short "Judging 3D output" note under "Driving the app
  with a real model": how to run the judge.
- No app code changes. Findings that need code become a GitHub issue.

## Steps

1. Build the e2e app from a sibling worktree outside `.claude/worktrees`
   (`/home/tim/projects/haruspex-build`): `npm run e2e:app:build`.
2. `npm run drive -- start --base-url http://compute:3000 --auto-approve`.
3. `npm run drive -- settings '{"codeHelpers":{"3d":true},"specialists":[]}'`.
4. Two empty folders, `/home/tim/projects/spike3d/c-potion` and `c-demon`,
   each with `assets/`. One session in each; send, verbatim:
   - "Create a game-ready low-poly 3D asset of a mana potion. Save it as
     assets/mana_potion.glb."
   - "Create a game-ready low-poly 3D model of a demon character: red skin,
     large curved black horns, bat wings, cloven hooves and a tail. Save it as
     assets/demon.glb."
5. Wait for both turns; save `state <id> --transcript` for each.
6. Judge: `node scripts/drive/judge3d.mjs comparison.png` with the spike's B
   outputs (`/home/tim/projects/spike3d/b-*/assets/*.glb`) and the new C
   outputs, rows interleaved.
7. Check the bar from the transcripts and the judge image:
   - the first `check_3d` call without a script error wrote the GLB;
   - the final report's feet are at y = 0.00 (± 0.01) and height is between
     0.1 m and 3 m for the potion and 1 m and 4 m for the demon;
   - side by side, each C asset has no defect B lacks (missing or one-sided
     parts, floating parts, broken symmetry).
8. Stop the driver. Record the result (pass/fail per criterion, the
   comparison image path, turn times and `check_3d` call counts) in the PR
   body; file any shortfall as one GitHub issue with a checklist.

## Build gate

- `npm run lint` (covers the new script)
- `npm run format:check`
- the live run in Steps passes every criterion in step 7

## Test plan

The live run is the test. If a criterion fails, rerun once to tell a fluke
from a pattern (the spike was one sample per cell); two failures on the same
criterion is a shortfall to fix before release.

## Commit

`test(helpers): 3D judge script and live rerun notes`

## Rollback

Revert the commit: the judge script and the docs note go; the app is
untouched.
