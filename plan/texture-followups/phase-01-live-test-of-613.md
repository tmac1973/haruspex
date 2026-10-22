# Phase 01 — Live test of #613

**Depends on:** nothing · **Enables:** phases 05 and 10 reuse its script; any
defect it finds is fixed before later phases build on `make_asset` textures.

**PR:** 1 of 3 ("texture fixes": phases 01–03).

## Goal

#613 changed how `make_asset` draws textures and what the job's judge sees,
but no model has used it yet. Drive a dev build through the Remote control
API with the model the dev app is set to, record what the model wrote and
what came out, and fix what breaks. The script is written once and kept,
because phases 05 and 10 run the same kind of check.

## Files touched

- `plan/texture-followups/live/run.mjs` — new. The Remote-control driver.
- `plan/texture-followups/live/cases-01.json` — new. This phase's prompts.
- `plan/texture-followups/live/phase-01/` — new. Tiles, previews and
  transcripts copied out of the run.
- `plan/texture-followups/live/phase-01/results.md` — new. One section per
  case: prompt, the recipe the model wrote, pass or fail, the defect if any.
- Source files named by any defect found. The fix lands in this phase,
  with a test that reproduces it.

## Steps

1. Make a worktree from `origin/main`. Symlink each entry of
   `/home/tim/Projects/haruspex/src-tauri/binaries/` into it, run
   `./scripts/link-sidecar-libs.sh`, and start `GDK_BACKEND=x11 npm run
   tauri dev` from it. Turn on Settings → Remote control.
2. Create a scratch project folder,
   `~/haruspex-live/textures-01/`, with an empty `tiles/` folder.
3. Write `run.mjs` (Node, no dependencies):
   - Reads a cases file: `[{ name, root, prompt, expect: [paths] }]`.
   - For each case: `POST https://localhost:8788/api/v1/op` with headers
     `X-Haruspex: 1` and `Origin: https://localhost:8788`, skipping cert
     verification (`NODE_TLS_REJECT_UNAUTHORIZED=0` set in-process).
     It calls `session.new {root}`, then `session.send {id, text}`, then
     `session.get {id}` every 5 s until the session is idle or 10 minutes
     pass.
   - Answers any pending prompt from `prompts.list` with its first option,
     through `prompts.answer`, so a run never blocks on a question.
   - Copies every `expect` path that exists, plus the session's final
     transcript (`session.get` JSON), into `live/<phase>/<case name>/`.
   - Prints one line per case: name, seconds, and which expected files
     exist.
4. Write `cases-01.json` with these cases, all in the scratch project:
   - `gravel-variants`: "Make a 32 px grey gravel floor tile with 4
     variants at tiles/gravel.png." Expect `tiles/gravel.png` and
     `tiles/gravel_1.png` to `tiles/gravel_3.png`.
   - `asphalt-no-markings`: "Make a 32 px asphalt road tile at
     tiles/road.png." Expect `tiles/road.png`. Check the recipe has no
     `stripes` layer.
   - `palette-from`: "Make a 32 px mossy stone floor at tiles/moss.png in
     the colours of tiles/gravel.png." Expect `tiles/moss.png`.
   - `revise-after-look`: "Make a 16 px brick wall at tiles/wall.png, look
     at it, and if anything repeats in every copy, fix it." Expect
     `tiles/wall.png`. Check whether the model called `make_asset` a second
     time with `overwrite: true`.
5. Run the four cases with an image backend set.
6. Stop the app. In `~/.local/share/com.haruspex.app/webview-store.json`,
   set `imageBackendKind` to `"none"` inside the `items["haruspex-settings"]`
   JSON string. Start the app, rerun `gravel-variants` as
   `gravel-no-backend`, then ask for "a 32 px coin sprite at
   tiles/coin.png" as `sprite-no-backend`. Expect the texture to be written,
   and the sprite refused with a message naming Settings → Image. Restore
   the setting afterwards.
7. Run one Asset generation job in the scratch project with *What to make*
   "a top-down village: grass, dirt path, cobbled square, wooden floor,
   pond water; a cottage and a well", Attended off. Copy the spec,
   report and every texture into `live/phase-01/job/`.
8. Look at each preview. Write `results.md`. For each defect: write a
   failing test, fix it in this phase, rerun the affected case and record
   the rerun.
9. Tick "Hand test #613" on #614 with a link to `results.md` once this
   phase's PR merges.

## Build gate

- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `cargo test`, `cargo clippy`, `cargo fmt -- --check` (from `src-tauri/`),
  if a fix touched Rust

## Test plan

- The four cases with a backend, and the two without, produce the
  expected files or refusals. Recorded in `results.md`.
- The job writes recipes for all five textures and draws them; the judge
  sees each laid 3×3 (visible in the run's step log as the judge turn's
  image).
- Each fix has a unit test that failed before it.

## Commit

`test(assets): live check of recipe textures in make_asset and the asset job`
(plus a `fix(assets): …` commit per defect found)

## Rollback

The script and results are plan files and can stay. Revert a fix commit on
its own if it regresses; each is independent.
