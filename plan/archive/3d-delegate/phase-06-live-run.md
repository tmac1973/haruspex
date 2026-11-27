# Phase 06 — Live run

**Depends on:** phases 01–05 · **Enables:** closing the work; a baseline for
tuning the delegate prompt.

## Goal

Prove the success criteria with real models: a local main model in a Code
session hands a static prop and an animated character to an OpenRouter frontier
model. Both end with clean final checks. The cost shows and the caps work. Record
the results so later prompt changes have a baseline. No code ships unless the run
finds a bug. A bug fix goes in its own PR, with a test.

## Files touched

- `plan/archive/3d-delegate/live-run.md` (new) — the record: models, prompts,
  rounds, cost, wall time, final-check result, notes on quality, screenshots
  of the sheets (paths under the scratch project).
- GitHub issue — a new issue for anything the run turns up, grouped as one
  checklist.

## Steps

1. Build `main` with phases 01–05 merged and run `GDK_BACKEND=x11 npm run tauri dev`.
2. Settings → Code → Helpers:
   - turn 3D on;
   - set **Delegate to** an OpenRouter model chosen for 3D (the one that did
     best in the 2026-11 rounds);
   - leave **Rounds per asset** at 80 and **Cost limit per asset** at
     **Unlimited**.
3. Make a scratch Godot project folder (`git init`). Open a Code session on it
   with the main model on compute:3000 (the current job model, 27B-class or
   better).
4. Ask for a static prop: "a wooden treasure chest, about 0.8 m wide, at
   `assets/chest.glb`". Record the rounds, the cost, the time and the final
   check.
5. Ask for an animated character: "a goblin, 1.1 m, with Idle and Walk clips,
   at `assets/goblin.glb`", in the background. Keep chatting with the main
   model while it runs. Record the same figures and confirm that the
   **Subtask finished** turn arrives.
6. Ask for a change: "make the goblin's ears longer". Confirm the delegate
   edits `assets/goblin.js` and that its anim module is kept.
7. Set **Cost limit per asset** to $0.05. Ask for another character. Confirm
   it stops at the limit, gives a report, and the card shows the cost.
8. Set the limit back to Unlimited and **Rounds per asset** to 5. Ask for one
   more prop and confirm the round cap stops it with a report.
9. Check the session total in the header against the OpenRouter activity page
   for these calls.
10. Write `live-run.md`. File one issue with a checklist for anything that
    went wrong or should be tuned.

## Build gate

The phase 05 build gate on the merged `main`, and every step in **Steps**
completed with its result recorded.

## Test plan

These are the steps above. Pass means:

- the chest and the goblin end with "Final check: clean";
- the change edits the module rather than replacing it;
- both caps stop the run with a report;
- the session total matches OpenRouter's figures within a cent per call.

## Commit

`docs(plan): 3D delegate live run results`

## Rollback

Nothing to roll back: this phase adds a record only. If the run fails, the
feature stays merged, and the issue it files tracks the fix.
