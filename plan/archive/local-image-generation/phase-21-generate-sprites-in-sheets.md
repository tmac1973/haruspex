# Phase 21 — Generate sprites and icons in sheets

**Depends on:** 17 (steps 1–2), 18, 20 · **Enables:** 22, 25.

## Goal

The generation stage makes sprites and icons several at a time: one request
per sheet of subjects, cut apart by alpha, each piece matched to its entry,
checked, and written. A cell that comes out wrong is regenerated, not the
whole sheet. Textures keep the per-entry path until phase 23.

## Why

The spike's strongest result (finding 2): subjects drawn in one image share
a style by construction, which is what IP-Adapter was trying and failing to
impose one image at a time. It is also cheaper — a nine-sprite Ming sheet
costs about two SDXL singles. The cost is that a sheet can come back with the
wrong layout (finding 5: 5 of 12 exact at nine per sheet), so the cut is
verified, never trusted.

## Files touched

- `src/lib/assets/spec/types.ts` — `AssetEntry.sheet?: string`.
- `src/lib/assets/spec/validate.ts` — sheet groups: one kind, bounded size.
- `src/lib/agent/jobs/types/asset-generation/sheets.ts` (new) — grouping,
  the sheet request, cell assignment.
- `src/lib/agent/jobs/types/asset-generation/generate.ts` — the loop walks
  sheets for sprites and icons.
- `src/lib/agent/jobs/types/asset-generation/request.ts` — loses the isolation
  scaffold for transparent backends.
- `src/lib/agent/jobs/types/asset-generation/prompts.ts` — the derivation
  prompt groups entries.
- `src/lib/agent/jobs/types/asset-generation/report.ts` — sheet lines.
- `src/lib/agent/jobs/types/asset-generation/config.ts` — defaults.
- Deleted: `promptBudget.ts` and its test (CLIP's 77-token window does not
  apply to either model family), and `nativeEdge.ts` if phase 19 step 6 found
  nothing left reading it.

## Steps

1. **Grouping.** An entry may name a `sheet`. The derivation turn is asked to
   group sprites and icons into sheets of things drawn at the same scale and
   from the same view — items with items, characters with characters,
   vehicles with vehicles — because a sheet renders its subjects at one scale,
   and a coin beside a building is drawn either as a giant coin or a toy
   building. Entries with no `sheet` are grouped mechanically, by kind, in
   spec order. A group larger than the sheet size (phase 17 step 2) is split.
