# Phase 01 — GLB report, render sheet and normalisation

**Depends on:** nothing · **Enables:** the specialist's recheck sharing the
report (02) and `check_3d` (06)

## Goal

One module that takes GLB bytes and returns everything the agent should learn
about them: a structured report (size and placement, per-part bounds, floating
and buried parts, geometry and material checks, animations), a one-image render
sheet with six views over a floor grid and a height ruler, the report as
text, and an optional normalised copy of the GLB. It works on bytes only, so it
runs in the main webview without executing anyone's code, and every later
phase uses it unchanged.

## Files touched

- `src/lib/glb/load.ts` — new: `loadGlb(bytes)` parses with the bundled
  `three`'s `GLTFLoader` (dynamic import, as `preview.ts` does now) and returns
  `{ gltf } | { error }`; owns `disposeTree` (moved from `preview.ts`).
- `src/lib/glb/report.ts` — new: `inspectGlb(gltf, opts)` → `GlbReport`; the
  pure measurements and checks.
- `src/lib/glb/sheet.ts` — new: `renderSheet(root, report)` → PNG data URL,
  and the pure `sheetLayout(bounds)` (each cell's rectangle, camera position,
  orthographic extent and grid spacings) it is built on.
- `src/lib/glb/sheet.test.ts` — new: tests `sheetLayout`.
- `src/lib/glb/normalise.ts` — new: `normaliseGlb(gltf, { height?, ground? })`
  → new GLB bytes plus before/after bounds.
- `src/lib/glb/format.ts` — new: `formatReport(report, opts)` → the text the
  agent reads.
- `src/lib/glb/report.test.ts`, `normalise.test.ts`, `format.test.ts` — new.
- `src/lib/specialists/three/preview.ts` — `previewGlb` rebuilt on the new
  module (same `GlbPreview` shape, so `glb.ts`, the spike tool and
  `/dev/glb-runner` keep working until phase 02); `disposeTree` re-exported
  from `#lib/glb/load.ts`.
- `src/lib/editor/glbViewer.ts` — import `disposeTree` from `#lib/glb/load.ts`.

## Steps

1. Move `disposeTree` into `src/lib/glb/load.ts` and add `loadGlb`. A parse
   failure returns `{ error: 'The GLB did not load: <message>' }`.
