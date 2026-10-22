# Phase 05 — Planks, stones, hex, herringbone and tufts

**Depends on:** phase 04 (`shade.rs`, the pixel-hash guard), phase 01 (the
live script) · **Enables:** phase 06 (transition sets draw any layer),
phase 10 (the live run uses the new materials).

**PR:** 2 of 3 ("texture renderer": phases 04–05).

## Goal

The vocabulary can't draw wood, cobbles, paving patterns or grass blades,
so the most common floors and ground come out as coloured noise. Add five
layers. Each is periodic over the tile, so it tiles at any size. The four
cell layers take `relief` and `jitter` from phase 04.

## Files touched

- `src-tauri/src/image_gen/texture/recipe.rs` — five new `Layer` variants
  and their validation.
- `src-tauri/src/image_gen/texture/noise.rs` — `worley_ids`: nearest-point
  index per pixel, alongside the existing `worley`, which stays unchanged.
- `src-tauri/src/image_gen/texture/layers.rs` — drawing for the five
  layers.
- `src-tauri/src/image_gen/texture/mod.rs` — `every_layer()` and tests.
- `src-tauri/src/image_gen/texture/fixtures/new-layer-recipes.json` — new.
  One example recipe per layer, rendered by `write_previews`.
- `src/lib/ipc/gen/Layer.ts` — regenerated.
- `src/lib/agent/jobs/types/asset-generation/prompts.ts` — `recipeGuide()`
  documents the five layers. `RECIPE_EXAMPLES` swaps the river example for
  "oak plank floor", keeping three examples.
- `plan/texture-followups/live/cases-05.json` and `live/phase-05/` — the
  live check.
- `docs/guide/images.md` — the texture paragraph names what textures can
  be made of: noise, cracks, stains, bricks, planks, stones, hex and
  herringbone paving, grass, water.

## Steps

All measures are in 32-pixel-tile units, scaled by `scaled()`. Colours are
`#rrggbb`. "Cells" means the partition helpers `cell_of` and `count_for`,
which divide `n` exactly.

1. **`planks { axis: "x"|"y", w, len, gap: 0–2, colors: 1–6, seam, grain?: 0–1, relief?: 0–1, jitter?: 0–1 }`**
   - Boards run along `axis`. Across the axis, `count_for(n, w)` rows
     (`w` 2–16). Along it, `count_for(n, len)` segments (`len` 4–32).
   - Each row shifts its segment boundaries by a random whole number of
     pixels in `[0, n)` from `rng`, taken modulo `n`, so the ends stagger
     and still wrap.
   - Pixels within `gap` (scaled, rounded) of a row edge or a segment end
     are `seam`. Board pixels mix 50/50 with the base, as bricks do.
   - Grain: a 1-D value noise along the axis, periodic over `n`, with one
     field per row, and darkens board pixels by up to `0.2 * grain`.
   - The cell id is `row * segments + segment`. Then `jitter_cells` and
     `relief_raised` from phase 04 apply.
2. **`stones { cells: 2–12, gap: 0–3, colors: 1–6, mortar, relief?: 0–1, jitter?: 0–1 }`**
   - Add `worley_ids(rng, n, cells) -> (Field, Field, Vec<u32>)` to
     `noise.rs`: the same points and torus distance as `worley`, also
     returning the nearest point's index. `worley` itself is untouched, so
     `cracks` keeps its pixels.
   - Pixels where `f2 - f1 < gap` (scaled; `gap: 0` means 0.6 px) are
     `mortar`. Every other pixel takes its point's colour (one of `colors`,
     picked per point from `rng`) mixed 50/50 with the base.
   - Cell id = point index, then jitter and relief.
3. **`hex { size: 4–32, gap: 0–2, colors: 1–6, mortar, relief?, jitter? }`** (pointy-top)
   - Columns `c = count_for(n, size)`. Rows
     `r = count_for(n, size * 0.866)`, rounded up to even (at least 2), so
     alternate rows offset by half a column and still wrap.
   - Centre of hex `(i, j)`: `((i + 0.5 * (j % 2) + 0.5) * n / c, (j + 0.5) * n / r)`.
   - Each pixel belongs to the nearest centre, by torus distance with the
     vertical axis scaled by `c / r * 0.866` so the cells come out
     hexagonal. Mortar is where the nearest and second-nearest distances
     differ by less than `gap` (scaled; 0 means none).
   - Colour, cell id, jitter and relief as for stones.
