# Phase 06 — Catch a small object cut out with a sprite

Depends on: — / Enables: —

## Goal

When a sheet's small neighbour is drawn touching a sprite, flag the cut piece
as suspect, so it goes to the judge. Today it's accepted as part of the sprite.
In the p25 chain, `player.png` came out with a coin-like orb stuck to its side.

**Why it gets through today:**
- `assignCells` (`asset-generation/sheets.ts:241`) only detects a merge when a
  piece's body covers another subject's expected centre. A small neighbour
  joined at the edge doesn't.
- When the rows come out exactly as asked, every piece is accepted with
  `suspect: false` and never reaches the judge.

**Two cheap signals:**
- **Lobes:** the piece falls into two substantial parts when its thinnest
  joins are opened.
- **Size outlier:** the piece is much wider or taller than its siblings.

## Files touched

- `src-tauri/src/image_gen/split.rs`: `Piece.lobes`.
- `src-tauri/src/image_gen/commands.rs`: `SheetPiece` gains `lobes` (built
  around :110 and :172; it is ts-exported, so the TS type follows from the
  export script).
- `src/lib/agent/jobs/types/asset-generation/gate.ts`: a `hint` parameter on
  `maybeJudge` and `JudgeDeps.judge` (around :142, :162).
- `src/lib/agent/jobs/types/asset-generation/sheets.ts`: suspicion from both
  signals.
- `src/lib/agent/jobs/types/asset-generation/sheetLoop.ts` and `prompts.ts`:
  what the judge is asked, and the report wording.
- Tests: `split.rs` tests, `sheets.test.ts`, `sheetLoop` tests.
- `./scripts/export-ipc-types.sh`.

## Steps

1. **Lobes, in Rust.** For each piece, take its own alpha mask:
   - open it (erode, then dilate) with a square kernel whose side is
     `max(2, round(0.04 × min(width, height)))`;
   - count the 8-connected components left whose area is at least 4% of the
     piece's area;
   - `lobes` is that count, at least 1.

   A sprite with a thin limb usually stays one lobe at this kernel, because
   the limb's own body survives the opening. Two blobs joined by a short neck
   become two. Pieces are already cut and small, so the cost is negligible.
2. **`SheetPiece.lobes: u32`** in `commands.rs`, set from `Piece.lobes`.
   Then run the export script.
3. **`assignCells` marks a piece suspect when either signal fires.** This
   applies on both the exact-rows path and the nearest-centre path:
   - `lobes >= 2`; or
   - its width or height is more than 1.6× the median of the other pieces
     in its row (rows from `rowsOf`; skipped for a row of one).
   - The merge rule is unchanged.
   - `CellResult` gains `why?: 'lobes' | 'size'` so the judge can be told.
   - The report's "Exact" column keeps its meaning: the layout came out as
     asked. In `sheetLoop.ts` (around :260), compute it from
     `!(c.suspect && !c.why)`, so a neighbour flag doesn't make a sheet
     inexact.
4. **The judge is told what to look for.**
   - A suspect piece already goes to the judge when the model can see.
   - Add an optional `hint: string` to `maybeJudge` and `JudgeDeps.judge`,
     appended to the judge prompt.
   - When `why` is set, the sheet loop passes "This cut may include a second
     object drawn touching the subject — fail it if anything besides
     <subject> is attached."
5. **Without vision,** a suspect piece flagged by lobes or size is still
   written. Its outcome carries the degradation "may be joined to a
   neighbour", so `REPORT-assets.md` lists it under its degraded column and
   the review dialog has it to hand.

## Build gate

The overview's gate.

## Test plan

- **Rust:**
  - a square with a smaller square joined by a 2 px bridge gives
    `lobes == 2`;
  - a plain square gives 1;
  - an L-shape with a 6 px-wide arm gives 1;
  - the existing Ming fixtures keep their piece counts;
  - every piece in `ming_sheet_items.png` has `lobes == 1` (if one doesn't,
    record which and tune the 4% or the kernel, not the test);
  - the merged column in `ming_sheet_topdown_touching.png` has
    `lobes >= 2`.
- **TS, `assignCells`:**
  - an exact-rows sheet where one piece has `lobes: 2` gives that cell
    `suspect: true, why: 'lobes'`;
  - a piece 2× wider than its row-mates gives `why: 'size'`;
  - a uniform sheet gives no suspects.
- **TS, sheet loop:**
  - with vision, a `why` cell's judge prompt contains the sentence;
  - without vision, the outcome carries the degradation.
- **Manual:** re-cut the p25 chain's original player sheet, if it is still
  in `.history`, or a hand-made sheet with a touching coin. The player cell
  is suspect and the judge rejects it.

## Commit

`feat(assets): flag a sheet cut that has a neighbour stuck to it, and ask the judge`

## Rollback

Revert the commit and re-export the IPC types.
