# Phase 01 — Clip sampling and track checks

**Depends on:** nothing · **Enables:** the part checks (02), the motion sheet
(03) and the report (04)

## Goal

Pose a loaded GLB at any time in any clip, rigid or skinned, and read its
world-space vertices there. On that, measure every clip for the checks that
need only the whole model and the tracks: floor contact, loop seam, root
drift, dead tracks, big jumps and clip sanity. Write the one-line-per-clip
summary and one clip's detail. Pure and tested; nothing calls it yet.

## Files touched

- `src/lib/glb/motionPose.ts` — new: `poser`, `forEachWorldVertex`,
  `strideFor`, `posedBox`, `partsOf`, `partCentre`.
- `src/lib/glb/motionPose.test.ts` — new.
- `src/lib/glb/motionTracks.ts` — new: `trackChecks`.
- `src/lib/glb/motionTracks.test.ts` — new.
- `src/lib/glb/motion.ts` — new: `ClipMotion`, `inspectMotion`, constants.
- `src/lib/glb/motion.test.ts` — new.
- `src/lib/glb/motionFormat.ts` — new: `clipProblems`, `formatClipLines`,
  `formatClip`.
- `src/lib/glb/motionFormat.test.ts` — new.

## Steps

1. `motionPose.ts`:
   - `poser(THREE, root, clip)` returns `{ at(t), stop() }`. It makes an
     `AnimationMixer` on `root`, plays `clip` with `LoopOnce` and
     `clampWhenFinished = true` (so `at(duration)` holds the last pose instead
     of wrapping to the first), and `at(t)` calls
     `mixer.setTime(min(t, duration))` then `root.updateMatrixWorld(true)`.
     `stop()` stops the action, uncaches the root and updates matrices, which
     restores the rest pose (three restores a binding's original state when no
     action uses it).
   - `forEachWorldVertex(THREE, mesh, stride, fn)` calls `fn(x, y, z)` for
     every `stride`-th vertex in world space. For a `SkinnedMesh` it uses
     `mesh.getVertexPosition(i, v)` (which applies the skeleton) then
     `applyMatrix4(mesh.matrixWorld)`; for a plain mesh,
     `fromBufferAttribute` then `matrixWorld`.
   - `posedBox(THREE, meshes, stride)`: the world box of the posed vertices
     (via `forEachWorldVertex`), so a skinned mesh's box follows its pose.
     Every box, centre and lowest point in these checks and the motion sheet
     comes from it, never from `Box3.setFromObject`.
   - `strideFor(meshes)`: 1 when the asset has 20,000 vertices or fewer,
     otherwise `ceil(total / 20000)`, so a frame reads at most ~20k vertices.
   - `partsOf(THREE, root)`: the **parts** every per-part measure uses
     (trails, seam, foot slide). A plain mesh is one part, named after the
     mesh. A skinned mesh is split by the bone with the largest weight on
     each vertex; each bone with vertices is a part named after the bone. A
     part is `{ name, mesh, indices }` (its vertex indices; every vertex for
     a plain mesh). Names are made unique in traversal order: a second part
     with a name already taken becomes `Name #2`, then `#3`.
     `partCentre(THREE, part, stride)` is the mean of its
     posed world vertices, taking every `stride`-th index.
2. `motionTracks.ts`, pure on `AnimationClip`s:
   - `trackChecks(clip)` returns `{ dead, jumps, sanity }`:
     - `dead`: tracks with 2+ keys whose values never differ from the first
       key's by more than 1e-5;
     - `jumps`: for `.quaternion` tracks, consecutive keys whose rotation
       differs by more than 90° (`2·acos(|q₁·q₂|)`), with the later key's
       time; at most 4 reported per clip;
     - `sanity`: phrases for a clip of length 0, a clip whose every track
       has one key, and keys after `clip.duration + 1e-4`.
