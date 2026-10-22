# Phase 10 — Live run of transitions, and closing #614

**Depends on:** phases 01 (the script), 05 (new layers), 07 (`make_asset`
transitions), 09 (the job's transitions) · **Enables:** closes #614.

**PR:** 3 of 3 ("transitions": phases 06–10). This phase's results and
fixes are the PR's last commits.

## Goal

Make a top-down set and a side-view set through both the asset job and
`make_asset`, against the model the dev app is set to. Lay each out as a
map, fix anything that breaks, and get Tim's approval of the result before
the PR merges.

## Files touched

- `plan/texture-followups/live/cases-10.json` — new.
- `src-tauri/src/image_gen/texture/transition.rs` — an `#[ignore]`d
  `live_map_from_sheet` test.
- `plan/texture-followups/live/phase-10/` — sheets, JSON maps, previews,
  transcripts and the job's report.
- `plan/texture-followups/live/phase-10/results.md` — new.
- `plan/futures.md` — drop "transition tiles where two materials meet"
  from "Code-drawn textures, next steps".
- Source files named by any defect found, each with a reproducing test.

## Steps

1. Start a dev build from the PR's branch in a worktree, as in phase 01,
   step 1.
2. `make_asset`, in a scratch project `~/haruspex-live/textures-10/`, with
   `cases-10.json` run by `run.mjs`:
   - `top-set`: "Make 32 px textures for short grass at tiles/grass.png
     and a dirt path at tiles/dirt.png, then the transition set between
     them at tiles/grass_dirt.png." Expect both textures, the sheet and
     `tiles/grass_dirt.json`. Check that the call passed `seed_from` and
     `seed_from_b`.
   - `side-set`: "For a side-view platformer, make a 32 px dirt texture at
     tiles/soil.png and a grass top at tiles/turf.png, then the platform
     set at tiles/platform.png with the grass on top." Expect the sheet
     and the JSON. Check `view: "side"` and a `cap`.
3. Asset job, in a scratch project `~/haruspex-live/textures-10-job/`:
   - Run A: *What to make* "a top-down farm: grass, tilled soil, a dirt
     path, a pond; a farmhouse, a fence, a scarecrow". Expect the spec
     to list top transitions for the pairs that meet (at least
     grass–path and grass–pond), each drawn, judged and in the report.
   - Run B: *What to make* "a side-view platformer: dirt ground with a
     grass top, stone ledges, a wooden bridge; a player, a slime, a coin".
     Expect a side transition for the dirt with a grass cap, and one for
     stone.
4. Add an `#[ignore]`d test `live_map_from_sheet` to `transition.rs`. It
   reads `LIVE_SHEET` (a sheet path), `LIVE_VIEW` (`top` or `side`) and,
   optionally, `LIVE_MATERIAL` (a material PNG). It:
   - builds the map with `transition_preview` (phase 06's layout constants
     for that view) and writes it as `<sheet>-map.png`;
   - when `LIVE_MATERIAL` is set, compares the sheet's tile 15 with it
     pixel for pixel, and prints `match` or `differs`.

   Run it once per set, and save the maps in `live/phase-10/`.
5. Write `results.md`: per case, what the model asked for, the edge it
   wrote, the judge's verdicts, and the map. Fix defects with tests, rerun
   the affected cases, and record the reruns.
6. Show Tim the maps (send the files) and ask for approval. Apply what he
   asks for and rerun before merging.
7. Edit `plan/futures.md`. After the PR merges, tick #614's remaining
   boxes with links to the results, and close it.

## Build gate

- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- From `src-tauri/`: `cargo test`, `cargo clippy`, `cargo fmt -- --check`
- `./scripts/export-ipc-types.sh` (no drift)

## Test plan

- Both `make_asset` cases write a sheet and a JSON map. For the top-down
  set, `live_map_from_sheet` prints `match` for tile 15 against
  `tiles/grass.png`; the result is recorded in `results.md`.
- Both job runs list, draw and report their sets, and the spec holds each
  set's edge.
- Every map in `live/phase-10/` shows no seam at tile borders and a
  natural border between materials. Tim approves them (step 6).

## Commit

`test(assets): live run of transition sets through make_asset and the asset job`
(plus a `fix(assets): …` per defect found)

## Rollback

The results are plan files. Revert any fix commit on its own. The
`live_map_from_sheet` test is ignored by default and harmless to keep.

## As built

- Driven by `scripts/drive.mjs` (as in phases 01 and 05), with no
  `cases-10.json`: four prompts, two through `make_asset` and two jobs.
  Results are in `live/phase-10/results.md`.
- One defect was found and fixed: a cap texture is now asked for as the
  surface itself. The other observations are listed in the results and
  left as they are.
