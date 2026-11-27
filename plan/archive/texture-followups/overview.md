# Code-drawn texture follow-ups — Project Overview

Tracks tmac1973/haruspex#614. Builds on the code-drawn textures of
`plan/misc_futures/phase-17-code-drawn-textures.md` and on #613, which moved
`make_asset` textures onto recipes and showed the judge a 3×3 preview.

## Problem

Code-drawn textures tile by construction, but a map can't be built from
them yet. The recipe vocabulary has no wood, grass blades or cobbles, so the
most common ground and floor materials come out as coloured noise. Every
layer paints one flat colour, so bricks, stones and cracks look drawn on
rather than raised or cut in. And there is nothing for the place where two
materials meet: a tilemap with grass and dirt needs edge and corner tiles,
and a side-view platformer needs ground with a grass top and exposed sides.
Without these, a project made by the asset job or the Code-tab assistant
still needs hand-drawn edge tiles or a different art source.

Three smaller gaps sit beside this. A rejected texture gets one revision,
written by a model that never sees the tile. #613 left no way to ask the
image model for a tiling picture, which a 3D material needs, and it left
an uncalled texture path in `src/lib/assets/single.ts`. #613 itself has not
been run against a real model.

## Goals

- Run #613 live against a real model and fix whatever that turns up.
- Add five layers to the recipe vocabulary: `planks`, `tufts`, `stones`,
  `hex` and `herringbone`. Each tiles at every size.
- Add depth: an optional `relief` (0–1) on cell layers that shades their
  edges with a fixed top-left light, and an optional `jitter` that varies
  each cell's shade.
- Allow up to two judge-driven recipe revisions. The reviser sees the 3×3
  preview and the judge's reason when the model can see images.
- Draw transition sets: 16-tile corner sets in a 4×4 sheet with a JSON map,
  for two kinds:
  - top-down: material A meets material B;
  - side-view: solid material against transparent air, with a cap recipe
    on upward-facing edges.
- Make transition sets from both the asset job (a spec entry naming its
  materials) and `make_asset` (a transition kind taking recipes). The
  job's spec stage adds a set wherever two ground materials meet on the
  map, and one side-view set per platform material.
- Add `seamless: true` to `make_asset`'s `image` kind, and remove the dead
  texture path from `single.ts`.

## Non-goals

- Isometric tiles, or any renderer geometry other than square tiles.
- 47-tile blob sets, or any layout but the 16-tile corner set.
- Engine-specific resources (Godot `.tres`, Tiled `.tsx`). The JSON map is
  the interface; wiring a set into an engine is the coding run's or the
  assistant's job.
- Animated water, or any animated tile.
- A user-set light direction, or per-layer highlight and shadow colours.
- Turning an existing spec's object textures into sprites (a separate
  futures item).
- Changing the image-model texture path the asset job still has for old
  jobs with `code_textures` off.

## Users & primary flow

Two users: someone running an **Asset generation** job (alone or from a
guided-planning chain), and someone asking the Code-tab or Shell assistant
for art with `make_asset`.

Asset job:

1. The spec stage writes texture entries. Where two ground textures meet on
   the map, it also writes a transition entry naming both. For a
   side-view game, it writes one per platform material, naming the material
   and its cap.
2. The recipe stage writes recipes for every texture and cap, using the
   new layers, `relief` and `jitter` where they fit.
3. Each texture is drawn and written with its variants. The judge sees it
   laid 3×3. On a no, the model revises the recipe while looking at that
   preview, up to twice. After that the tiles are kept and marked rejected.
4. Each transition set is drawn from its materials' recipes into one 4×4
   sheet plus a JSON map, judged as a small test map, and written beside
   the textures.
5. The report and Review assets list the sets beside the textures.

`make_asset`:

1. The assistant asks for a texture with a recipe. It can use the new
   layers and `relief`, and gets back the 3×3 preview.
2. It asks for a transition with two recipes (top-down) or a material and
   a cap recipe (side-view), and gets back the sheet, the JSON map and a
   preview of the set laid out as a small map.
3. It asks for a seamless painted picture with `kind: "image",
   seamless: true` when it needs an image-model material.

