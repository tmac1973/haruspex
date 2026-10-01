# Phase 25 measurements — generated against procedural

2026-10-01. Phase 25 step 3: is this pipeline's output better than what an
autonomous coding run paints procedurally? Contact sheets:
`~/Projects/asset-spike/p25/compare_64.png` and `compare_32_x2.png`.

## The two sets

- **Procedural**: `dark_times_2`'s `asset-gen` crate, written by a coding run:
  105 entries at 32 px in four atlases (13 terrain, 9 structure, 76 items and
  mobs, 7 UI).
- **Generated**: `asset-test`, the same game's spec through this pipeline on
  Ming-Image (sheets, transparent start, per-sheet palette, offset-and-inpaint
  textures), at 64 px. The 32 px row is the 64 px output box-downscaled, which
  is close to what the pipeline does at a 32 px target but not identical.

The ids do not match one for one, so each row compares like with like: twelve
ground tiles, the creatures, twelve items, and twelve props (procedural has no
props to set against them).

## By category

| | procedural | generated | better |
|---|---|---|---|
| items | 5 guns share one silhouette in two colours; consumables are one flask recoloured; scrap and battery are noise squares | pistol, shotgun, rifle, knife, crowbar, medkit, can, bottle each read at a glance, at 32 px too | **generated, by a wide margin** |
| creatures | three templates (dog, humanoid, blob) recoloured; drones are a diagram | each a character with gear and posture | **generated**; but survivor, raider and merchant are all brown and close to one another |
| props | none | dumpster, barrel, crates, car wreck, hydrant, vending machine, campfire, tree — all clear | **generated** (nothing to compare) |
| ground | flat, clean, high contrast, colours say what it is (green grass, blue water), tiles exactly | richer but busy; muted; noisy at 32 px; the road came out as a grid of yellow lines, the office floor as speckle, the concrete wall as panels | **procedural**, for readability at 32 px |

## What this decides

- **Sprites, items, props, icons: the pipeline is worth it.** This is the
  gap a coding run cannot close: it draws templates and recolours them, and
  its output says "placeholder". The generated set is a game's art.
- **Ground textures at small sizes: not yet.** Procedural tiles are easier
  to read under sprites, which is what ground is for. Two ways forward, not
  exclusive:
  1. Ask for less: ground prompts that say "large flat areas, few details,
     strong single colour" — the opposite of what the model does unasked —
     and judge at 32 px.
  2. Let a spec route textures to a project's own painter where it has one
     (phase 23's option c), and keep generated textures for walls and
     surfaces seen large.
- **Character distinctness** needs the spec to carry it: colours and a
  silhouette cue per character ("in a red jacket", "hunched, pale"), which the
  derivation guidance now asks for entries generally but not for characters
  that share a sheet.

## The re-run criterion (step 2)

Ten finished sprites from six sheets were deleted from `asset-test` and the
job re-run on Ming (`~/Projects/asset-spike/p25/rerun_compare.png`: old, new,
three untouched neighbours from the same sheet).

- **Mechanically right.** Exactly the ten came back, none failed, the other
  72 were not touched. They were drawn as one small sheet per group (2, 1, 2,
  1, 1 and 3 subjects); 6 of 7 generations cut exactly, `campfire` took one
  retry.
- **Style holds**: outline weight, shading, pixel density and grime match the
  neighbours for mailbox, hydrant, road sign, crates, barrier, pill bottle and
  battery.
- **Scale, angle and finish drift when a subject is drawn with few others.**
  The shotgun, alone on its sheet, came out small, thin and horizontal beside
  large diagonal weapons; the keycard came out clean where the supplies are
  weathered; the campfire flatter, with a greenish ring.

**Built: padding.** A re-run or retry sheet of one to three subjects is filled
to four with finished members of the same group, drawn alongside and
discarded after the cut (`sheets.ts` `padding`). Drawing together is what
fixes scale and finish (phase 21); the padding gives a small sheet something
to draw together with, at no cost — the sheet is 1024 either way.

The same ten re-run padded (`rerun_padded_compare.png`: original, unpadded,
padded, neighbours; ComfyUI's history confirms every sheet went out with four
subjects). 6 of 6 sheets cut exactly.

| | unpadded | padded |
|---|---|---|
| shotgun | small, horizontal | large, diagonal, like its neighbours — **fixed** |
| mailbox | green, clean | grey, weathered — **fixed** |
| keycard | clean, shiny | some wear, still lighter than the supplies — better |
| campfire | flatter, greenish ring | flatter, sandy ring — not fixed |
| the other six | in style | in style |

Scale and angle follow the padding reliably; finish only partly.

Not run: the bundled engine, which cannot run Ming (phase 24).
