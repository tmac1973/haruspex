# Phase 02 — Part checks: passing into, coming apart, foot slide, joints

**Depends on:** 01 · **Enables:** the report (04)

## Goal

Add the checks that look at parts against each other and against the floor
while a clip plays: a part passing into another, a part coming away from the
body, a planted foot sliding, and a knee or elbow folding the wrong way.

## Files touched

- `src/lib/glb/motionParts.ts` — new: `insideShare`, `passesAndApart`,
  `footSlides`, `jointFolds`.
- `src/lib/glb/motionParts.test.ts` — new.
- `src/lib/glb/motion.ts` — `inspectMotion` calls them per frame and fills
  `passes`, `apart`, `slides`, `joints`, `jointsChecked`.
- `src/lib/glb/motionFormat.ts` also: `formatClip` adds, after the rig line,
  `Joints checked: Shin_FL, …` or `No knee or elbow joints found by name.`
- `src/lib/glb/motionFormat.ts` — `clipProblems` phrases for the four.
- `src/lib/glb/motionFormat.test.ts` — cases for the phrases.
- `src/lib/glb/report.ts` — export `RAY` and a new
  `isClosedOpaque(mesh)`: closed by `meshShape` with the report's weld
  tolerance, and no material with `transparent && opacity < 0.99`. The
  report's buried check uses it too, so "closed" means the same in both.

## Steps

1. `insideShare(THREE, inner, host)`: the share of `inner`'s posed world
   vertices inside, sampled evenly (every `ceil(count / 16)`-th vertex, so at
   most 16), inside `host`'s closed volume, by ray parity along
   the report's fixed ray (`RAY` in `report.ts`, exported), with the host's
   materials set `DoubleSide` for the cast and restored after. For a skinned
   host the raycast already uses posed vertices (three's
   `SkinnedMesh.raycast`).
2. Passing into and coming apart, in `passesAndApart`:
   - Every box here is a mesh's own `posedBox` (01) at that frame.
   - Hosts are the meshes `isClosedOpaque` accepts. Pairs are (any mesh,
     host), never a mesh with itself.
   - At rest: for every pair whose world boxes intersect, `insideShare`. A
     pair over 5 % at rest is a joint or socket and is never reported.
   - At rest: `attached` is the meshes whose box, grown by 1 % of the
     asset's largest dimension, touches another mesh's box.
   - Each frame: a pair whose boxes intersect and whose `insideShare` is at
     least 25 % is passing into, at that time. A mesh in `attached` whose
     grown box touches no other mesh's box is coming apart, at that time.
   - Each is reported once per pair or mesh with the first and last frame
     time it was seen:
     `{ part, into, from, to }` and `{ part, from, to }`. A single skinned
     mesh has no pairs, so neither check reports for it.
3. Foot slide, in `footSlides`:
   - Each frame, for each part (`partsOf`, 01), its posed vertices at or
     below the rest floor + 1 cm (vertices sunk below the floor count); when
     there are any, the part is planted and its contact point is their mean
     (x, z).
   - A stance is a run of consecutive frames in which the part is planted.
     Its slide is the sum of horizontal moves of the contact point across the
     stance.
   - Report each part's worst stance when it slides more than 3 cm:
     `{ part, cm, from, to }`. All are returned; `clipProblems` caps them.
4. Joint folds, in `jointFolds`:
   - Joints are non-mesh nodes (bones or pivot nodes) whose name,
     lowercased, contains `knee`, `shin`, `calf` or `lowerleg` (fold
     backward) or `elbow`, `forearm` or `lowerarm` (fold forward), and which
     have a parent. Meshes are never joints. Their names fill
     `jointsChecked` whether or not they fold wrong.
   - Each frame: `a` = joint − parent and `b` = child − joint (world
     positions of the nodes). The child is the first child that is not a
     mesh and whose name doesn't contain `socket` (for a skinned rig, a child
     bone; for a rigid rig, the next pivot node). A joint with no such child,
     or whose `a` or `b` is shorter than 1 mm, is skipped. The
     fold is the signed angle from `a` to `b` about the model's side axis
     (+x): positive means the lower segment swings back (−z). A knee is
     wrong when its fold is below −10°, an elbow when above +10°.
   - Report each wrong joint once with its worst angle and the times it was
     wrong: `{ joint, degrees, from, to }`.
5. `inspectMotion` runs all four on the same 16 frames, after the phase 01
   measurements of each frame. `clipProblems` adds, after the floor and
   sanity phrases: `Mesh_Hand_R passes into Mesh_Torso at 0.40–0.45 s`,
   `Mesh_Spike comes away from the body at 0.32 s (is it under the right
   node?)`, `Mesh_Foot_L slides 6 cm while planted at 0.20–0.41 s`,
   `Bone_Shin_L bends the wrong way by 25° at 0.30 s`; at most six of each,
   with "and N more". A time range prints as one time when its first and
   last times are equal (`at 0.32 s`), otherwise as `at 0.40–0.45 s`.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/glb`

## Test plan

- Passing into: an arm box swinging through a closed torso box reports one
  pass with the right times; two boxes overlapping at rest (a joint) that
  stay overlapped report nothing; a transparent host is never a host.
- Coming apart: a box parented to the moving pivot stays attached; a box
  touching the body at rest but parented to the root, while the body moves
  away, reports coming apart. The imp case: a claw box hidden behind the
  torso from one side but still touching its hand reports nothing.
- Foot slide: a foot box on the floor that moves 10 cm sideways while
  planted reports about 10 cm; one that lifts, moves and lands reports
  nothing.
- Joints: a thigh–shin–foot chain whose shin swings back reports nothing,
  and swung forward 30° reports the shin at about −30°; an elbow chain the
  same with the opposite sign; a skinned leg named `Bone_Shin_L` is checked
  through its bones, and `formatClip` lists it under `Joints checked:`; a
  model with no such names prints `No knee or elbow joints found by name.`

## Commit

`feat(glb): check parts passing into or coming away, foot slide and joint folds in clips`

## Rollback

Revert the commit. Phase 01's fields stay as empty arrays and its tests still
pass.
