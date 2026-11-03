# Phase 13 — Guide pass and live run

**Depends on:** 01–12 · **Enables:** the PR

## Goal
Make the guide match what shipped, then prove the feature end to end on real
models: a small 3D game plan chained into a 3D run with Argon 4 creating and
ThinkingCap-3.8-27B animating, compared with Argon 4 doing both.

## Files touched
- `docs/guide/3d-models.md`, `docs/guide/jobs.md`, `docs/guide/helpers.md` — final read against the code; each under 6 KB.
- `plan/3d-asset-jobs/live-run.md` (new) — results.

## Steps
1. Read each guide page against the code. Settings paths in full. Run `node scripts/guide-check.mjs` and the guide size test.
2. Live run (per memory: drive a dev build through the Remote control API on 8788, from a worktree build; settings via `webview-store.json`):
   - Guided-planning job in a scratch folder: "A tiny 3D arena game: a knight player (Idle, Walk, Attack), a goblin enemy (Idle, Walk), a crate and a tree." Run mode Unattended plan + code, Generate 3D models on, 3D creation = Argon 4 through the remote endpoint Tim tested it on (read it from the dev build's `webview-store.json` inference list), 3D animation = ThinkingCap-3.8-27B on compute:3000, coding = the job model. Verification Lite.
   - Run B: the same models.json plus a fifth entry, "a wooden crate with plank texture", in a hand-made 3D models job with both models Argon 4 and Allow textures on.
3. Record per run: per model state, rounds used, problems; the step descriptions naming each stage's model; whether `<id>.js` hashes match before and after animation; whether the coding run started; whether run B's textured crate's report shows a `map` on its material. Compare the knight's and goblin's clip sheets between runs, one sentence per clip.
4. Pass: overview success criteria. Anything short is filed as one issue with a checklist (`gh issue create`), and the PR body links it.
5. If Argon 4 or the remote control build is not reachable from this session, do not fake it: record what was not run in `live-run.md` and file the run as a checklist item on #745 (Hand tests owed).

## Build gate
Full suite: `npm run check`, `npm run lint`, `npm run test`, `npm run format:check`, and in `src-tauri/`: `cargo test`, `cargo clippy`, `cargo fmt -- --check`.

## Test plan
The live run is the test; the full suite is the gate.

## Commit
`docs(guide): 3D models job; plan: live run results`

## Rollback
Docs and results only; revert freely.