3. `motion.ts`:
   - Constants: `ANALYSIS_FRAMES = 16`, `FLOOR_SINK = 0.01`,
     `FLOOR_LIFT = 0.02` (metres).
   - `ClipMotion`: `name`, `duration`, `tracks`, `rig` (`'skinned'` when any
     mesh is a `SkinnedMesh`, else `'rigid'`), `bones` (skeleton bones, or
     animated non-mesh nodes for a rigid rig), `sink`, `sinkAt`, `lift`,
     `liftAt`, `seam`, `seamPart`, `drift`, `dead`, `jumps`, `sanity`,
     `fastest` (names of the five parts, from `partsOf`, whose centres
     travel furthest), and the
     part-check fields phase 02 fills (`passes`, `apart`, `slides`,
     `joints`, `jointsChecked`), declared now as empty arrays.
   - `inspectMotion(THREE, gltf)` returns `ClipMotion[]` and leaves the scene
     in its rest pose. At rest it records `posedBox`'s min y (the floor) and
     its centre. For each clip it samples `ANALYSIS_FRAMES`
     evenly over `[0, duration]` and records: the deepest dip below the rest
     floor and the highest rise of the lowest point above it, with times;
     the largest horizontal distance of the box centre from rest (drift);
     each part's centre path length (for `fastest`) and its first and last
     centre (for `seam`, the largest first-to-last distance, and the part
     that has it). Because a skinned mesh's parts are its bones, its trails
     and seam follow the limbs, not the whole mesh.
   - With no clips it returns `[]`.
4. `motionFormat.ts`:
   - `clipProblems(c)`: short phrases in this order: through the floor
     (`> FLOOR_SINK`), off the floor (`> FLOOR_LIFT`), each sanity phrase,
     then the phase 02 checks, then jumps, then dead tracks (first six
     names). Times as `0.48 s`, distances in whole cm.
   - `formatClipLines(clips)`: `''` for no clips; otherwise a heading, `Clip checks (pass clip to see
     one moving):`, then one line per clip:
     `- Walk (0.82 s, 18 tracks, ends 1 cm from its start): no problems found.`
     or the problems joined with `; `.
   - `formatClip(c, sheet)`: the clip's detail: length and tracks, what the
     motion sheet shows when `sheet` is true (rows, overlay, which parts the
     trails follow), the rig (`Rig: skinned, 14 bones.` or `Rig: rigid, 18
     animated nodes.`), the seam with the part that moves most and "a loop needs
     this near 0", the drift, and the problems or "No problems found."

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/glb`

## Test plan

- `motionPose.test.ts`: two meshes both named `Leg` come out of `partsOf`
  as `Leg` and `Leg #2`; a skinned cylinder's `posedBox` at a bent pose
  differs from its rest box; a box under a pivot `Object3D` with a clip rotating
  the pivot 90° about z: `at(duration)` puts the box where the rotation
  says, not back at rest, and `stop()` restores the rest position. A
  two-bone skinned cylinder (built in the test with `Skeleton` and
  `skinIndex`/`skinWeight`) whose upper bone rotates: its posed top vertices
  move, and `partsOf` splits it into the two bones.
- `motionTracks.test.ts`: a constant track is dead; a quaternion track with a
  120° step reports one jump at the later key; a 0-length clip, a one-key
  clip and a key past the end each give a sanity phrase.
- `motion.test.ts`: a clip moving the model down 3 cm reports `sink` ≈ 0.03
  at the right time; one lifting it 5 cm reports `lift`; a clip that ends
  where it starts has `seam` ≈ 0 and one that doesn't names the moving part;
  a clip sliding the model 0.2 m sideways reports `drift` ≈ 0.2; the scene is
  at rest afterwards.
- `motionFormat.test.ts`: the summary line for a clean clip and for one with
  several problems; `formatClip` with and without the sheet sentence, and its
  `Rig: skinned, 2 bones.` / `Rig: rigid, …` line.

## Commit

`feat(glb): sample animation clips and check floor contact, seam, drift and tracks`

## Rollback

New files only; nothing outside `src/lib/glb/` uses them until phase 03's
dev runner. Revert the commit.