2. **Sheet request.** One request per group: the style line, then the
   subjects in reading order with their grid positions spelled out ("top
   left: …; top centre: …"), the grid size, "wide empty gaps between them,
   all at the same scale", and the view once for the whole sheet if the group
   shares one. `transparent: true`. Nine per sheet at 1024, always — at 2048
   the model draws sprites no larger and fills the space with duplicates
   (`measurements-phase-17.md` §2). A 1024 3×3 cell is about 340 px, over
   five times a 64 px target. An opaque sheet (6 of 103 generations at 1024,
   all at one seed, layouts intact) is keyed by phase 20's fallback, not
   regenerated, and the report counts it.
3. **Cut and assign.** `split_sheet` (phase 20), then assign each piece to the
   grid cell containing its centroid. Per cell:
   - one piece, fully inside the cell → the candidate for that entry;
   - no piece → missing;
   - two or more pieces → take the largest, mark it suspect;
   - a piece whose bounding box crosses into a neighbouring cell → a merge;
     every cell it touches fails.
4. **Is it the right subject?** Position cannot catch a subject drawn in the
   wrong cell (the spike's duplicated jerrycan). When the job's model has
   vision, each candidate is judged against its entry's prompt with the
   existing judge turn, and suspect candidates always are. Without vision, the
   report states that subject identity was not verified for this set.
5. **Per-candidate checks.** Normalize and gate each candidate exactly as a
   single asset is today. Anything written is written through the same
   skip-existing rule, so deleting ten files and re-running regenerates those
   ten.
6. **Retries.** Failed cells from a sheet are regenerated together as a
   smaller sheet, not one at a time — the survivors of a sheet carry the style,
   and a retry sheet stays closer to it than singles would. A retry sheet of
   one is a single-sprite request with the transparent start (phase 17 step 1).
   Each entry keeps its own attempt budget; an entry out of budget is recorded
   unresolved with the reason, as today.
7. **Partial re-runs.** A sheet with some entries already on disk generates
   only the missing ones, as a smaller sheet. Phase 22 decides what keeps that
   sheet consistent with the committed set.
8. **Defaults.** `DEFAULT_TARGET_SIZE` 32 → 64 (spike, finding 7). 32 remains
   available per entry and per spec. `upscale` stops deciding sprite
   generation size; the sheet size does.
9. **Prompt cleanup.** For a backend reporting `transparency`, the isolation
   scaffold and `ISOLATION_NEGATIVE` go — they exist to make a keyable
   backdrop. They stay for the opaque fallback, where they are still the only
   thing producing one.
10. **Report.** Per sheet: subjects, exact cut or not, which cells failed and
    why (missing, merge, wrong subject, gate), retries. The aggregate line
    leads with how many sheets cut exactly, because that is the number that
    says whether the sheet size is right for this model.

## Known limits, carried not solved

- **Top-down view** is weak in sheets (spike, finding 6). The judge can reject
  a wrong view when the entry states one; nothing makes the model obey. If
  that rejection rate is high on a real set, top-down entries get a sheet size
  of one.
- **Relative scale within a sheet is lost** at normalization: every piece is
  cropped and scaled to the target size, as single assets were before.

## Deviations, as built

- **Ming needs its RGBA phrase as well as the transparent start.** The first
  live sheet through `sheetRequest` came back opaque on a painted concrete
  backdrop. A/B at fixed seeds: the same sheet prompt without
  "RGBA, 4-channel, transparent background." was opaque 4 of 4 times at
  seeds that were transparent 4 of 4 times with it. Phase 17 had always used
  the phrase, so this was invisible until the job built its own prompt. The
  fix is in the image layer (`ming_t2i_rgba` now wraps the prompt), not here.
- **Sheets only when the backend reports transparency.** Textures, and every
  entry on a backend without alpha (an SD checkpoint on ComfyUI), keep the
  one-image-per-entry path unchanged. `promptBudget.ts` and `nativeEdge.ts`
  stay for that path, since phase 18 kept the SD family.
- **Pieces go to the nearest expected position, not a uniform grid cell.** A
  short last row is drawn centred, so the seventh of seven sits in the middle
  column; a uniform grid called it missing. `expectedCentre` places it where
  the model draws it, and a piece whose body covers another subject's
  position is a merge.
- **A retry sheet of one is a single centred sprite**, asked for as such.
- **The loop lives in `sheetLoop.ts`**, with the guards both paths share in
  `guards.ts`; outcomes reach the report through `deps.onSheet` rather than a
  changed return type.
- **The live check is in two halves.** `sheets.live.test.ts` generates a real
  sheet through `sheetRequest`; `split_a_real_sheet` (Rust, ignored) cuts it.
  Two random-seed sheets: 9 of 9 pieces each, every subject right and in
  order. A full job run inside the app was not done here — it needs Tauri —
  and is phase 25's.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

## Test plan

Against a stubbed backend returning synthetic sheets — squares on a
transparent canvas at chosen positions — so each layout fault is constructed
exactly:

- An exact nine-square sheet writes nine assets, one request.
- A sheet with cell 5 empty writes eight and issues one retry sheet containing
  only cell 5's entry.
- A merge across cells 1 and 2 fails both and retries both together.
- Two pieces in one cell mark the candidate suspect and send it to the judge
  even when the judge is otherwise off.
- Grouping: named sheets are honoured; unnamed entries group by kind in spec
  order; a group of eleven at a sheet size of nine becomes nine and two.
- Validation rejects a sheet mixing a texture with sprites.
- Skip-existing: with four of nine on disk, the request lists five subjects.
- **Live, env-gated:** the `asset-smoke` spec runs end to end through Ming on
  ComfyUI and writes its sprites and icon with real alpha.

## Commit

```
feat(assets): generate sprites and icons in sheets, cut by alpha and verified per cell
```

## Rollback

Revert. Entries carrying `sheet` still parse and the per-entry loop runs them
one at a time. The parser drops unknown entry fields, so a reverted job that
rewrites the spec (it does when the palette changes) loses the `sheet`
grouping; regrouping is one derivation run.
