# Phase 22 — The first sheet is the anchor

**Depends on:** 17 (step 3), 21 · **Enables:** 25.

## Goal

The style anchor stops being a separate picture of subjects chosen to be
representative, and becomes the first sheet the run actually needs. It is
still the one human checkpoint, still committed with its recipe, and still the
source of the palette. What keeps later sheets — and later runs — consistent
with it is whichever mechanism phase 17 step 3 measured to work.

## Why

The old anchor existed to be conditioned on by IP-Adapter, which is gone
(phase 18), and choosing its subjects was an unsolved problem in itself
(phase 16 step 3b: four subjects cannot span a set's colours, and the palette
described only those four). A first sheet chosen for spread solves both at
once: it is real output, so approving it approves real assets, and its
subjects are the set's own.

The overview's re-run promise survives: "months later the user adds ten
entries and they match the hundred already shipped". It now rests on the
committed anchor sheet plus the palette, and on whatever phase 17 found for
cross-sheet consistency.

## Files touched

- `src/lib/agent/jobs/types/asset-generation/anchor.ts` — rewritten; most of
  it goes (`anchorPrompt`, `anchorSubjects`, `ANCHOR_NEGATIVE`,
  `colourWord` if the opaque fallback no longer needs it).
- `src/lib/assets/spec/types.ts` — `AnchorRecipe` records the sheet request
  and which entries it produced.
- `src/lib/agent/jobs/types/asset-generation/prompts.ts` — the derivation turn
  marks one sheet as the anchor sheet.
- `src/lib/agent/jobs/types/asset-generation/pipeline.ts` — the Anchor stage
  generates and presents that sheet; the Generate stage then skips its
  entries, which are already written.
- Tests beside each.

## Steps

1. **Choosing the anchor sheet.** The derivation turn picks one sheet whose
   subjects together span the set's materials and colours — phase 16 step
   3b's instruction, now aimed at a sheet that will be generated anyway. The
   spec records it (`anchor.sheet`). A spec without one uses the first sheet
   of sprites.
2. **Generating it.** Exactly as phase 21 generates any sheet, with the same
   cut, checks and cell retries. Its accepted pieces are written as assets;
   the whole sheet image is written as `haruspex-anchor.png`.
3. **The checkpoint.** Attended runs present the anchor sheet, its cut pieces
   and the spec summary together, as today. Approve, regenerate at a new seed,
   or stop to edit the spec. Chained runs auto-accept, as today.
4. **The palette** is extracted from the anchor sheet's pieces — the cut
   sprites, not the sheet, so empty canvas cannot enter it — and written into
   the spec as today.
5. **Consistency for later sheets is the style line plus the palette.** Every
   later sheet uses the anchor's style line and is quantized to its palette,
   and nothing more is built. Measured in `measurements-phase-17.md` §3: a
   different nine subjects under the same style line sit about as far from
   the anchor's palette as the anchor's own subjects at another seed; passing
   the anchor as a reference image made sheets less consistent, and with the
   whole sheet as reference Ming redrew the anchor instead.
6. **The recipe** records the sheet's full request (prompt, seed, model,
   family, size, the transparent-start denoise it resolved to), the resulting
   palette, and which entry ids came from it. Reuse keys on the recipe as it
   does now: an unchanged recipe makes no backend call.

## Deviations, as built

- **The old anchor stays, for backends without alpha.** Phase 18 kept the SD
  family on ComfyUI, and an SD checkpoint cannot make sheets; so
  `establishAnchor` makes a sheet anchor only when the backend reports
  transparency, and the separate picture of representative subjects
  otherwise. `anchorPrompt`, `anchorSubjects` and their tests stay with it.
- **The anchor's assets are cut from the anchor image itself.** The anchor
  generation is handed to the Generate stage (`deps.pregenerated`) as that
  sheet's first round, so the assets written are the ones the person
  approved, not a fresh generation nobody saw. If some of the sheet's assets
  are already on disk the cut would not line up, so the sheet is generated
  again for just the missing ones.
- **The palette comes from the cut sheet in Rust.** `image_split_sheet`
  extracts it after keying and hardening, when only the subjects are opaque —
  which is the same as "from the pieces", without sending them back across
  the IPC boundary.
- **The capability check moved before the Anchor stage**, since what the
  anchor is depends on it.
- **Not live-run as a stage.** The sheet generation and cut it relies on were
  live-checked in phase 21; running the stage itself needs the app, which is
  phase 25.

- **Revised after the first real run (2026-10-01): each sheet takes its own
  palette.** "Prompt plus the anchor's palette" failed on the first job: the
  anchor sheet (a sword and a potion) had no gold in its 32 colours, and the
  gold coin was rejected three times as "too far from the anchor palette".
  On a backend with alpha, each sheet is now quantized to a palette extracted
  from that sheet, and a lone image (a texture) to its own. Phase 17 had
  already measured separate sheets as close to each other as one sheet is to
  itself at another seed, so the shared palette was buying little and costing
  every colour the anchor happened not to contain. The anchor's palette is
  still extracted and recorded, but imposed on nothing, so a sheet anchor is
  no longer re-rolled for a palette that leans on one colour. The one
  shared palette remains on the one-image-per-entry path (SD backends).

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

## Test plan

- A spec naming an anchor sheet generates that sheet in the Anchor stage, and
  the Generate stage issues no request for its entries.
- A spec naming none uses the first sprite sheet.
- The palette comes from the pieces: a sheet whose canvas (under alpha 0)
  holds a colour no piece uses does not contribute that colour. Verify by
  extracting from the whole sheet instead and watching it fail.
- Reuse still reuses: unchanged spec and recipe → zero backend calls.
- The attended checkpoint shows the sheet and its pieces; the chained run
  never waits on it.
- Phase 16's anchor tests for rules that no longer exist (no "reference sheet",
  no ground among subjects) are deleted with the code they tested, not left
  asserting against nothing.

## Commit

```
feat(assets): make the first real sheet the style anchor
```

## Rollback

Revert together with phase 21. A project whose anchor was made by this phase
carries a recipe with fields the old anchor stage does not know; check what
the old reuse test does with it before relying on the old stage to keep that
project's style, and expect to regenerate its anchor.
