# Motion checks — Project Overview

## Problem

The 3D helper's `check_3d` (plan/code-helpers/, merged in #944) lets the Code
tab's agent see and measure a model it built, but only in its rest pose. A
module may return `{ object, animations }` and the clips are exported and
listed by name, length and track count, nothing more. The agent can't see a
single frame of motion.

The 2026-11-02 animation spike (`/home/tim/projects/spike3d/anim/`) asked Qwen
3.8 to rework the imp's wonky Attack clip into a claw swipe, twice from the
same file. Without motion feedback it spent 41 tool calls, tried and failed to
bake frames into throwaway modules to see them, ran out of its turn budget
and never rebuilt the GLB; its swipe was a flat sweep with the arm thrown out
sideways. With a prototype motion sheet and motion checks
(`spike/motion-sheet` in `/home/tim/projects/haruspex-build`) it took 15
calls, used `clip: "Attack"` twice, fixed a foot the checks found 2 cm through
the floor, and finished with a clean high-to-low diagonal swipe. One run per
arm, so the effect needs confirming, but the gap was large.

## Goals

- `check_3d` takes an optional **`clip`** argument naming one animation clip.
  With it, the still sheet is replaced by that clip's **motion sheet**:
  - a row of 8 frames across the clip from the right side, and the same 8 from
    the front, all framed to fit every pose and the floor;
  - the frames overlaid from the right and from the front (earlier frames
    fainter), with **trails** of the five parts that travel furthest and a dot
    where each trail starts.
- Every `check_3d` report, with or without `clip`, gains **clip checks**: one
  line per clip naming what is wrong, and with `clip` the full detail for that
  clip. The checks:
  - **floor contact**: through the floor (below the rest pose's lowest point)
    or the whole model off it, by how much and when;
  - **parts passing into others**: a part entering another closed, opaque part
    it didn't overlap at rest;
  - **parts coming apart**: a part touching another at rest that touches
    nothing at some frame;
  - **loop seam**: how far the last pose is from the first, and the part that
    moves most;
  - **root drift**: how far the model's centre wanders across the floor;
  - **foot slide**: how far a planted foot slides while it carries weight;
  - **dead tracks**: tracks whose values never change;
  - **big jumps**: a rotation of more than 90° between two keys;
  - **clip sanity**: zero-length clips, clips with one key, keys past the
    clip's end;
  - **joint limits**: a knee or elbow that folds the wrong way, judged by the
    node's name and the model's facing (front is +z);
  - **missing targets**: tracks naming a node the object doesn't have, which
    the exporter drops silently. Found when a build module runs, before
    export.
- The checks and sheet work for **rigid rigs** (meshes parented under pivot
  nodes, like the imp) and **skinned meshes** (an armature with vertex
  weights), posing skinned vertices through their skeleton.
- The GLB specialist's check, which shares `checkGlb`, gains the one-line clip
  checks in its report. It gets no `clip` argument and no motion sheet.
- The tool description gains one line on animating (a quaternion track on a
  named node, returned as `{ object, animations }`) and on `clip`.

## Non-goals

- No new switch: motion is part of the 3D helper in Settings → Code → Helpers.
- No separate tool; `check_3d` stays the 3D helper's only tool.
- No score for how good a motion looks (weight, timing, anticipation). The
  sheet lets the model judge that; nothing rates it.
- No rigging, skinning, retargeting, IK or root-motion extraction, and no
  editing of clips by the helper. It reports, the agent fixes.
- No motion sheet for the specialist, and no clip argument there.
- No change to the editor's 3D view; clip playback there is PR #945.
- No joint-limit check for joints whose names don't say what they are.

## Users & primary flow

The user is anyone asking the Code tab for an animated asset ("give the imp a
walk and an attack"), with Settings → Code → Helpers → 3D on.

1. The agent writes or edits a build module that returns `{ object,
   animations }`, or exports a `.glb` with clips from Blender.
2. It calls `check_3d` on it. The report has the usual size, parts and
   problems, then a line per clip: "Walk (0.82 s, 18 tracks, ends 1 cm from
   its start): no problems found." or "Attack: through the floor by 2 cm at
   0.48 s; Mesh_Hand_R passes into Mesh_Torso at 0.40–0.45 s."
3. To look at a clip, it calls `check_3d` again with `clip: "Attack"`. The
   report gives that clip's detail and the motion sheet replaces the still
   sheet.
4. It edits the keys, checks again, and finishes when the clip reads right.
5. The user plays the clips in the editor's 3D view (PR #945) or their engine.

## Constraints

- Runs in the app's webview with the bundled three, like the rest of
  `src/lib/glb/`; no network, no new dependency.
- One image per call, as today: the motion sheet replaces the still sheet,
  never adds to it. Same 1200 × 800 size.
- The report stays within `MAX_REPORT_CHARS` (2500); clip lines are cut
  before the rest of the report is.
- Sampling must stay fast on game-sized assets: the spike measured all four of
  the imp's clips (29 meshes, 14k triangles) in about 0.4 s. Checks use fixed
  sample counts so cost doesn't grow with clip length.
- `check_3d`'s schema ships in every Code tab request while the helper is on,
  so the description grows by one line only.
- A model without vision still gets every check as text.
- The guide's `helpers` page (under 6 KB) describes what the agent gets and
  what it doesn't do.

## Success criteria

- With `clip`, `check_3d` returns a motion sheet and the clip's detail; with a
  name that doesn't exist it fails and lists the clip names.
- Each check has a unit test that makes it fire and one that keeps it quiet
  (the imp's hidden-claws case for coming apart, a deliberate joint overlap
  for passing into).
- A skinned test asset is measured in motion, not at rest.
- A module whose track names a missing node gets a line saying so.
- Live rerun with the shipped build and Qwen 3.8 on compute:3000: the imp
  attack task 3 times without motion feedback and 3 times with it, plus one
  skinned walk made from scratch with it. The feature passes if every run with
  it finishes with a rebuilt GLB and its attacks look better in at least two
  of the three pairs, judged on the motion sheets side by side; and the
  lizard's Walk is skinned, loops (ends under 2 cm from its start) and has no
  floor or joint problems in its final report.

## Decisions

- **How motion is turned on** → Part of the 3D helper; no new switch.
- **How the model asks to see motion** → `clip` names one clip; its motion
  sheet replaces the still sheet.
- **Which checks ship** → The spike's set, plus foot slide, clip sanity and
  joint limits.
- **How joint limits decide wrong-way bends** → By node name (knee/shin/calf
  fold backward, elbow/forearm forward) and the model's facing (+z front).
- **Skinned meshes** → Supported: vertices are posed through the skeleton.
- **The GLB specialist** → Gains the one-line clip checks only.
- **Teaching animation in the description** → One line with a clip example
  and `clip`.
- **Success bar** → Live rerun, 3 runs per arm on the attack task, plus one
  skinned walk from scratch.
