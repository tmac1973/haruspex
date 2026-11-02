# Code helpers — Project Overview

## Problem

The Code tab's agent can write 3D assets, but it can't see or measure what it
built. In the 2026-11-02 spike, Qwen 3.8 with no help modelled a potion and a
demon blind in headless Blender: it rendered previews but never looked at them,
and shipped a demon whose wing membranes were one-sided. The 3D asset (GLB)
specialist did worse: its pages crashed, its demons came out as a ball or as
loose parts, and Qwen rewrote or repaired almost all of its output.

What worked was the specialist's harness without its model. A spike tool,
`render_3d`, ran Qwen's own page headless, exported and checked the GLB, and
showed Qwen a render. With it, Qwen made the best potion (first try, 13 s) and
the best demon (four renders, each fixing a defect it saw: floating horn
segments, then a wing that wasn't a true mirror). The tool needed a button
page, a CDN and an import map, showed one fixed angle, and reported only
counts and bounds. A real version needs none of that boilerplate, and should
give the agent much more to judge with.

## Goals

- A **Helpers** card in Settings → Code, listing model-free tools for the Code
  tab's agent, each with its own switch, off by default.
- A helper registry that later helpers plug into: a helper declares its tool,
  its card row and its switch, and nothing else has to change to add one.
- The first helper, **3D**: one tool, `check_3d`, that takes either
  - a **build module** (`.js`): its default export `build(THREE, kit)` returns an
    `Object3D` or `{ object, animations }`. The helper supplies the bundled
    Three.js (no CDN, no import map), builds the asset, exports the GLB with
    `GLTFExporter` and writes it; or
  - a **`.glb` / `.gltf`** made any other way (Blender, a download), which it
    measures and renders as it is.
- Every result gives the agent:
  - a **render sheet**: one image with six views (front, right, back, left,
    top, three-quarter);
  - **size and placement**: bounds in metres, height, feet (min y), centre
    offset;
  - a **per-part report**: each named mesh's bounds, floating parts that touch
    nothing, parts buried inside others, size outliers;
  - **geometry and material checks**: triangle count, NaN, one-sided or
    inverted faces visible from outside, missing normals, the materials and
    texture sizes;
  - **animation**: each clip's name, length and track count (clips are
    exported into the GLB; the sheet shows a still pose).
- Optional **normalisation on export**: `height` scales the GLB uniformly to
  that many metres, and `ground` puts its feet on y = 0, centred on x and z.
  Off unless the agent asks; the report shows before and after.
- The 3D asset (GLB) specialist keeps working as it does, but its recheck uses
  the same report and render sheet, so both paths judge a GLB the same way.

## Non-goals

- No model call: a helper is code only. Anything that needs a model stays a
  specialist.
- No other helpers in this version (web page screenshots, texture tiling
  checks and the like come later, through the registry).
- No per-session Helpers menu; the card's switches are the only control.
- No HTML pages with an Export GLB button for `check_3d`. Those stay the
  specialist's format.
- No checking of a Three.js *scene* project (an app with its own renderer and
  loop); the Three.js scene specialist still covers that.
- No animated preview: clips are reported, not drawn frame by frame.
- No rigging, UV unwrapping, LOD generation or mesh repair: the helper reports
  problems; the agent fixes its own code.
- Not in Chat, the Shell, jobs or subtasks.

## Users & primary flow

The user is a non-technical Haruspex owner making assets for a game in the
Code tab; the agent is whatever model the session runs.

1. The user turns on **3D** in Settings → Code → Helpers.
2. In a Code session they ask for an asset: "make a low-poly mana potion for my
   Godot game".
3. The agent writes `assets/mana_potion.js`, a build module, following the
   template in `check_3d`'s description.
4. It calls `check_3d` with that path (and, say, `height: 0.3, ground: true`).
5. The helper builds the asset in a hidden sandbox, exports
   `assets/mana_potion.glb`, and returns the report plus the render sheet. On
   a script error it returns each error with its line instead, and writes
   nothing.
