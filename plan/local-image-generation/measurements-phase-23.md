# Phase 23 measurements — texture prompts

Measured 2026-10-01 on Ming-Image-0.1-Design (w4a8 encoder, 1024, 12 steps,
seeds 1 and 2), against four textures from the asset-test run whose output
was brown, gridded or in perspective. Scripts and contact sheets:
`~/Projects/asset-spike/p23ab.py`, `p23b.py`, `p23ab.png`, `p23b.png`.

The first half is the prompt (colour, view, grids); the second, from
"Seam metric", is tiling.

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

## Seam metric (step 1)

`src-tauri/src/image_gen/tiling.rs`. Four measures were built and run on
fifty textures at 64 px (the asset-test set before and after the prompt
change, and the round-2 spike outputs):

| measure | what it caught | why dropped / kept |
|---|---|---|
| seam ratio: wrap-edge step over inner step | real seams: 4.3–12.8 | **kept** |
| rim: border band against middle, in s.d. | thick vignettes (0.9–1.15) | fired on large natural patches (inpainted weeds 0.85) |
| edge line: column/row outliers at the edge | thin frames | fired on lane markings (8.4) and slab joints (15) |
| repetition: self-correlation at 1/2, 1/3, 1/4 | synthetic grids | legitimate slab floor 0.67–0.83, as high as a grid |

The seam ratio alone misses a frame drawn on both edges (both edges equally
dark: 0.13–0.16), so it is taken at the worse of the image and the image
rolled by half — a frame becomes a seam through the middle. With that, what
looked right scored at most 1.8 and what did not at least 4.3. The gate is
3.0 (`TEXTURE_SEAM_MAX`), applied only when the backend was asked to tile.

## Tiling approaches (step 2)

**b. Ask for a 2×2 grid, keep one cell — rejected.** 12 of 12 grids came back
with a dark frame round every copy, so each cell tiles as a framed panel.

**a. Offset and inpaint — built.** Roll by half, repaint a cross over the
seams, at seed+100, five hard cases at seed 1 or 2:

| variant | result |
|---|---|
| hard-edged 256 band, denoise 1.0 | frames gone; repaint a different tone (pale stripe on water, pillar on concrete) |
| hard-edged 256 band, denoise 0.75 | frames survive |
| DifferentialDiffusion, 256 band, feather 64, denoise 1.0 | **best**: blends, frames gone |
| DifferentialDiffusion, 192 band, denoise 0.9 | frames survive |
| hard-edged 128 band | lane markings broken, smudges |

Built into one ComfyUI graph (`ming_t2i_seamless.json`), three things the
spike did not show:

- ComfyUI's `ImageBlur` sigma is in kernel-normalised units, not pixels:
  sigma 8 was a flat box blur, and the mask peaked at 0.8. At 0.8 the old
  border survives (as at denoise 0.9). Fixed with radius 16, sigma 0.5 at an
  eighth scale, and the mask added to itself so the middle is solid.
- The cross's arms run to the image edges, and each end is painted without
  its wrap partner: short dark marks at the midpoints of every tile edge
  (seam up to 3.04). A second pass rolls by a quarter, which moves those
  points inside, and repaints two patches there.
- After both passes, 12 of 12 (six textures, two seeds) tile with no visible
  seam, frame or mark; seam 0.62–1.48 against 0.39–2.45 for the same
  generations raw. Colour and view are unchanged.

Cost: two more sampling passes. About 55 s a texture warm on the 9070 XT
against 18 s for a plain generation (the text encoder on the CPU adds ~60 s
the first time a prompt is seen).

**c. Procedural — not tried.** Offset and inpaint reached the bar first.

## Feature scale (step 3)

Not built. "Five or six across" made concrete and water into a few big
blobs (round 1). Textures that read as noise at 64 px (office floor, rubble)
remain; the judge can reject them.
