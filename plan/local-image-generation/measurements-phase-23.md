# Phase 23 measurements — texture prompts

Measured 2026-10-01 on Ming-Image-0.1-Design (w4a8 encoder, 1024, 12 steps,
seeds 1 and 2), against four textures from the asset-test run whose output
was brown, gridded or in perspective. Scripts and contact sheets:
`~/Projects/asset-spike/p23ab.py`, `p23b.py`, `p23ab.png`, `p23b.png`.

This is the prompt half of the phase. Steps 1–2 (seam metric, tiling
approach) are still to do.

## What the asset-test run showed

All fourteen textures came out rust-and-grey. The cause was the style line,
not the palette: textures were already quantized to their own palettes, and
none of their colours came from the anchor. The style line said
"desaturated rust-and-concrete palette", and the style is in every prompt.
Separately, "seamlessly tiling" (the derivation's wording for every texture)
drew grids of tiles, and with no view stated a road receded to a horizon and
a warehouse floor came with the warehouse.

## Round 1 — old prompt against a new one (8 + 8)

New: style with no colour scheme, view stated, "seamlessly tiling" removed,
"large chunky features, five or six across the frame".

| | old | new |
|---|---|---|
| own colours (green weeds, olive water) | 0 / 8 | 8 / 8 |
| top-down, no perspective | 4 / 8 | 8 / 8 |
| grid or border | 6 / 8 | 6 / 8 |

The feature count backfired: concrete and water became a few big blobs and
rocks. Dropped.

## Round 2 — "from directly above" against "straight on" (8 + 8, + 4 walls)

Prompt: `<style>. A flat game texture of <surface>, seen <view>. One
continuous surface filling the whole frame edge to edge: no perspective, no
horizon, no grid lines, no border, no frame.`

| | from directly above | straight on |
|---|---|---|
| ground top-down | 8 / 8 | 7 / 8 (road in perspective at seed 1) |
| grid or border | 1 / 8 (water, seed 2: a pond with a rim) | 1 / 8 |

Walls straight on: brick 2 / 2 clean, concrete 1 / 2 (seed 1 drew windows,
seed 2 a framed panel).

## Built

- `textureScaffold` (`request.ts`): the round-2 prompt, "straight on" when
  the surface names a wall, facade or front, otherwise "from directly above";
  "seamless(ly) tiling" stripped from the subject. DiT backends only: on SD
  it would cost ~35 of CLIP's 77 tokens.
- Derivation guidance (`prompts.ts`, both spec tools, guided planning): the
  style names medium, line weight and saturation, never a colour scheme;
  entry prompts carry their own colours; textures name the surface, not
  "seamless" or "tiling".
- Judge: no longer asks for the reference's palette (each sheet has its own);
  a texture is also asked whether it is a flat surface with no perspective,
  border or grid.
