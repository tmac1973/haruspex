# 3D asset jobs — live run

**Status: NOT RUN.** Phase 13's live run needs a dev build of this branch
driven through the Remote control API, and Tim's approval in the app. On
2026-11-03 Tim was away: his running app served `main`, not this branch, and
creating a job through the Remote control API waits for an in-app Approve.
Nothing below was faked. The guide pass and the full suite were done (see the
end). Follow this checklist to run it, then fill in the result tables.

## Before you start

- [ ] Build this branch from its worktree, not the main checkout:
      `GDK_BACKEND=x11 npm run tauri dev` in
      `~/Projects/haruspex-plan-3d-asset-jobs` (sidecars symlinked from the
      main checkout; `./scripts/link-sidecar-libs.sh`).
- [ ] Turn on Settings → Remote control and note the port (8788).
- [ ] Check both models answer:
  - Argon 4: `google/gemini-4-argon`, on the remote endpoint already in the
    dev build's `webview-store.json` inference list.
  - ThinkingCap-3.8-27B on `http://compute:3000`.
- [ ] Make an empty scratch folder for each run, for example
      `~/scratch/arena-a` and `~/scratch/arena-b`, each a fresh `git init`.

## Run A — guided plan into a 3D run (Argon 4 creates, ThinkingCap animates)

- [ ] New **Guided planning** job, working directory `~/scratch/arena-a`.
- [ ] Description: "A tiny 3D arena game: a knight player (Idle, Walk,
      Attack), a goblin enemy (Idle, Walk), a crate and a tree."
- [ ] Planning skill `plan-3d-game`. **Run mode** _Unattended plan + code_.
      **Verification** _Lite_. **Also generate assets** off.
- [ ] **Also generate 3D models** on.
  - **3D creation**: Change… → Argon 4 (`google/gemini-4-argon`).
  - **3D animation**: Change… → ThinkingCap-3.8-27B on `http://compute:3000`.
  - **Coding run model**: Same as this job.
- [ ] Save, Run, answer the interview, approve the two checkpoints.
- [ ] When the 3D models stage finishes, copy
      `plan/<slug>/models.json` aside; run B needs it.
- [ ] Before the 3D run's Animate stage starts, hash every build module:
      `sha256sum assets/generated/model/*/*.js | grep -v anim`. Hash them
      again after the run.

## Run B — Argon 4 does both, with textures

- [ ] In `~/scratch/arena-b`, copy run A's `models.json` to
      `assets/haruspex-models.json` and add a fifth entry: "a wooden crate
      with plank texture" (id `plank_crate`, about 0.8 m, no parts, no clips).
- [ ] New **3D models** job, working directory `~/scratch/arena-b`.
      **Run mode** _Unattended_. **Creation model** and **Animation model**
      both Argon 4. **Allow textures** on. Limits at their defaults.
- [ ] Run it. Hash the build modules before and after animation as in run A.

## What to record

Per run, per model:

| Run | Model | State (done / needs work / skipped) | Rounds used | Problems left |
|---|---|---|---|---|
| A | knight | | | |
| A | goblin | | | |
| A | crate | | | |
| A | tree | | | |
| B | knight | | | |
| B | goblin | | | |
| B | crate | | | |
| B | tree | | | |
| B | plank_crate | | | |

Per run:

- [ ] The Create step's description names the creation model, and the
      Animate step's names the animation model (run A: two different models).
- [ ] Each stage's turns reached its own server (the debug log, or the
      server's own log on compute:3000).
- [ ] Every `<id>.js` hash is the same before and after animation.
- [ ] Every finished `<id>.glb` loads in `check_3d` with no errors and has
      every clip the spec names.
- [ ] Run A only: the coding run started, and its description names the
      models spec. Record the result line of the Hand off step.
- [ ] Run B only: `plank_crate` uses a code-drawn texture. The report does
      not list materials, so check the files: a PNG under
      `assets/generated/model/plank_crate/textures/`, a
      `kit.texture('textures/…png')` call in `plank_crate.js`, and an image in
      the GLB (`"images"` in its JSON chunk, e.g.
      `strings plank_crate.glb | grep -c '"images"'`).

Clip sheets, one sentence per clip, run A against run B:

| Clip | Run A (ThinkingCap animates) | Run B (Argon 4 animates) |
|---|---|---|
| knight Idle | | |
| knight Walk | | |
| knight Attack | | |
| goblin Idle | | |
| goblin Walk | | |

## Pass

The overview's success criteria: every model done or honestly marked needs
work, the coding run started, `<id>.js` unchanged by animation, each stage on
its own model, and a code-drawn texture used in run B. Anything short goes in
one issue with a checklist (`gh issue create`), linked from the PR body. If
the run still can't happen before the PR merges, add it as a checklist item
on #745 (Hand tests owed).

## Done without the live run

- Guide pages `3d-models`, `jobs` and `helpers` read against the code; each
  under the 6000-byte page limit.
- Full suite on 2026-11-03: see the PR body for the counts.
