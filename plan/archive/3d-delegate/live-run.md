# 3D delegate — live run (partial), 2026-11-25

An e2e build of `feat/3d-delegate` (#1252), driven with `scripts/drive.mjs`
on a private virtual KWin. Neither model was on OpenRouter: the e2e build
can't use the saved OpenRouter key, so the OpenRouter part of phase 06 is
still owed (see #1244).

- **Main model:** `tcclaviger/Qwen3.8-Flash-Next-MXFP4-FP8-GPTQ` on
  `compute:3000` (vLLM).
- **Delegate:** `mradermacher-ThinkingCap-Qwen3.8-27B-i1.Q4_K_M` on
  `compute2:3000` (llama-toolchest). It is on a different lane, so it took its
  own slot. It had vision off.
- **Project:** an empty git repo with a README ("low-poly, 1 unit = 1 m,
  assets in assets/").
- **Assets and transcript:** kept in
  `~/Projects/3d_asset_test_results/delegate-run-2026-11-25/`.

## Chest (foreground, 80 rounds, no cost limit)

The prompt was "Make a low-poly wooden treasure chest with iron bands, about
0.8 m wide, at assets/chest.glb. Hand the modelling to the 3D delegate."

| Call | Why                                        | Tool calls | Tokens | Time    | Final check |
| ---- | ------------------------------------------ | ---------- | ------ | ------- | ----------- |
| 1    | build                                      | 13         | 77k    | 3.3 min | clean       |
| 2    | fix lid gap, floating plate, hanging bands | 18         | 200k   | 7.9 min | clean       |
| 3    | fix floating dome strap, buried side bands | 12         | 116k   | 6.0 min | clean       |
| 4    | simplify straps                            | 4          | 30k    | 1.3 min | clean       |

- The main agent read each report, judged the result from the reported
  checks, and sent a revision on the same path.
- Each revision read and edited `chest.js` rather than starting over.
- After call 4, the main model made a last fix itself. It ran
  `npm install three` and wrote a `_lidtest.js` module, then asked to `rm`
  them. The command was approved, and it cleaned them up.
- The result is 0.80 × 0.61 × 0.50 m, 700 triangles, 19 meshes and 2
  materials.

## Goblin (background, 5-round cap)

The prompt was "a low-poly goblin, 1.1 m tall, with Idle and Walk clips, at
assets/goblin.glb … background: true".

- The call returned at once, and the main agent ended its turn.
- About 10 minutes later, the "A subtask you started in the background has
  finished" turn arrived with the report.
- The delegate used its 5 rounds writing `goblin.js` and `goblin.anim.js`
  and never ran `check_3d`. The final report call still produced a full
  report: what is built, "Next step (blocked by round limit)", and the
  assumptions.
- The result said `Final check: errors remain:` and named the bad track:
  Idle `Torso.quaternion` had 3 values per key, not 4.
- The main agent then sent two more capped passes. After that it rewrote the
  Walk itself as a two-link IK solver, using its own `_measure.mjs` scripts.
  The turn ended at `max_iterations`.
- The result is 0.55 × 1.09 × 0.46 m, 588 triangles, and Idle and Walk
  clips.

## What worked

- `delegate_3d` was offered with the helper on and a model set. Its calls
  went to the delegate server.
- Writes stayed inside the three files.
- The tokens on each card add up. The cost is null, because neither server
  reports one.
- The final check reuses the delegate's own `check_3d` options.
- Foreground runs, background runs, the round cap, the report call at the
  cap, and the "errors remain" wording all worked.

## Not covered here

- The cost limit. No server reported a cost, so this needs OpenRouter. Unit
  tests cover the logic.
- A frontier delegate. The point of the feature is untested until an
  OpenRouter model runs it.
- The session total against the OpenRouter activity page.

## Things to tune

1. **The delegate writes an anim module for a static prop.** It wrote
   `chest.anim.js` returning `[]`. Fix: the prompt says to write it only
   when the task asks for clips.
2. **A capped delegate never ran `check_3d`.** With 5 rounds it spent every
   round writing. Fix: the prompt says to run `check_3d` as soon as the
   module builds, before polishing.
3. **The main model takes over 3D work.** After unsatisfying delegate
   results, a capable main model builds and debugs assets itself. That
   spends the local model's tokens rather than frontier ones, which is
   fine, but it ignores the TOOLS line ("not to build one"). Watch this with
   a frontier delegate before changing anything.
4. **A possible false positive in the motion check.** The checker kept
   saying Walk is "off the floor by 11 cm at 0.00 s", while the main
   model's own sampling of 80 frames showed a foot on the ground
   throughout.
