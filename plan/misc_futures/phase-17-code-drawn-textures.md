# Phase 17 — Code-drawn textures, with tile variants

Depends on: — / Enables: —

## Goal

Ground and wall textures that a game can actually tile, drawn by code rather
than by the image model, with several variants of each so a tilemap doesn't
repeat. Sprites and icons stay with the image model, which draws them well.

**What prompted it.** Asset run 108 (dark_times_5, 2026-10-05) made 17
textures. Tiled 2×2 (`phase-17-prototype/diffusion-run-108.png`), almost none
are usable:
- **It draws pictures, not surfaces.** "Street" is a road scene with
  vehicles, "camp" is tents and fires, "building" is a façade with windows.
  Tiled, each becomes a grid of one picture.
- **The viewpoint drifts.** `subway_entrance`, `garage_exit` and `tower_wall`
  are side or front views; nothing holds the model to top-down.
- **Some aren't textures.** An entrance, an exit or a camp is an object on the
  ground: a sprite over a floor tile. Six of the 17 were objects.

**The prototype.** `phase-17-prototype/proctex.py`, about 200 lines of
Python and no model, draws a texture from a recipe: a base material shaded
from 3–4 colours (wrap-around noise, ordered dithering), plus layers from a
fixed set. Every layer wraps at the tile edge, so the result tiles by
construction, and all of it is flat and top-down. Twelve recipes
(`recipes.json`) rendered in 0.08 s in total
(`phase-17-prototype/code-drawn.png`). The tiles are plain, but each reads as
its material and tiles cleanly. One flaw: a stain layer with a period of 2
cells repeats visibly at 2×2 (the park's dirt patches).

## Decisions

Taken with the user on 2026-10-05:

1. **Code-drawn textures are on by default** for new asset jobs and for
   chains. The asset job gets a toggle, "Draw textures in code", to go back to
   the image model. Existing jobs keep the image model until edited.
2. **Variants are numbered files beside the base.** `street.png` is variant
   0; the others are `street_1.png` … `street_3.png`. The spec lists them.
3. **Variants are the same material with new details.** Same recipe, same
   colours, a different seed: cracks, specks and stains move, and the base
   shade stays. Any two variants can sit side by side.
4. **Objects move to sprites in this phase.** The spec-writing steps classify
   entrances, exits, doors, stairs, camps, furniture and vehicles as
   sprites drawn over a floor texture.
5. **The vision judge checks a code-drawn texture once.** When the job's model
   can see, it asks "is this recognisably <subject>, seen from above?". On a
   no, the model revises the recipe once. The texture is kept either way, and
   marked `rejected` if the revision also fails (as in #301).
6. **The coding run uses variants by rule.** The spec lists each texture's
   variant files. The coding preflight is told to choose a variant per map
   cell from a hash of the cell's position and the map seed, so maps vary but
   are reproducible.
7. **Four variants by default,** settable 1–8 on the asset job.

## The facts this rests on

Checked against the code on 2026-10-05:
- **Textures go through the same path as sprites.** `generate.ts` sends
  each texture to the backend, then normalizes it (`src-tauri/src/image_gen/`:
  `normalize.rs`, `palette.rs`, `tiling.rs`) and checks it. The seam pass
  (`SEAM_REPAINT_STRENGTH`) exists only because the model's output doesn't
  tile.
- **Two prompts write texture entries.** `asset-generation/prompts.ts` (the
  asset job's own spec step) and `guided-planning/pipeline.ts` (around line
  820, the plan's asset list) both define `texture` as "ground or walls that
  must tile seamlessly", and neither says what isn't one. Both feed
  `derive.ts`, which sets `seamless: true` on every texture.
- **The spec has no place for a recipe or variants.** `AssetEntry`
  (`src/lib/assets/spec/types.ts`) has `prompt`, `out`, `seamless`,
  `sheet`, `seed`, `notes`, `rejected`.
- **The anchor sets the palette.** Sprites take each sheet's palette;
  `spec.normalize.palette` and the anchor recipe hold the set's colours. A
  code-drawn texture should pick its colours from these so it matches the
  sprites.

## Part A — the generator

### Files touched

- New `src-tauri/src/image_gen/texture/` (`mod.rs`, `noise.rs`,
  `layers.rs`, `recipe.rs`), and a `texture_render` command in
  `commands.rs`.
- `src/lib/ipc/gen/` — the recipe types, exported (`./scripts/export-ipc-types.sh`).

### Steps

1. **Wrap-around noise.** Value noise on a lattice with an integer number of
   cells across the tile, wrapped at the edge, plus fBm over 1–4 octaves.
   Worley (nearest and second-nearest point) with wrapped distances, for
   cracks and cobbles. No new crates: about 60 lines each. Seeded by
   `ChaCha8` from a `u64`, so a recipe and seed always give the same pixels.
2. **The recipe.** It is JSON, `#[ts(export)]`:

   ```json
   {
     "base": { "ramp": ["#2a2a2d", "#34343a", "#3e3e44"], "cells": 4, "octaves": 3, "dither": true },
     "layers": [
       { "type": "speckle", "color": "#4c4c52", "amount": 0.05 },
       { "type": "cracks", "color": "#1d1d20", "cells": 3, "coverage": 0.55 },
       { "type": "stripes", "axis": "x", "pos": 15, "width": 2, "dash": [8, 8], "color": "#b89a2e", "wear": 0.25 }
     ],
     "wall_face": null
   }
   ```

   The layers are the prototype's: `speckle`, `cracks`, `blotches`,
   `bricks`, `stripes`, `waves`, `grid` and `bevel`. Each has a fixed set of
   fields, clamped on parse. A position or size is in tile pixels and is
   scaled when the tile is 64 px.
3. **Fix the repeating stains.** `blotches` takes its shape from fBm at
   least 4 cells across, with a threshold, and never from a 2-cell lattice. At
   a coarse scale, a tiled field shows its own period.
4. **Wall faces.** `wall_face: { "height": 6, "shade": 0.6 }` darkens a band
   at the bottom of the tile, for the top-down-with-front-face ("3/4") look.
   It is null for a flat top-down tile.
5. **Variants.** Render variant *k* with seed `hash(entry.seed, k)`. The base
   ramp and every layer's parameters stay the same; only the noise and
   placement move. Positioned layers (`stripes`, `grid`, `bricks`) keep
   their positions, so a road line stays continuous across variants.
6. **Palette.** The renderer snaps every colour to the set's palette when it
   has one (`spec.normalize.palette`, else the anchor's), with the same
   nearest-colour code `palette.rs` uses. The output is written at
   `target_size` directly, with no upscale or downscale.

### Tests

- Every layer tiles: for each layer type and seeds 1–20, the wrap error
  between the left and right edges, and between the top and bottom edges,
  is no worse than between two adjacent interior columns and rows. This is
  the measure from `comfyui/templates/README.md`.
- Determinism: the same recipe and seed give byte-identical PNGs.
- Variants: four seeds give four different images with the same colour
  histogram (within 5%).
- A recipe with an unknown layer, a bad colour or an out-of-range field is
  refused with the field named.
- The twelve prototype recipes render; a snapshot of each, 2×2.

## Part B — the asset job uses it

### Files touched

- `src/lib/assets/spec/types.ts`, `parse.ts`, `write.ts`, `validate.ts`:
  `AssetEntry.recipe?` and `AssetEntry.variants?: string[]`.
- `asset-generation/config.ts`, `definition.ts`, `Editor.svelte`:
  `code_textures: boolean` (default true for new jobs) and
  `texture_variants: number` (default 4, 1–8).
- `asset-generation/prompts.ts` and `guided-planning/pipeline.ts`: the
  texture rule, and the recipe.
- `asset-generation/generate.ts`: the code path for textures.
- `asset-generation/tools.ts`: `submit_texture_recipe`.
- `asset-generation/report.ts`, `ReviewAssets.svelte`, `review.ts`.

### Steps

1. **What a texture is.** Both spec prompts say that a texture is a surface
   seen from directly above: a ground, floor, road, water or roof material.
   Anything with an outline is a sprite. An entrance, exit, door, stairs,
   hatch, camp, furniture, vehicle or sign is a sprite placed over a floor
   texture. The prompt gives three good and three bad examples, the bad ones
   from run 108 (`subway_entrance`, `camp`, `building`).
2. **The recipe stage.** With `code_textures` on, after the anchor and before
   generation, the model writes one recipe per texture entry in one turn,
   through `submit_texture_recipe` (entry id → recipe). It is given:
   - the layer vocabulary;
   - the set's palette, as hex, with the instruction to use only these
     colours;
   - the tile size, and the prototype's recipes as examples.

   An invalid recipe gets one retry, with the refusal quoted. Recipes are
   saved in the spec (`entry.recipe`), so a re-run reuses them, and a person
   can edit one by hand.
3. **Rendering.** For each texture entry, render the base and its variants,
   and write `out` plus `<stem>_1.png` … `<stem>_{n-1}.png`. The entry's
   `variants` lists all of them, base first. The seam pass and normalization
   are skipped: the tiles are already seamless and at size.
4. **The judge, once.** When the model can see, judge variant 0. On a no, the
   model revises that one recipe with the judge's reason, and it is rendered
   again. A second no keeps the tiles and marks the entry `rejected` (#301),
   so it shows up in Review assets.
5. **Off.** With `code_textures` off, textures go to the image model as
   today, with one variant (the seam pass makes one tile; it can't make a
   set).
6. **Report.** Textures get their own table: id, recipe layers, variants
   written, judge verdict. The contact sheet shows each texture tiled 2×2,
   because a single tile hides repetition.
7. **Review.** Review assets shows a texture tiled 2×2, with its variants.
   "Make again" re-renders all of its variants from a revised recipe: the
   note goes to the model with the current recipe. It never goes to the
   image model.

### Tests

- With `code_textures` on, a texture entry never reaches `backend.generate`.
  It writes n files, and `variants` lists them.
- A spec with recipes is re-run without asking the model again.
- An invalid recipe gets one retry, then the entry fails with the refusal.
- Judge: a no, then a yes, writes the revised tiles; two noes write the tiles
  and mark `rejected`.
- A spec round-trips with `recipe` and `variants`.
- The prompt snapshots carry the texture rule in both spec-writing prompts.

## Part C — the coding run uses the variants

### Files touched

- `autonomous-coding/prompts.ts` (`assetSpecStep`).

### Steps

1. The art step reads: a texture entry with `variants` has that many
   interchangeable tiles. Pick one per map cell from a hash of the cell's
   coordinates and the map's seed, never from an unseeded random number, so
   a saved map looks the same when loaded. Load them by the listed paths.
2. Preflight records the choice of hash in `DECISIONS-coding.md`, so every
   phase uses the same function.

### Tests

- A prompt snapshot with a variants entry.

## Not in this phase

- **Transitions** (grass meeting asphalt): an autotile set, 16 or 47 tiles,
  could be drawn from two recipes and a mask. Worth doing once the base tiles
  prove out.
- **Rare-feature variants** (a manhole on one street tile in ten). Decision
  3 keeps variants interchangeable. A feature is a sprite.
- **Animated water.** Variants of `waves` could serve as frames later.

## Build gate

The repo's, as in the overview. Plus `./scripts/export-ipc-types.sh` for
the recipe types.

## Test plan

1. Re-run dark_times_5's asset job with `code_textures` on: every texture is
   drawn in code, with 4 variants, and the six objects come out as sprites
   when the spec is re-derived. Compare the tiled contact sheet with
   `phase-17-prototype/diffusion-run-108.png`.
2. Open Review assets, revise one texture with a note ("more cracks"), and
   check that only its variants change.
3. Run the coding stage to its first rendering phase and check that the map
   mixes the variants, and that a saved and loaded map is unchanged.

## Commits

`feat(image): draw tileable textures from a recipe`,
`feat(assets): code-drawn textures with variants in the asset job`,
`feat(coding): place tile variants by a seeded hash`.

## Rollback

Each part reverts on its own. Without Part A, `code_textures` must read as
off. A spec carrying `recipe` and `variants` still parses after a revert.
The parser ignores entry fields it doesn't know, so the next rewrite of the
spec drops them, and textures go back to the image model.