## Constraints

- Rust renderer in `src-tauri/src/image_gen/texture/`. Every layer must
  stay periodic over the tile, so a texture still tiles whatever the recipe
  says. The existing tiling tests apply to each new layer.
- A recipe written before this work must draw the same pixels after it:
  absent `relief`, `jitter` and new fields mean what they mean today. The
  prototype fixture recipes guard this.
- Recipes are written by models down to the 9B default. Each new field gets
  a range check whose message names the field. The vocabulary text
  (`recipeGuide()`) stays short enough for the recipe-stage prompt and the
  `make_asset` schema.
- Measures stay in 32-pixel-tile units, and sizes stay multiples of 4 from
  8 to 256.
- A transition set's tiles must match the plain material tiles where the
  mask is all one material, so a set can be mixed with its materials'
  variants on a map.
- Changing a Tauri command or a `#[ts(export)]` struct means running
  `./scripts/export-ipc-types.sh`.
- Users can see the changes, so each PR updates its `docs/guide/` page
  (`images`, `jobs`). Each page stays under 6 KB.
- No branch switching in the main checkout: work happens in worktrees.

## Success criteria

- A scripted Remote-control run of #613 is recorded in the plan folder,
  with its tiles and previews, and any defect it found is fixed.
- Each new layer passes `every_layer_tiles_at_every_size`, and its
  prototype-style recipe renders in the `write_previews` sheet.
- Every prototype fixture recipe renders identically before and after the
  depth work.
- A recipe with `relief` set visibly lights the top-left edges of its cells
  and shades the bottom-right ones. A test checks the luminance of those
  edges.
- A texture the judge rejects is revised up to twice, and the reviser's
  turn on a vision model carries the preview image.
- A transition sheet has 16 tiles in the documented corner order. Each tile
  wraps against any neighbour whose shared corners match, and the
  all-A and all-B tiles equal the material tiles drawn with the same seed.
  Tests check all three.
- A scripted live run makes a top-down set (grass and dirt) and a
  side-view set (dirt with a grass cap) through both the job and
  `make_asset`. Laid out as a test map, they show no seams, and Tim
  approves the result.
- `make_asset` with `kind: "image", seamless: true` passes the seamless
  flag to the backend. `single.ts` no longer has a texture path.

## Decisions

- **Scope** → all six items from #614: hand test, new layers, depth, second
  revision, transition tiles, seamless option with the `single.ts` cleanup.
- **Perspective** → top-down and side-view; no isometric.
- **Autotile layout** → 16-tile corner set.
- **Set output** → one 4×4 PNG sheet plus a JSON map of each cell's corners.
- **Entry points** → both the asset job (spec entry) and `make_asset`
  (transition kind), through one Rust renderer.
- **Edge shape** → noisy, tile-periodic boundary with an optional 1 px rim.
- **Side-view sets** → solid material against transparent air, with a cap
  recipe on upward-facing edges only; sides and undersides get the rim.
- **New layers** → planks, tufts, stones, hex and herringbone.
- **Depth** → fixed top-left light; optional per-layer `relief` (0–1) on
  cell layers, plus `jitter` for per-cell shade.
- **Revisions** → up to two; the reviser sees the 3×3 preview with the
  judge's reason on a vision model.
- **Live tests** → driven by script through the Remote control API on a
  dev build; tiles and previews saved to the plan folder for Tim to review.
- **Spec stage** → adds a transition entry wherever two ground materials
  meet, and one side-view set per platform material.
- **Spec shape** → a new top-level `transitions` list naming texture
  entry ids; entries, sheets and Rust's `AssetKind` are unchanged.
- **Set rejects** → one edge revision while looking at the test map, then
  keep and mark rejected; material recipes are never changed by a set.
- **Edge settings** → the recipe stage writes each set's edge block;
  code fills any field it leaves out with a default.
- **Set variants** → none; one sheet per set.
- **PRs** → three by theme: fixes (phases 01–03), renderer (04–05),
  transitions (06–10).
- **Live-test model** → the model the dev app is set to; no 9B pass.
