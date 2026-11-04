---
title: The 3D helper
description: What check_3d does in detail — the build and animation modules it runs, its arguments, every check it makes, and the GLB, report and render sheets it returns.
---

# The 3D helper

The 3D helper gives the Code tab's agent one tool, `check_3d`. The agent writes code that builds a model; the helper runs it, saves a `.glb`, measures it and renders it, so the agent can see what it made and fix it. Turn it on in Settings → Code → Helpers → 3D. For a short overview of all helpers, see the `helpers` page; for whole sets of models made by a job, see the `3d-models` page.

## What the agent writes

A **build module** is a `.js` file whose default export is `build(THREE, kit)`. It imports nothing, since it runs alone in a hidden sandbox, and returns one Three.js object (or `{ object, animations }` with clips). Units are metres, y is up, the front faces +z, and every mesh is named.

`kit` adds `mergeGeometries`, `mergeVertices`, `RoundedBoxGeometry`, `ConvexGeometry`, `ParametricGeometry`, seeded `createNoise(seed)` and `random(seed)`, and `texture('textures/bark.png')`, which loads a PNG beside the file. Texture paths must be written out in full; up to 8 PNGs of up to 4 MB each.

An **animation module** keeps clips in a file of their own. Its `animate(THREE, object, kit)` gets the built model and returns an array of clips. Clips turn or move named nodes, usually pivots placed at the joints (`Hip_L > Knee_L`). A track naming a node that doesn't exist is dropped, and the report lists it.

## Arguments

| Argument        | What it does                                                |
| --------------- | ----------------------------------------------------------- |
| `path`          | the build module, or a `.glb`/`.gltf` to check (required)   |
| `anim`          | an animation module to run with the build module            |
| `out`           | where to save the `.glb`; a module defaults to its own name |
| `clip`          | show that clip moving instead of the still views            |
| `height`        | scale the model to this many metres tall                    |
| `ground`        | put the feet on the floor, centred                          |
| `max_triangles` | warn above this many triangles                              |

Checking a `.glb` writes nothing unless `height` or `ground` asks for a resized copy at `out`.

## What it checks

A build error stops the check and reports the error with its line, in whichever file it came from. Otherwise:

- **Problems**: no meshes, zero size, broken vertex positions.
- **Warnings**: missing normals, faces that vanish from behind, faces pointing inward, textures over 2048 px, more triangles than `max_triangles`.
- **Parts**: floating free, hidden inside another part, or tiny next to the rest.
- **glTF validation**: the Khronos glTF Validator's errors, one line per kind, such as rotation keys that aren't unit quaternions or skin weights that don't sum to 1. three.js draws these anyway; other engines may not.

Vertex colours outside 0–1 are clamped before the `.glb` is written, and the report says how many.

Each clip is sampled at 16 frames, and reports:

- going through the floor (over 1 cm) or the whole model leaving it (over 2 cm);
- a clip that lasts 0 s, never moves, or has keys past its end;
- a part passing into another, or coming away from the body;
- a planted foot sliding over 3 cm;
- a knee or elbow bending the wrong way by over 10°;
- a joint turning over 90° between two keys, and tracks that never move;
- how far it ends from where it started, how far its key pose reaches, and how far it drifts.

## What it returns

| Output       | What it is                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `.glb`       | the model and its clips, saved at `out`                                                                                               |
| report       | size in metres, where the feet sit, mesh and triangle counts, the heaviest parts, problems, warnings, materials and one line per clip |
| render sheet | a 1200 × 800 image: front, right, back, left, top and three-quarter views over a floor grid, height marked                            |
| motion sheet | with `clip`: 8 frames from the side, 8 from the front, then all frames overlaid with trails of the parts that move most               |

The agent sees the sheets only if its model reads images; the report comes either way.

## What it doesn't do

- It can't tell whether a model looks right or a walk reads as a walk, only what is physically wrong.
- It doesn't decide when the agent is done. The agent stops when it is satisfied, or at the session's step limit.
- It keeps no history: each check replaces the `.glb` at `out`.
- It finds knees and elbows by name only.
- It doesn't rig, skin, unwrap UVs or make lower-detail copies.
