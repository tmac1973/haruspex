# Phase 06 — Live test: Lantern, driven through Remote control

**Depends on:** 01, 02, 03, 04, 05 · **Enables:** release of the feature

## Goal

Show, on a real model, that subtasks work end to end and pay for themselves.
Claude drives Haruspex through Settings → Remote control's web page in the
built-in browser. It has the agent build a small game in a scratch repo, then
runs the same follow-up work twice, with subtasks and without, and compares
wall time and parent context. Results go in a GitHub issue. The repo gets no
code change unless the test finds bugs; those are fixed in their own PRs and
the affected step is re-run.

## Files touched

- `~/scratch/lantern/`, `~/scratch/lantern-sub/`, `~/scratch/lantern-base/`
  (outside the repo) — the scratch game and its two clones.
- A new GitHub issue — the results.
- No files in the repository, unless the test finds bugs; their fixes go in
  separate PRs.

## Steps

1. **Build.** On main with phases 01–05 merged, run `GDK_BACKEND=x11 npm run
   tauri dev`. In Settings → Inference, add or confirm the vLLM backend on
   compute:3000 (ThinkingCap-3.8-27B) and confirm it advertises 4 parallel
   slots. Set Settings → Code → Subtasks to Read and write.
2. **Remote control.** Turn on Settings → Remote control (port 8788) and open
   its page in the built-in browser pane. All later session work goes through
   that page.
3. **Scratch repo.** `mkdir -p ~/scratch/lantern && git -C ~/scratch/lantern
   init`. From the web page, start a Code session on `~/scratch/lantern` with
   the vLLM backend.
4. **Build the game.** Send one message asking for *Lantern*: a browser
   roguelike in TypeScript with Vite and Vitest. It needs a seeded dungeon
   generator (rooms and corridors on a grid), a turn loop, a player whose
   light radius shrinks by one every 10 turns, oil pickups that restore it,
   monsters that step toward the player when lit, arrow-key input, and a
   canvas renderer. Modules go under `src/`, each with tests. `npm test` must
   pass, and the agent commits the result. If the agent ends its turn with the game
   incomplete or `npm test` failing, send one follow-up naming what is
   missing, at most three times; record each. Subtasks may be used here; their counts are recorded but not
   compared.
5. **Clones.** `git clone ~/scratch/lantern ~/scratch/lantern-sub` and
   `git clone ~/scratch/lantern ~/scratch/lantern-base`, then `npm install` in
   each.
6. **Subtask run.** With Subtasks at Read and write, open a Code session on
   `lantern-sub` and send one message with all six asks:
   - review the turn loop for bugs;
   - list every magic number with file and line;
   - report which modules have no tests;
   - add a high-score table kept in `localStorage`;
   - add a second monster type that flees the light;
   - add sound effects (Web Audio beeps) behind a mute toggle.

   The message ends: "Run the high-score work in the background." Wait for
   the notification turn and the final answer.
7. **Baseline run.** Set Subtasks to Off. Open a Code session on
   `lantern-base` and send the same message without the background sentence.
   It runs only after step 6 has fully finished.
8. **Measure** for each run:
   - wall time from first message to final answer (including the notification
     turn in the subtask run);
   - peak parent prompt tokens (the session's usage readout);
   - parent model rounds;
   - number of subtasks by mode, and how many ran at the same time (from the
     cards' start and end times);
   - writing subtasks applied, conflicted, and with no changes;
   - `npm test` result in the folder afterwards;
   - whether all six asks were done, checked by reading the diff and answer.
9. **Pass** when the live-test success criteria in `overview.md` hold (the
   others — capacity-1 runs, call-order reports, stop behaviour, reload,
   build checks — are covered by phases 01–05's tests):
   - both runs finish with `npm test` passing and all six asks done;
   - the subtask run has lower wall time and lower peak parent prompt tokens;
   - at least one blocking batch ran children at the same time;
   - at least one writing child auto-applied;
   - the background child woke the session with a notification turn;
   - the web page showed collapsed cards throughout.
10. **Record.** `gh issue create` titled "Live test: Code tab subtasks
    (Lantern)". It holds the measurements as a table for both runs, the
    model, server and slot count, any steering, conflicts and how the parent
    handled them, and every bug found, as a checklist linking its fix PR.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test
```

Run on the merged main before step 1, so the live test exercises code that
passes the suite.

## Test plan

This phase is the test. Retry rules:

- **Infrastructure failure** (the server is down, a dev build crashes on
  start): fix the cause and restart the run from its step.
- **Haruspex bug:** file it in the results issue, fix it in its own PR, and
  re-run steps 5–8 on fresh clones.
- **Model quality** (an ask done badly): record it. It fails the run only when
  it stems from subtask mechanics, such as a lost report, a wrong worktree
  base or a bad apply.

## Commit

None. The results issue is the record.

## Rollback

Nothing to roll back in the repository. Delete `~/scratch/lantern*` when done.
Turn Settings → Remote control back off, and restore Settings → Code → Subtasks
to Read only.
