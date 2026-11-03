# 3D asset jobs — Project Overview

## Problem

The Code tab's agent can now build 3D models. It writes a build module
(`build(THREE, kit)`), and `check_3d` exports the GLB, checks it, renders a
six-view sheet, and with `clip` a motion sheet (plan/code-helpers/,
plan/motion-checks/). But it does this one asset at a time, in a session the
user drives. The Jobs tab has a 2D asset job, and guided planning can chain a
2D asset run ahead of the coding run. Nothing does the same for 3D models, so
a planned 3D game gets its code but no models.

Tim's tests also show that no single model is best at both halves of the job.
A frontier model (Argon 4) builds better models than the local ones, but it
animated worse. Making and animating are different skills, so a 3D run has to
be able to give each half to a different model.

## Goals

- A new job type, **3D models**, in the Jobs tab, beside the 2D asset job.
- It reads a spec file, **`models.json`**. Each entry gives an id, a
  description, a size in metres, the named parts it must have, and the clips it
  needs (name, length, whether it loops, what happens). With no spec file, the
  run first writes one from the job's description, using the job's own model.
- A run has two stages, in this order:
  1. **Creation**: build every model in the spec. For each one the creation
     model writes `assets/generated/model/<id>/<id>.js` and checks it with
     `check_3d` until the checks are clean. Every model that needs clips is
     built as a hierarchy of rigid parts under named pivots at its joints
     (for example `Hip_L > Thigh_L > Shin_L`).
  2. **Animation**: for every model with clips, the animation model writes
     `assets/generated/model/<id>/<id>.anim.js`. It takes the built object and
     returns the clips by rotating and moving the pivots. It checks each clip
     with `check_3d`'s `clip` argument. It never edits `<id>.js`.
- The final `assets/generated/model/<id>/<id>.glb` holds the model and its
  clips.
- The job has two model fields, **Creation model** and **Animation model**.
  Both use the picker that guided planning's chained stages use. The job's own
  model only writes the spec when there is no spec.
- An editor warning, one line, appears next to a model field when that model
  has no vision. The run still works from `check_3d`'s text report.
- An asset is done when `check_3d` reports no errors and its size is within
  10% of the spec. The same rule applies to each clip and the clip checks.
  Each asset and each clip set has a turn budget. When the budget runs out,
  the run keeps the last GLB, marks the asset "needs work" with its open
  problems, and goes on to the next one.
- Two run modes. **Attended**: after creation, a review screen shows each
  model's render sheet. The user accepts it, or rejects it with a note. A
  rejected model is built again with that note before animation starts.
  **Unattended**: no stops.
- An **Allow textures** checkbox, off by default. When it is on, the creation
  model also gets the code-drawn texture tool (`make_asset` textures) and may
  map those PNGs onto its materials. When it is off, models use materials,
  vertex colours and the kit's noise only.
- Guided planning gets a **Generate 3D models** switch beside Generate assets.
  When it is on, a stage writes `models.json` from the finished plan in every
  run mode except Overview only, which has no plan:
  - In **Unattended plan + code**, it chains the 3D run before the coding run
    (after the 2D asset run when that is on too).
  - In every other mode, it creates the 3D job, not started, for the user to
    run.
- Guided planning's chain models gain **3D creation** and **3D animation**
  overrides. These are passed to the 3D job it creates.
- A guide page for the job, and updates to the `jobs` and guided-planning
  pages.

## Non-goals

- No GLB specialist path in the job. It uses build modules and `check_3d` only.
- No skinned meshes or bones. Rigs are rigid parts under pivots.
- No images from the 2D asset job (sprites, icons) on models. Only code-drawn
  textures, and only when Allow textures is on.
- No editing models made outside the job (Blender, downloads). `check_3d` can
  still check them in the Code tab.
- No per-asset mix of creation then animation. All creation happens first,
  then all animation.
- No review stop after animation. The run report shows each clip's motion
  sheet afterwards.
- No scheduling. A run with Attended mode needs the user, and an unattended
  one is started by hand or by a chain.
- No new 3D checks. The job uses `check_3d` as it is.

## Users & primary flow

The user is a developer who plans a small 3D game with guided planning.

1. In a guided-planning job, the user turns on **Generate 3D models**. Under
   the chain models, they set 3D creation to Argon 4 and 3D animation to the
   local job model. They choose Unattended plan + code.
2. The planning run ends with a stage that reads the plan and writes
   `plan/<slug>/models.json`, for example a player, an enemy, a crate and a
   tree, with Idle, Walk and Attack clips on the two characters.
3. The handoff creates a 3D models job with those two models. It starts the
   job, and the coding run is chained after it.
4. The creation stage builds each model, `check_3d` by `check_3d`, until each
   one is clean or out of budget.
5. The animation stage writes the clips for the player and the enemy, and
   checks each clip on its motion sheet.
6. The run exports each final GLB, writes a report that lists each asset as
   done or needs work, and starts the coding run. The coding run builds the
   game against models that already exist.

A standalone flow is the same from step 4. The user creates a 3D models job
in the Jobs tab with a description or a spec path, picks the two models, and
runs it. In Attended mode, the run stops after step 4 for a review.

## Constraints

- Tauri 2 + SvelteKit 5 (runes), TypeScript, Rust (4-space, 100 col). Prettier
  uses tabs and single quotes. `#lib/...` imports have extensions.
- A job type is a module under `src/lib/agent/jobs/types/<id>/` that registers
  a `JobTypeDefinition` (`types/types.ts`, barrel `types/index.ts`).
- Model overrides use `ChainModel` / `stageModelColumns` from
  `agent/jobs/chainModel.ts`, whole and never merged field by field.
- Each job turn runs through `JobRunContext.runJobTurn`. A stage on another
  model needs its own backend for that turn.