4. **`herringbone { w: 2–8, gap: 0–2, colors: 1–6, mortar, relief?, jitter? }`** (2:1 bricks at 90°)
   - The pattern repeats on a square of `4w`, so blocks are
     `k = count_for(n, 4 * w)` and the true brick short side is
     `s = n / (4 * k)` (float). The tile is `4k × 4k` unit squares.
   - Each pixel's unit square is `c = (⌊x / s⌋, ⌊y / s⌋)`. A brick has an
     origin `o` in the lattice `L = { (x, y) : x + y even and x − y ≡ 0 (mod 4) }`,
     which is spanned by `(1, 1)` and `(2, −2)`. A horizontal brick covers
     `o + (0, 0)` and `o + (1, 0)`; a vertical one covers `o + (0, 1)` and
     `o + (0, 2)`. Exactly one of the candidates `c`, `c − (1, 0)`
     (horizontal) and `c − (0, 1)`, `c − (0, 2)` (vertical) is in `L`;
     that is the pixel's brick. This was checked by exhaustive cover over
     ±20 lattice steps: every unit square is covered exactly once.
   - Brick id = `((o.x mod 4k) · 4k + (o.y mod 4k)) · 2 + (vertical ? 1 : 0)`,
     with `mod` the non-negative remainder. Distinct bricks in the tile get
     distinct ids, and the ids wrap with the tile.
   - Mortar where the distance to the brick's edge, in pixels, is under
     `gap` (scaled). Colour, jitter and relief as above.
   - Write a unit test of the decomposition first. On a `4k × 4k` unit
     grid, every unit square gets exactly one brick; there are `8k²`
     distinct ids; each id covers two unit squares; and the id map is the
     same when shifted by `4k` in either axis.
5. **`tufts { color, light?, density: 0.01–0.3, height: 1–6 }`**
   - Clump count = `round(density * n * n / 16)`. Each clump: a position
     from `rng`, then 2–4 blades. Each blade is a vertical run of
     `height` (scaled) pixels going up from the clump base, offset −1, 0 or
     +1 px sideways, drawn in `color` with its top pixel in `light` when
     given.
   - Every coordinate is taken modulo `n`, so blades that cross an edge
     continue on the other side.
6. Validate every new field with the existing `range`/`range_u` helpers,
   naming `layers[i].<field>`. The 8-layer cap is unchanged.
7. Run `./scripts/export-ipc-types.sh`.
8. In `recipeGuide()`, add one entry per layer in the existing format, two
   lines at most each. Example: `- { type: "planks", axis, w, len, gap,
   colors, seam, grain?, relief?, jitter? } — boards: wood floors, decks.`
   Replace the river example with:
   `oak plank floor: { base: { ramp: ['#5a3a22','#6b4529','#7a5030'], cells: 6 }, layers: [{ type: 'planks', axis: 'x', w: 6, len: 24, gap: 1, colors: ['#8a5a34','#7c5030','#946238'], seam: '#3a2414', grain: 0.6, relief: 0.4, jitter: 0.5 }] }`
9. Live check: `cases-05.json`, run with phase 01's `run.mjs` through
   `make_asset`, writing to `tiles/`:
   - "a 32 px oak plank floor"
   - "a 32 px cobblestone street"
   - "a 32 px hexagonal stone paving"
   - "a 32 px herringbone brick path"
   - "a 32 px short meadow grass"

   Save the outputs and previews to `live/phase-05/`. Note in
   `live/phase-05/results.md` which layer each recipe used, and whether
   it reads as the material.

## Build gate

From `src-tauri/`: `cargo test`, `cargo clippy`, `cargo fmt -- --check`.
Then `./scripts/export-ipc-types.sh` (no drift), `npm run check`,
`npm run lint`, `npm run format:check`, `npm run test`.

## Test plan

- `every_layer_tiles_at_every_size` includes all five layers, at 16, 32
  and 64 px over 20 seeds. Planks, stones, hex and herringbone are held to
  the patterned bar (seam no sharper than the sharpest interior step,
  ×1.15 + 1). Tufts is held to the noise bar (×1.25 + 1).
- The phase 04 pixel-hash test still passes: no existing layer changed.
- Herringbone decomposition test (step 4).
- `hex_cells_are_about_equal`: at 64 px, `size: 8`, no cell's pixel count
  differs from the mean by more than 25%.
- `tufts_wrap`: a single clump placed at `(n-1, 0)` (seeded so) shows
  blade pixels on both the right and left edges.
- Validation tests for each new field's range.
- `write_previews` renders `new-layer-recipes.json` beside the prototypes,
  for a person to look at; check it before the PR.
- Live check results recorded (step 9).

## Commit

`feat(textures): planks, stones, hex, herringbone and tufts layers`

## Rollback

Revert the commit and rerun `./scripts/export-ipc-types.sh`. Any saved
recipe using a new layer is then refused with a named error, and its
texture fails until the recipe is rewritten; a re-run's recipe stage
writes a new one only when the entry has no recipe. Phases 06–09 don't
reference the new layers by name, so they survive a revert. Phase 10's
live cases ask for materials (grass, wood) that would fall back to noise
layers, so rerun phase 10 after a revert.

## As built

- **Hex scale corrected.** The vertical factor is `0.866 · r / c`, not
  `c / r · 0.866` as step 3 says. The first value makes row spacing 0.866
  of column spacing, which a true hexagonal lattice needs.
- **Herringbone mortar is one-sided,** like `bricks`: on each brick's top
  and left edges only. Mortar on all four sides drew twice the asked-for
  gap, and the first preview showed bricks drowned in mortar.
- **Stones take the averaged tiling bar,** like cracks, not the patterned
  one. Their mortar falls anywhere, so one seed's seam can beat that
  seed's sharpest column step by chance. Over 20 seeds, the worst seam
  stays below the worst interior step for every option.
- `fixtures/new-layer-recipes.json` holds one example per layer, rendered
  by `write_previews` and checked by a test.