6. The agent reads the report and looks at the sheet, edits the module, and
   calls `check_3d` again until it's right.
7. If the agent made the model in Blender instead, it calls `check_3d` on the
   `.glb`, gets the same report and sheet, and fixes its Blender script.

## Constraints

- Tauri 2 + SvelteKit 5 (runes); the helper runs in the webview, in the
  `haruspex-artifact:` sandboxed iframe that `runHtml.ts` already uses
  (opaque origin, no IPC). Three.js comes from the app's own `three`
  dependency, never a CDN, so it works offline.
- Reuse `src/lib/specialists/three/` rather than fork it: the hidden-iframe
  lifecycle is shared by both runners, and `preview.ts` is replaced by a
  shared GLB module both paths use. The build-module page needs no shim (it
  exports itself). The specialist's recheck must keep passing its tests.
- A render sheet is one image, since `pendingImages` is capped
  (`MAX_PENDING_IMAGES`); the agent only gets it when its model can see images.
  Without vision the text report still carries everything measurable.
- Settings are plain JSON (`stores/settings.ts`); the helpers' switches live
  there.
- New Tauri commands or `#[ts(export)]` structs mean
  `./scripts/export-ipc-types.sh`. UI copy is one short sentence per section,
  with detail in `title` tooltips.
- The user guide (`docs/guide/`) gains a `helpers` page under 6 KB, and the
  `specialists` page says the GLB recheck now returns the fuller report.
- Writes into the project take the folder's writer lease and are refused in a
  read-only session, like `make_asset`.

## Success criteria

- Settings → Code → Helpers shows the 3D helper, off by default; turning it on
  offers `check_3d` to the next Code turn, and turning it off removes it.
- `check_3d` on a build module writes a GLB that loads in three's
  `GLTFLoader` and in Blender, with the module's animations included.
- `check_3d` on a Blender-made `.glb` returns the same report and sheet
  without writing anything.
- Unit tests cover the report: a floating part, a buried part, an inverted
  face, NaN, normalisation before/after, and a clip listing.
- The GLB specialist's recheck returns the new report and sheet, and its
  existing tests pass.
- Live rerun: Qwen 3.8 on compute:3000 runs the spike's potion and demon
  prompts with only the 3D helper on. Both export on the first call that has
  no script error, both come out grounded at a sensible size, and both render
  at least as well as spike setup B in the four-view judge.

## Decisions

- **Scope of the first version** → a helper framework (registry + Settings →
  Code → Helpers card) shipping one helper, 3D.
- **How the agent hands over a 3D asset** → a build module whose default export
  `build(THREE, kit)` returns the object; the helper bundles Three.js and does the
  export itself. Plus `.glb`/`.gltf` files from anywhere, checked as they are.
  No Export GLB button pages.
- **What every result carries** → a six-view render sheet, size and
  placement, a per-part report, and geometry/material checks (all four).
- **Normalisation** → optional on export (`height`, `ground`), off unless asked;
  the report shows before and after.
- **The GLB specialist** → kept, and its recheck shares the helper's report and
  render sheet.
- **Switches** → one per helper on the card, off by default; no per-session
  menu.
- **Tool shape** → one tool per helper (`check_3d`), core rather than deferred.
- **Animation** → supported: clips are exported and reported; the sheet is a
  still pose.
- **Done and good** → rerun the spike's potion and demon prompts on Qwen 3.8
  and beat spike setup B.
- **What build() receives besides THREE** → a curated kit: mergeGeometries,
  mergeVertices, RoundedBoxGeometry, ConvexGeometry, ParametricGeometry, a
  seeded noise and a seeded random.
- **Scale cue on the sheet** → a floor grid in every view (1 m lines, plus
  0.1 m lines when the asset is under 1 m tall) and a labelled height ruler in
  the front view.
- **Normalising a .glb input** → write a normalised copy to `out`; the
  original is untouched.
- **Triangle count** → always reported with the heaviest parts; flagged only
  when the agent passes `max_triangles`.
- **Teaching the module format** → a short example in `check_3d`'s
  description; no starter-file parameter.
