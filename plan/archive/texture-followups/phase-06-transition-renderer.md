# Phase 06 — The transition renderer

**Depends on:** phase 04 (materials may carry relief, and the pixel-hash
guard) · **Enables:** phase 07 (`make_asset` transitions), phase 09 (the
job's transitions).

**PR:** 3 of 3 ("transitions": phases 06–10).

## Goal

Draw a 16-tile corner set from material recipes, in Rust, as one 4×4
sheet, plus a preview of the set laid out as a small map for a person or a
judge to look at. There are two kinds:

- **top-down**: material A meets material B;
- **side-view**: a solid material against transparent air, with an
  optional cap recipe along upward-facing edges.

Where all four corners are one material, a tile equals that material's
plain tile drawn with that material's own seed, so a set mixes with the
plain tiles on a map. Each material therefore takes its own seed.

## Files touched

- `src-tauri/src/image_gen/texture/transition.rs` — new. Edge settings,
  validation, the mask, the sheet, the preview map.
- `src-tauri/src/image_gen/texture/mod.rs` — `pub mod transition;`,
  re-exports, tests.
- `src-tauri/src/image_gen/commands.rs` — `texture_transition_render`,
  `texture_transition_preview`, `texture_transition_validate`.
- `src-tauri/src/lib.rs` — register the three commands.
- `src/lib/ipc/gen/TransitionView.ts`, `TransitionEdge.ts` — generated.
- `src/lib/assets/texture.ts` — `renderTransition`, `transitionPreview`,
  `validateTransitionEdge`, `transitionMap` (the JSON map), and the
  `TRANSITION_ORDER` documentation constant.
- `src/lib/assets/texture.test.ts` — new. Tests for `transitionMap`.

## Steps

1. **Types** in `transition.rs` (serde `deny_unknown_fields`, `ts(export)`):
   - `enum TransitionView { Top, Side }`, serialised lowercase.
   - `struct TransitionEdge { wobble: Option<f32>, rim: Option<String>, cap_height: Option<f32> }`:
     - `wobble` is how far the border wanders, as a fraction of the tile,
       0–0.25, default 0.15;
     - `rim` is a `#rrggbb` line on material A's side of the border
       (top-down) or on the solid side (side-view); absent means no rim;
     - `cap_height` is in 32-pixel-tile pixels, 1–8, default 4; side-view
       only, and refused on a top-down set.
   - `validate_edge(view, edge) -> Result<(), String>`, naming
     `edge.wobble`, `edge.rim` and `edge.cap_height`.
2. **Corner order.** Tile index `i` in 0..16 has bits NW = 1, NE = 2,
   SW = 4, SE = 8. A set bit means material A (top-down) or solid
   (side-view). Tile `i` sits at sheet cell `(i % 4, i / 4)`. Index 0 is
   all B or all air; index 15 is all A or all solid.
3. **Mask** for tile `i` at size `n`. The noise field is
   `fbm(rng_w, n, 4, 2)` from a seed derived as
   `variant_seed(seed_a, 101)`, so it is independent of the materials' noise.
   It is periodic over the tile and shared by all 16 tiles. For pixel
   `(x, y)`:
   - `u = (x + 0.5) / n`, `v = (y + 0.5) / n`;
   - `m` = the bilinear blend of the four corners (1 for A or solid, 0
     otherwise) at `(u, v)`;
   - the pixel is A (or solid) if `m + wobble * 2 * (field - 0.5) > 0.5`.

   Because `wobble ≤ 0.25`, a tile with four equal corners is uniform.
   Because the field is shared and periodic, and the blend along a shared
   edge depends only on that edge's two corners, neighbouring tiles agree
   at every edge.
4. **Top-down sheet.** Draw material A's tile with
   `layers::draw(a, n, variant_seed(seed_a, 0))` and B's with
   `layers::draw(b, n, variant_seed(seed_other, 0))`. That is exactly how
   `render` draws variant 0, so these equal the plain texture tiles. Each tile copies A's pixel where the mask says A, else B's.
   If `rim` is set, an A pixel with any 4-neighbour that is B takes the rim
   colour. Neighbours are looked up within the tile only; one outside it
   is ignored, not wrapped, because the pixel beyond a tile edge belongs
   to whichever tile sits there. The border crosses tile edges rather than
   running along them, so this leaves no visible gap. A tile with all four corners equal
   gets no rim, since it has no border.
5. **Side-view sheet.** Draw the solid material's tile from `seed_a` and
   the cap's tile, if given, from `seed_other`, as in step 4. Air pixels are `[0, 0, 0, 0]`. A solid pixel is **cap** if,
   scanning upward within the tile, an air pixel lies within `cap_height`
   (scaled, rounded) rows above it. A cap pixel takes the cap tile's pixel.
   If `rim` is set, a solid pixel (cap or not) whose left, right or lower
   neighbour is air takes the rim. Air straight above gives the cap
   instead. As in step 4, neighbours are looked up within the tile only.
6. **Bounds.** At `wobble ≤ 0.25`, an upward-facing solid pixel lies no
   lower than row `⌈0.75n⌉ + 1` (one pixel allowed for rounding). A cap of
   at most 8 of 32 rows below it ends within a row of `n`. Any cap row
   that would fall past the tile is cut off, since the cap is found by
   scanning within the tile. One pixel row at most, and harmless. A test checks this (test plan). The reverse case is
   accepted: a solid pixel in row 0, with air in the bottom row of the tile
   above, gets no cap. That only happens where the border crosses a
   horizontal tile edge, where the tile's two top corners differ. That is
   a side face, so the pixel's left or right neighbour is air and it takes
   the rim from step 5.
7. **Sheet.** `render_transition(view, a, other, edge, size, seed_a, seed_other, palette) -> Result<RgbaImage, String>`
   validates each recipe (`recipe::validate`) and the edge, applies the
   palette snap as `render` does (air stays transparent), and returns a
   `4n × 4n` image. Sizes: multiples of 4 from 8 to 256, as `render`.
8. **Preview map.** `transition_preview(view, sheet, size) -> RgbaImage`
   picks tiles from a fixed corner grid and scales to about 480 px by a
   whole number:
   Rows are corner rows, top first; 1 is A or solid. Tile `(x, y)` takes
   corners `g[y][x]` (NW), `g[y][x+1]` (NE), `g[y+1][x]` (SW) and
   `g[y+1][x+1]` (SE). Both grids were checked to produce all 16 indices.
   - top-down, 7×7 corners → 6×6 tiles:
     `0000000 / 0000110 / 0110000 / 0101100 / 0110110 / 0001110 / 0000000`
   - side-view, 9×5 corners → 8×4 tiles (air on the top row, solid on the
     bottom):
     `000000000 / 101011100 / 011011001 / 100101100 / 111111111`

   Air shows as the sheet module's checkerboard, so transparency is
   visible.
9. **Commands** in `commands.rs`:
   - `texture_transition_render(view, a: TextureRecipe, other: Option<TextureRecipe>, edge: TransitionEdge, size, seed_a: u32, seed_other: u32, palette: Vec<u32>) -> Result<Vec<u8>, String>`
     returns PNG bytes. `other` is B, required for top-down, or the cap,
     optional for side-view. `seed_other` is ignored when `other` is
     absent.
   - `texture_transition_preview(view, sheet: Vec<u8>, size) -> Result<Vec<u8>, String>`.
   - `texture_transition_validate(view, edge: serde_json::Value) -> Result<(), String>`,
     with shape errors returned as a sentence, as `texture_validate` does.
   - Register all three in `lib.rs`. Run `./scripts/export-ipc-types.sh`.
10. **TypeScript** in `src/lib/assets/texture.ts`: `renderTransition`,
    `transitionPreview` and `validateTransitionEdge` wrap the commands with
    literal `invoke` names. `transitionMap(view, size, a, other) -> object`
    builds the JSON written beside a sheet. `a` and `other` are the
    material names to write. For top-down, `other` is written as `b`. For
    side-view, it is written as `cap`, or the key is left out when there
    is no cap:
    `{ version: 1, view, tile_size, columns: 4, a, b | cap, order: "NW=1 NE=2 SW=4 SE=8; a set bit is a/solid", tiles: [{ index, x, y, corners: { nw, ne, sw, se } }] }`.
    Corner values are the names given: `a`'s or `b`'s for top-down, and
    `a`'s or `"air"` for side-view.
    `x, y` are the cell's pixel offset in the sheet.

## Build gate

From `src-tauri/`: `cargo test`, `cargo clippy`, `cargo fmt -- --check`.
Then `./scripts/export-ipc-types.sh` (no drift), `npm run check`,
`npm run lint`, `npm run format:check`, `npm run test`.

## Test plan

Rust (`transition.rs` tests):

- `uniform_tiles_equal_the_materials`: top-down with seeds 7 and 9.
  Tile 15 equals `render(a, n, 7, 1, [])[0]` and tile 0 equals
  `render(b, n, 9, 1, [])[0]`, pixel for pixel, at 16, 32 and 64 px, with
  `rim` set.
- `neighbours_agree_at_every_edge`: for every pair `(i, j)` where i's east
  corners equal j's west corners, the step across i's right column and j's
  left column is no larger than the sheet's sharpest interior step
  (patterned bar: ×1.15 + 1). Likewise vertically with south and north
  corners. Over 10 seeds, for both views.
- `upward_faces_leave_room_for_the_cap`: side-view at `wobble: 0.25` over
  20 seeds. In every tile, each solid pixel with air directly above it
  (within the tile) lies in a row no lower than `⌈0.75n⌉ + 1`, so `cap_height ≤ 8` fits
  inside the tile. For any corner pattern, the solid side needs a blend
  above 0.25, and that blend reaches row `0.75n` at most.
- `cap_only_on_upward_faces`: side-view with a cap whose colour is unique.
  Tile 12 (SW and SE solid, top half air) has cap pixels. Tile 3 (NW and NE
  solid, bottom half air: a ceiling) has none.
- `air_is_transparent`: side-view tile 0 is all alpha 0; tile 15 has none.
- `edge_validation_names_fields`: `wobble: 0.3`, `rim: "red"`, and
  `cap_height` on a top-down set are each refused with the field's name.
- `preview_grids_cover_every_tile`: both layout constants produce all 16
  indices.

TypeScript:

- `transitionMap` lists 16 tiles in index order, with offsets
  `(i % 4 · size, ⌊i / 4⌋ · size)`, and corners matching the bit rule. For
  side-view, a cleared bit is `"air"`.

By eye: an `#[ignore]`d `write_transition_previews` writes grass/dirt
(top-down) and dirt with a grass cap (side-view) as previews in
`TEXTURE_PREVIEW_DIR`. Grass is the prototype fixture's `park` recipe.
Dirt is the prototype fixture's `camp` recipe (brown earth with
speckle), used as given.
Look at them before the PR.