- `check_3d` and its kit (`src/lib/helpers/three/`, `src/lib/glb/`) run in the
  app's webview. The job must call them the same way the Code tab does.
- Model generations are slow. The run must show progress per asset and honour
  cancel.
- UI copy has one short sentence per section, details go in tooltips, and
  Settings paths are written in full.
- A change users can see updates `docs/guide/` in the same PR. Pages stay
  under 6 KB.
- A changed Tauri command or `#[ts(export)]` struct needs
  `./scripts/export-ipc-types.sh`.

## Success criteria

- A 3D models job created from a description alone writes `models.json`,
  builds every entry, animates the ones with clips, and leaves a `.js`, an
  `.anim.js` (when clips are wanted) and a `.glb` in each
  `assets/generated/model/<id>/`.
- Each finished GLB loads in `check_3d` with no errors, and has every clip the
  spec names.
- `<id>.js` is byte-for-byte the same before and after the animation stage.
- With creation and animation on different models, the Create step names the
  creation model and the Animate step names the animation model, and each
  stage's turns go to its own server.
- In Attended mode the run stops after creation. A rejected model is rebuilt
  with the note before animation starts.
- An asset that runs out of budget is marked needs work in the report, and the
  run goes on.
- With Allow textures off, the creation model is never offered the texture
  tool. With it on, at least one live model uses a code-drawn texture.
- Guided planning with Generate 3D models on writes `models.json` in every
  mode but Overview only. In Unattended plan + code it chains plan → (2D) → 3D → coding. In the
  other modes it creates the 3D job unstarted.
- The live run: a small 3D game plan (4 models, 2 animated) with Argon 4
  creating and ThinkingCap-3.8-27B animating ends with every model done or
  honestly marked needs work, and the coding run starts. A second run with
  Argon 4 doing both is compared on the motion sheets. The result is recorded
  in the PR.
- Unit tests cover config parsing, the spec, stage model selection, the done
  rule and the handoff. `npm run check`, `npm run lint`, `npm run test`,
  `cargo test` and `cargo clippy` pass.
- The guide has a page for 3D models jobs, and `jobs` and the guided-planning
  page point to it.

## Decisions

- **How does the job's agent make each asset?** → A build module checked with
  `check_3d`, looped until clean.
- **How does animation relate to creation's output?** → A separate
  `<id>.anim.js` that takes the built object and returns clips. The animator
  never edits the build module.
- **What does creation hand the animator?** → A named hierarchy of rigid parts
  under pivots at the joints. No skinned meshes.
- **What tells the job what to make?** → A `models.json` spec. Guided planning
  writes it, or the job writes it from a description.
- **How does a job choose its models?** → Two explicit fields, Creation model
  and Animation model. The job's own model only writes the spec.
- **In what order does a run work?** → All creation first, then all animation.
- **Where does the user step in?** → Attended mode stops once, after creation,
  for a review with accept or reject-with-note. Unattended never stops.
- **How does guided planning turn it on?** → Its own Generate 3D models
  switch, beside Generate assets.
- **In which run modes does the switch act?** → Every mode (Overview only has
  no plan, so it writes nothing). Unattended plan +
  code chains the run. The other modes create the job unstarted.
- **How are models coloured and textured?** → Materials, vertex colours and kit
  noise. An Allow textures checkbox, off by default, gives the creation model
  the code-drawn texture tool.
- **Where do the files go?** → `assets/generated/model/<id>/` with `<id>.js`,
  `<id>.anim.js` and `<id>.glb`.
- **When is an asset done?** → `check_3d` reports no errors and the size is
  within 10% of the spec. Each asset has a turn budget. Out of budget, it is
  marked needs work and the run goes on.
- **What if a model has no vision?** → Allowed, with a one-line warning in the
  editor.
- **What live run proves it?** → A guided plan into a 3D run, with Argon 4
  creating and ThinkingCap-3.8-27B animating, compared with Argon 4 doing both.

### Implementation decisions

Tim asked for the rest of the plan to be settled without him (2026-11-03), with
one commit per phase and one PR at the end. These were decided from the code:

- **How does `<id>.anim.js` reach `<id>.js`'s object?** → `check_3d` gains an
  `anim` argument. A module cannot import a sibling file (it runs as a `blob:`
  URL), so the runner imports both and calls `animate(THREE, object, kit)`.
- **How does a build module use a PNG?** → `kit.texture('<literal path>')`. The
  tool reads the PNGs named in the source before the sandboxed page starts.
- **How does Allow textures offer only textures?** → A job-only `draw_texture`
  tool over `make_asset`'s texture branch.
- **How does the pipeline decide "done"?** → In code, with a new
  `judgeModel()` sharing `check_3d`'s loader, never by parsing the tool's text.
- **How do two models run in one job?** → `runJobTurn` takes a per-turn
  `model`. Each stage's step description names the model it ran on.
- **Where does the spec live?** → `assets/haruspex-models.json` by default;
  guided planning writes `plan/<slug>/models.json`.
- **How does the attended review take a note?** → The question modal's free
  text: Keep, Skip it, or type a note to rebuild.
- **What stops the animator editing `<id>.js`?** → Its hash is checked after
  each turn; a changed file is restored and reported as a problem.
- **How are 2D and 3D chained together?** → The 2D job gains
  `chain_next_job_id`; guided planning creates the 3D job first, and the 2D
  run starts it. The 3D run starts coding through a shared `handoffToCoding`.
- **What does the coding run learn?** → `models_spec_path` and
  `missing_models` in its config, named in the preflight prompt.
- **Allow textures in jobs guided planning creates** → Off, the job's default;
  the user turns it on in the 3D job.
- **Job type id** → `model_generation`, labelled "3D models".
