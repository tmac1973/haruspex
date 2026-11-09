---
title: The 3D helper
description: What check_3d does in detail — the build and animation modules it runs, its arguments, every check it makes, and the GLB, report and render sheets it returns.
---

# The 3D helper

The 3D helper gives the Code tab's agent one tool, `check_3d`. The agent writes code that builds a model; the helper runs it, saves a `.glb`, measures and renders it. Turn it on in Settings → Code → Helpers → 3D. See the `helpers` page for all helpers, and the `3d-models` page for jobs.

## What the agent writes

A **build module** is a `.js` file whose default export is `build(THREE, kit)`. It imports nothing, since it runs alone in a hidden sandbox, and returns one Three.js object (or `{ object, animations }` with clips). Units are metres, y is up, the front faces +z, and every mesh is named.

`kit` adds `mergeGeometries` (it says why a merge fails), `mergeVertices`, `RoundedBoxGeometry`, `ConvexGeometry`, `ParametricGeometry`, seeded `createNoise(seed)` → `{ noise2, noise3 }` and `random(seed)`, and `texture('textures/bark.png')`, which loads a PNG beside the file. Write texture paths in full; up to 8 PNGs of 4 MB each.

An **animation module** keeps clips in a file of their own. Its `animate(THREE, object, kit)` gets the built model and returns an array of clips. Clips turn or move named nodes, usually pivots placed at the joints (`Hip_L > Knee_L`). A track naming a node that doesn't exist is dropped, and the report lists it.

## Arguments

| Argument        | What it does                                                |
| --------------- | ----------------------------------------------------------- |
| `path`          | the build module, or a `.glb`/`.gltf` to check (required)   |
| `anim`          | an animation module to run with the build module            |
| `out`           | where to save the `.glb`; a module defaults to its own name |
| `clip`          | show that clip moving instead of the still views            |
| `clips`         | per clip `loop` and `airborne`, overriding the name         |
| `view`          | show one part close up: a mesh or pivot name, or `head`     |
| `height`        | scale the model to this many metres tall                    |
| `spec_height`   | warn when the model is over 10% off this height             |
| `ground`        | put the feet on the floor, centred                          |
| `max_triangles` | warn above this many triangles                              |

Checking a `.glb` writes nothing unless `height` or `ground` asks for a copy at `out`.

## What it checks

A build error stops the check and reports the error with its line and file. So does a clip track whose values don't match its times, named by clip and track. Otherwise:

- **Problems**: no meshes, zero size, broken vertex positions.
- **Warnings**: missing normals, faces that vanish from behind, faces pointing inward, textures over 2048 px, more triangles than `max_triangles`, a height off `spec_height`.
- **In a game**: over 32 draw calls when merging meshes that share a material and move together would save a quarter, materials with no name, and a front that seems to face away from +z, read from parts named like eyes, a nose or toes.
- **Parts**: floating free, hidden inside another part, or tiny next to the rest.
- **glTF validation**: the Khronos glTF Validator's errors, one line per kind, such as rotation keys that aren't unit quaternions. three.js draws these anyway; other engines may not.

Vertex colours outside 0–1 are clamped in the `.glb`; the report says how many.

Each clip is sampled at 16 frames. Idle, Walk, Run, Swim and flight (Fly, Hover, Glide, Soar) loop; runs, jumps and flight may leave the floor, unless `clips` says otherwise. A walk or run plays in place, since the game moves the model; its line gives that speed. Each clip reports:

- going through the floor or the whole model leaving it, each over 1 cm;
- a clip that lasts 0 s, never moves, or has keys past its end;
- a part passing into another, or coming away from the body;
- a planted foot sliding over 3 cm;
- a looping clip that ends over 1 cm (or 2% of the height) from where it starts, changes speed at its loop point, or carries the body across the floor, with the track that carries it;
- a one-shot that doesn't start and end at the rest pose or Idle's first pose (a Die may end elsewhere), so a game can't blend into it;
- a walk or run whose planted feet don't move back together at one speed, like a treadmill: they slip against it, stand still or move forward;
- a knee or elbow bending the wrong way by over 10° (not in a wing);
- a joint turning over 90° between keys, and tracks that never move;
- how far it ends from where it started, how far its key pose reaches, and how far it drifts;
- as notes that never fail it: keys over 0.3 s apart, which move in straight lines, and over 60 keys a second, which bloat the file.

## What it returns

- The `.glb`, with its clips, saved at `out`.
- The report: size in metres, where the feet sit, mesh, triangle and draw-call counts, the heaviest parts, problems, warnings, materials and one line per clip.
- The render sheet: a 1200 × 800 image of front, right, back, left, top and three-quarter views over a labelled floor grid, height marked; "right" shows the model's left. With `view`, the same views framed on that part, drawing only what is near it (a part as long as the model looks whole).
- The motion sheet, with `clip`: 8 frames from the side, 8 from the front, then all frames overlaid with trails of the parts that move most.

The agent sees the sheets only if its model reads images.

## What it doesn't do

- It can't tell whether a model looks right or a walk reads as a walk, only what is physically wrong.
- It doesn't decide when the agent is done.
- It keeps no history: each check replaces the `.glb` at `out`.
- It finds knees, elbows and walks by name only.
- It doesn't rig, skin, unwrap UVs or make lower-detail copies.