## Commit

`feat(textures): 16-tile corner transition sets, top-down and side-view`

## Rollback

Revert the commit and rerun `./scripts/export-ipc-types.sh`. Nothing in
phases 01–05 uses it. Revert phases 07–09 first if they have landed.

## As built

- **The blend is sampled on the tile's edges.** Columns and rows 0 and
  `n − 1` sit exactly at `u, v = 0` and `1`, so the edge pixels depend only
  on that edge's two corners. A pixel one past an edge (`solid_at` with an
  out-of-tile coordinate) is then exactly what the neighbour draws there.
  The rim uses that one-pixel look past the edge. Sampling at pixel centres
  left a one-pixel break in the rim wherever a border crossed a tile edge;
  `neighbours_agree_at_every_edge` caught it.
- **The cap bound holds for flat and inner-corner tiles only** (12, 13,
  14). A tile with one solid corner curves its upward face down toward the
  tile below, and the cap there is clipped by a few pixels. That is where
  the corner turns into a side face, which takes the rim. The test checks
  12–14, not every tile.
- **The border field is finer than planned:** `fbm` at 8 cells, 3 octaves,
  with a default wobble of 0.1. At 4 cells and 0.15, every island in the
  preview had the same two big lumps on its top edge.
- **Lone pixels are cleaned up.** A pixel whose four neighbours all
  disagree with it takes their side, which removes specks the noise left
  along the border, each ringed in rim.
- `checker` in `sheet.rs` is `pub(crate)` so the preview can show air.
