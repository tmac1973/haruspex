# Phase 23 — Textures

**Depends on:** 18, 22 (palette) · **Enables:** 25.

## Goal

Terrain textures that tile, in the set's style, from a DiT model — or an
honest finding that the procedural path is better for them, and the job
routing textures there.

## Why this is its own phase

Nothing in the spike produced a usable tileable texture (finding 8). The
circular-padding trick that made SDXL tile does not transfer to a DiT
(phase 14 step 12), and the wrap-edge metric was fooled by Ming drawing a
small tile repeated in a grid with visible gutters. Sprites should not wait
for this.

The overview already allows the answer "procedural": "Where a project has a
deterministic painter, that remains a legitimate and often better choice at
small sizes."

## Steps

1. **A better seam metric first.** The spike's wrap-edge-jump ratio scores a
   texture with gutters as seamless because its edges match. Add a
   repetition check: the autocorrelation of the tile at offsets other than
   its own size. A tile that repeats inside itself is a grid, not a texture.
   Build the metric as a Rust check with synthetic tests before trying any
   generator.
2. **Evaluate three approaches**, each on the five spike textures at two
   seeds, scored by both metrics and by eye at 2×2 tiling:
   - **a. Offset and inpaint.** Generate, shift by half the tile in both
     axes, inpaint a band over the now-central seams, shift back. Phase 14
     step 12's DiT remedy. Needs an inpainting path for the family (Ming edit
     with a mask, or the model's own inpaint support — find out which exists).
   - **b. Ask for the grid, keep one cell.** Ming drew repeated grids
     unprompted. Ask for "a 2×2 grid of the same seamless tile" and cut one
     cell; test whether the cell's own edges wrap.
   - **c. Procedural.** The dark_times `asset-gen` painter, or equivalent,
     quantized to the anchor's palette. This is phase 16 step 4's comparison,
     done for textures specifically.
3. **Feature scale** (from the SDXL findings, still true). The prompt states
   how many features span the tile ("large stones, five or six across") and
   the target size is checked against it, because at 64 px a tile of hundreds
   of stones averages to flat grey.
4. **Decide and build one.** Build the approach that won, behind the same
   `seamless` request flag the backend already has — a backend that implements
   it reports `seamlessTiling: true`, one that does not reports `false` and
   the job degrades and says so, exactly as now. If procedural won, textures
   route to it and the spec's texture entries say so in the report.

## Deliverable

`measurements-phase-23.md` with the comparison, then the built approach.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

## Test plan

- The repetition metric flags a synthetic 4×4 grid of one tile, passes a
  synthetic noise texture, and passes a genuinely wrapping synthetic tile.
- Whichever approach is built: a texture it produces passes both metrics on
  a fixture, and `seamlessTiling` is `true` only for a backend that runs it —
  the "capability claim nobody checks" failure `image/types.ts` warns about.

## Commit

```
feat(assets): tileable textures from <the approach that won>
```

## Rollback

Revert. Textures go back to generating unseamed and reporting "not seamless",
which is today's behaviour on the DiT families.
