# Phase 06 — Live rerun

**Depends on:** 05 · **Enables:** release

## Goal

Measure the shipped feature against the overview's bar with Qwen 3.8 on
compute:3000: the imp attack task three times without motion feedback and
three times with it, plus one skinned walk made from scratch with it. Keep a
script that draws any GLB's clip as a motion sheet, so reruns can be judged
the same way.

## Files touched

- `scripts/drive/motion-sheet.mjs` — new, two modes, both in Playwright
  Chromium:
  Both rely on what already exists on `main`: `loadGlb` in
  `src/lib/glb/load.ts` and the kit build (`npm run build:three-kit`, from
  #944).
  - `node scripts/drive/motion-sheet.mjs out.png file.glb Clip` renders the
    app's own motion sheet and prints the clip detail. Its entry point
    (`scripts/drive/motion-sheet-entry.ts`, bundled with esbuild into the
    page) imports `loadGlb`, `inspectMotion`, `formatClip` and
    `renderMotionSheet` from `src/lib/glb/`.
  - `node scripts/drive/motion-sheet.mjs --build module.js out.glb` runs a
    build module with the bundled kit (`static/helpers/three-kit.js`, built
    by `npm run build:three-kit`) and writes its GLB, as `check_3d` does.
- `scripts/drive/motion-sheet-entry.ts` — new: the page's entry.
- `docs/testing.md` — under "Judging 3D output", how to run both modes.
- No app code. Findings that need code become one GitHub issue.

## Steps

0. The starting module already exists:
   `/home/tim/projects/spike3d/anim/original/imp_base.js`, saved
   2026-11-02 from the module the spike started from. Every imp run copies
   it into its folder's `assets/`.
1. "Without" arm first. In `/home/tim/projects/haruspex-build`, check out
   `main` at the commit before phase 01 and `npm run e2e:app:build`. Then
   `npm run drive -- start --base-url http://compute:3000` and
   `npm run drive -- settings '{"codeHelpers":{"3d":true}}'`.
2. Three sessions, folders `/home/tim/projects/spike3d/anim2/a1`, `a2`,
   `a3`, each sent the prompt below with `--wait`, one after another. Save
   each transcript (`state <id> --transcript > transcript.md`) in its folder.
   Then `npm run drive -- stop`.
3. "With" arm. Check out the feature branch, `npm run e2e:app:build`, start
   and set the same settings, and run folders `b1`, `b2`, `b3` the same way.
4. Prompt for every imp run, verbatim, as in the spike: "The Attack clip in
   assets/imp_base.js looks wonky. Rework it into a convincing claw swipe
   with the right arm: a wind-up, a fast strike across the body, and a
   recovery back to the start pose. Keep the model and the other clips as
   they are. Rebuild assets/imp_base.glb and check your work with check_3d
   before you finish."
5. Skinned walk, still in the "with" build, folder `anim2/skinned`: "Create
   a low-poly lizard as a single skinned mesh with a skeleton
   (THREE.SkinnedMesh and THREE.Skeleton) and a looping walk cycle named
   Walk. Name the leg bones Thigh_FL, Shin_FL, Foot_FL and so on for each
   leg. Save it as assets/lizard.glb." Save its transcript, then
   `npm run drive -- stop`.
6. For every run, rebuild its final module so each is judged on its last
   code. From `/home/tim/projects/haruspex-build`, with `R` the run's folder
   (e.g. `/home/tim/projects/spike3d/anim2/a1`): `node
   scripts/drive/motion-sheet.mjs --build $R/assets/imp_base.js
   $R/assets/final.glb`, then `node scripts/drive/motion-sheet.mjs
   $R/attack.png $R/assets/final.glb Attack`, saving the printed detail as
   `$R/detail.txt`. For the lizard, the module the run wrote (named in its
   transcript) and clip `Walk`, writing `$R/walk.png` and `$R/detail.txt`.
7. Judging: Claude compares each pair's motion sheets (a1 with b1, a2 with
   b2, a3 with b3) for which reads more as a wind-up, a fast strike across
   the body and a recovery to the start pose, and writes one sentence of
   reasons per pair. The six sheets go in the PR body so Tim can overrule.
   Also record per run: tool calls, `check_3d` calls and how many used
   `clip`, whether the run itself rebuilt the GLB, and the final clip line.
8. Pass, as in the overview: every "with" run rebuilt its GLB; at least two
   of three pairs favour "with"; and the lizard's `detail.txt` shows a
   `Rig: skinned` line, a Walk that ends under 2 cm from its start, no floor
   or joint problems, and a `Joints checked:` line naming its Shin bones. Record
   the result in the PR body; file shortfalls as one issue with a checklist.

## Build gate

- `npm run lint` (the new script)
- `node scripts/drive/motion-sheet.mjs /tmp/x.png /home/tim/projects/spike3d/anim/b-motion/assets/imp_base.glb Attack` writes a PNG.

## Test plan

The rerun is the test. The script is checked by rendering the spike's imp
Attack: the PNG has the 18-cell layout and labels of
`/home/tim/projects/spike3d/anim/b-motion-attack.png` (Claude looks at
both), and `--build` on `/home/tim/projects/spike3d/anim/original/imp_base.js`
writes a GLB the render mode opens.

## Commit

`test(helpers): motion sheet script for judging agent-made clips`

## Rollback

Revert the commit; it adds a script and a docs note only.
