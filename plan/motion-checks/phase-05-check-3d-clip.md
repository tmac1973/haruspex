# Phase 05 — `check_3d`'s `clip`, missing targets and the guide

**Depends on:** 01, 04 · **Enables:** the live rerun (06)

## Goal

Expose the motion checks to the agent: `check_3d` takes `clip`, its
description gains one line on animating, a build module's tracks that name a
missing node are reported, and the `helpers` guide page says what the agent
now gets.

## Files touched

- `src/lib/agent/tools/check-3d.ts` — `clip` parameter, description line,
  missing-target line, the sheet note.
- `src/lib/agent/tools/check-3d.test.ts` — cases below.
- `src/lib/helpers/three/runModule.ts` — find missing targets before export.
- `src/lib/helpers/three/runModule.test.ts` — the page script posts them.
- `src/lib/helpers/three/helper.ts` — tooltip mentions clips.
- `docs/guide/helpers.md` — what the agent gets for clips, and what it
  doesn't do.

## Steps

1. Schema: `clip` (string): "An animation clip's name: show that clip moving
   instead of the still sheet." Validated as a non-empty string after trim;
   anything else is refused like the other arguments.
2. Description: append after "returns an Object3D, or { object, animations }
   for clips" one line:
   > Animate with tracks on named nodes, e.g. new
   > THREE.QuaternionKeyframeTrack('Shin_L.quaternion', [0, 0.5], [...]);
   > every call checks each clip, and clip: "Walk" shows that clip moving.
3. `execute` passes `clip` to `checkGlb`. A wrong clip name comes back as
   `checkGlb`'s problems and is shown like any other failed check, through
   the existing `failed()` block ("The check failed. - No clip named Z.
   Clips: A, B. Fix … and call check_3d again."), writing nothing. When `checked.clip` is set and the
   sheet is attached, the note is "The motion sheet is attached (right and
   front frames, then all frames overlaid with trails of the fastest parts):
   check each frame is a pose you meant before you finish." instead of
   `SHEET_NOTE`. `clip` is passed for `.glb` input too.
4. Missing targets: the runner's page script, after `build()` returns and
   before `GLTFExporter`, collects the track names whose node
   `kit.THREE.PropertyBinding.findNode(object, nodeName)` doesn't find
   (`PropertyBinding.parseTrackName(name).nodeName`) and posts `{ t: 'hx-missing',
   tracks }`. `ModuleRunResult` gains `missingTracks: string[]` (empty by
   default). `check_3d` puts one line before the report when there are any:
   "Tracks naming a node the model doesn't have (the exporter dropped them,
   so they do nothing): A, B." (first 12 names).
5. Tooltip: "Runs a Three.js build module or checks a .glb file, then shows
   the agent a six-view render, a size and parts report and checks on each
   animation clip, or one clip moving. Needs no model and no network."
6. Guide `helpers.md`, under The 3D helper: a **clips** bullet ("each
   animation clip: through or off the floor, parts passing into others or
   coming away, feet sliding, knees or elbows bending the wrong way, the loop
   seam"), and a sentence that the agent can ask to see one clip moving (8
   frames from the side and front, overlaid with trails). Replace the "What
   it doesn't do" animation bullet with: it can't tell whether a motion
   looks good, only what's physically wrong; it doesn't rig, skin or fix
   clips. Keep the page under 6000 bytes and its tables compact (no
   Prettier on the guide).

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/agent/tools/check-3d.test.ts src/lib/helpers src/lib/guide`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- `check-3d.test.ts` (checkGlb mocked as today): `clip` reaches `checkGlb`;
  an empty `clip` is refused; with `checked.clip` set the note is the motion
  note; `missingTracks` from the runner produce the line before the report;
  a `.glb` with `clip` passes it through and writes nothing.
- `runModule.test.ts`: the page string contains the missing-target pass
  before the exporter, and an `hx-missing` message fills `missingTracks`.
- `src/lib/guide/pages.test.ts` passes (size, frontmatter).

## Commit

`feat(helpers): check_3d checks animation clips and shows one moving`

## Rollback

Revert the commit; `checkGlb` still returns clip lines (04) but the agent
can't ask for a clip and no missing-target line appears.
