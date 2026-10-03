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

## The full chain (step 1), first attempt — 2026-10-02

Guided planning → assets → coding in `~/Projects/p25-chain`, unattended after
the interview. Run 75 (planning) succeeded; the asset stage wrote no spec and
the chain went straight to coding (run 76, cancelled). Three faults:

1. **The spec was lost to unparsed arguments.** The model sent `entries` as a
   JSON string. The tool registry coerces that before a tool runs, but the
   stage captured the raw arguments in `onToolStart`, and `derivePlanSpec`
   walked the string one character at a time: dozens of "(an entry with no
   id)". Fixed where it applies to every stage: `onToolStart` now receives
   the coerced arguments (`loop/iteration.ts`), and `derivePlanSpec` takes
   nothing from entries that are not a list.
2. **The interview did not know art was coming.** It asked where the art
   comes from (recommending drawing it in code) and how the files are named
   (offering three layouts, none of them the one the asset stage writes).
   Every planning turn is now told the paths and that this is decided
   (`generatedArtNote`), and to state the pixel size.
3. **The chained asset job drew at 64 px for a 32 px game.** The job's size
   wins over the spec's and was never set. The plan's tool now reports
   `targetSize`, the spec carries it, and the chained job is created with it.

Also: the plan tool now takes `sheet` and `anchorSheet` as the standalone one
does, so a chained run's sprites are grouped rather than all on "sprites".

Separately, verification left five blocking findings for coding's preflight
(a gate expecting `imported: 3 modules` from `len(sys.modules)`, among others).
Plan quality, not assets; noted here, not addressed.

## The full chain, second attempt — 2026-10-02

The interview asked nothing about art this time, and the plan named the art
correctly (phase 07 loads all twelve ids, from `texture/` or `tile/`). The
asset stage still wrote no spec: "the model never submitted one".

Cause: the stage's tool allowlist named its read tools but not its own submit
tool, the only forced-tool stage that did so. The model, correctly, never
called a tool it was not offered; the loop then forced a call to that tool in
a request that did not contain it, which vLLM refuses ("The tool specified in
`tool_choice` does not match any of the specified `tools`", 400), and the
turn ended empty. The first attempt only got as far as it did because the
model called the unoffered tool anyway.

Fixed in the stage, and structurally in the loop: a forced final tool is now
always added to a turn's allowlist. Checked outside the app against the same
model and plan: with the tool offered, the model submitted on its eighth call
— 12 entries as a real list, `targetSize` 32, `anchorSheet` `characters`,
grouped into characters, pickups and hud, ids matching the plan's.

## The full chain, third attempt — 2026-10-02

Minimal "test fixture" brief (2 phases, 2 textures, 2 sprites). The asset
stage submitted a list this time; the spec failed validation — "The style has
no prompt" — and the chain fell through to coding without art. The likely
shape: `style` sent as a plain string where the schema asks for `{ prompt }`,
which coercion cannot turn into an object. Both derivations now accept a
string style, and a missing style line falls back to a neutral one (said in
the step) rather than losing the set. The handoff now says "starts WITHOUT
art" and why, when art was asked for and not made.

The coding run then did something worth recording on its own: after two
honest repair cycles it read Haruspex's database and source, diagnosed the
fault correctly, and generated the PNGs itself against the user's ComfyUI
with Z-Image-Turbo. Not a pass for this phase; logged in `plan/futures.md`.

## The full chain, fourth attempt — 2026-10-02: passed

Same test-fixture brief. Planning (run 81) wrote `assets.json` with four
assets (grass, stone, player, coin) and started the asset job; the asset job
(run 82, 18:43–18:49) generated all four — one sheet retry, the coin — and
started the coding job; coding (run 83, 18:49–18:54) finished 2 of 2 phases,
11 of 11 steps, no repairs. The PNGs' timestamps fall inside the asset run and
the coding run left them untouched; its tests load them (`Ran 8 tests … OK`).
The interview asked nothing about art.

Art: grass tiles seamlessly, stone stacks, the player and coin are clean but
the coin came out the player's size, and the player's piece kept a small orb
the model drew touching it (noted in `plan/futures.md`).

Found on the way: `research_url` summarised every page on the GLOBAL model
(`runSubAgent` took no backend), so a chain on compute:3000 was also calling
whatever Settings pointed at — compute2. Tools now receive the turn's backend.