2. Define `GlbReport` in `report.ts`:
   - `bounds`: `min`, `max`, `size` (x, y, z, metres), `height` (= size y),
     `feetY` (= min y), `centreOffset` (x and z of the bounds centre).
   - `meshes`, `triangles`, `parts: PartInfo[]` where each part is a named mesh
     (`name || '(unnamed N)'`) with world-space `min`/`max`, `triangles`,
     `material` name, `doubleSided`.
   - `floating: string[]`: parts whose world box, grown by 1 % of the asset's
     largest dimension, overlaps no other part's box. Skipped when there is
     one part.
   - `buried: { part: string; inside: string }[]`: parts whose world box lies
     wholly inside another part's box.
   - `outliers: string[]`: parts whose largest dimension is under 0.5 % or over
     90 % of the asset's (the over-90 % rule ignores a part that is the only
     one).
   - `heaviest`: the five parts with the most triangles.
   - `problems: string[]` (these fail the check): no meshes; zero or
     non-finite size; NaN positions (as `preview.ts` does today).
   - Edges are counted after welding vertices by position (rounded to 1e-5
     of the asset's largest dimension), since exported GLBs split vertices
     at UV and normal seams; a boundary edge is a welded edge used by exactly
     one triangle. A mesh is closed when it has no boundary edges.
   - `warnings: string[]` (reported, never fail): open single-sided meshes —
     a mesh with boundary edges whose material
     is `FrontSide` — "is one-sided and open: it vanishes from behind; set
     side: THREE.DoubleSide or close it"; inverted meshes — a closed mesh
     (no boundary edges) with negative signed volume — "faces point inward";
     meshes missing a `normal` attribute; textures over 2048 px on a side;
     triangles over `opts.maxTriangles` when given.
   - `materials`: name, type, colour hex, metalness, roughness, transparent,
     map size when there is one. `textures`: count and each size.
   - `animations`: name, duration (s), track count.
3. In `sheet.ts`, render one 1200 × 800 PNG, a 3 × 2 grid of 400 × 400 cells:
   front (+z looking −z), right side, back, left side, top (looking down −y),
   and three-quarter (camera direction (1.2, 0.8, 1.6) from the centre, the
   `VIEW` constant in today's `preview.ts`). Orthographic cameras for
   the five axis-aligned views framed on the bounds with 10 % margin; perspective for
   the three-quarter. Each cell has the asset, a `GridHelper` floor at y = 0
   with 1 m lines, plus a second, fainter `GridHelper` with 0.1 m lines when
   the asset is under 1 m tall, a hemisphere
   light plus a key light, a neutral grey background, and a small label
   ("front", "back" …) drawn on a 2D canvas over the cell. The front cell adds
   a vertical ruler at the asset's right edge from feet to top, labelled with
   the height to two decimals in metres. One `WebGLRenderer` with
   scissor/viewport per cell, disposed after; returns `null` (with a
   `console.warn`) when WebGL fails, as `preview.ts` does.
4. In `normalise.ts`: wrap the scene in a group; when `height` is given, scale
   uniformly so the bounds' size y equals it; when `ground` is true, translate
   so min y = 0 and the x/z centre is at the origin. Re-export with
   `GLTFExporter` (`binary: true`, `animations: gltf.animations`) and return
   `{ bytes, before, after }` bounds. Height must be a finite number above 0,
   else `{ error }`.
5. In `format.ts`, `formatReport(report, { normalised?, maxTriangles? })`
   returns plain lines, problems first:
   - `Size: 0.79 × 1.00 × 0.81 m (x × y × z). Feet at y = 0.00; centre offset
     x 0.00, z 0.00.` (plus `Normalised from 1.16 × 1.71 × 1.16 m.` when it
     was)
   - `15 meshes, 1508 triangles. Heaviest: Flask 480, Liquid 320, …`
   - `Floating (touch nothing): Horn_L, Horn_R.` / `Buried (may be hidden):
     Eye_L inside Head, Eye_R inside Head.` / `Outliers: …`
     only when non-empty
   - each warning on its own `- ` line
   - `Materials: Glass (Physical, #46a8e0, transparent), Cork (#a97a50, map
     256²) …`
   - `Animations: Idle 2.0 s (6 tracks)` or `No animation.`
   Keep it under 2,500 characters: past that, list the first 20 parts in each
   list and say how many more.
6. Rebuild `previewGlb` on `loadGlb` + `inspectGlb` + the existing single
   render, so its callers see no change in this phase.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/glb src/lib/specialists src/lib/editor`

## Test plan

Vitest, building GLBs in the test with `three` + `GLTFExporter` (as
`preview.test.ts` does):

- two touching boxes → no floating; a third box 1 m away → floating lists it.
- a small box inside a big one → buried lists it.
- an open `PlaneGeometry` with `FrontSide` → one-sided warning; with
  `DoubleSide` → none.
- a closed box with its index reversed → inverted warning.
- a mesh with a NaN position → problem, check fails.
- `maxTriangles: 10` on a 12-triangle cube → warning; omitted → none.
- normalise a 2 m tall box with `height: 1, ground: true` → after bounds
  height 1, min y 0, centred; before bounds kept; animations survive the
  re-export (one clip in, one clip out).
- `formatReport` snapshot for a two-part asset with one floating part and a
  clip; a 60-part asset stays under 2,500 characters.
- `renderSheet` needs WebGL, which jsdom lacks: `sheet.test.ts` checks
  `sheetLayout` (six cells in a 3 × 2 grid of 400 px; every orthographic view
  contains the bounds with 10 % margin; 0.1 m lines only under 1 m tall), and the sheet is first checked by eye in phase 02's manual
  test (`/dev/glb-runner`).

## Commit

`feat(glb): shared GLB report, six-view render sheet and normalisation`

## Rollback

Revert the commit. `preview.ts` and `glbViewer.ts` go back to their own
code with it (they are the only outside importers, and `preview.ts` keeps its
`GlbPreview` shape throughout), so a revert leaves no callers broken.
