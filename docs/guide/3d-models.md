---
title: 3D models jobs
description: The 3D models job — build models from a models.json spec with check_3d, animate them on a second model, attended review, textures, and where the files go.
---

# 3D models jobs

A **3D models** job in the Jobs tab builds the 3D models a project needs, then animates the ones that move. Each model is code: a build module that `check_3d` exports to a GLB, checks and renders, the same way the Code tab's agent makes one by hand. The job does every model in a list, one after another, and writes a report at the end.

## Tell it what to make

The job reads a spec, `models.json`, from **Models spec** (by default `assets/haruspex-models.json`). Each entry gives:

- an id and a title, and a description of how it looks;
- `height_m`, its height in metres, so the whole set shares one scale;
- `parts`, the named pivots at its joints (`Hip_L`, `Knee_L`, `Shoulder_R`), for a model that moves;
- `clips`, each with a name, a length in seconds, whether it loops, and what happens in it.

A static prop such as a crate or a tree has no parts and no clips. If the spec file doesn't exist, the run writes one from **What to make**, on the job's own model. A spec that exists is read as it is and never rewritten; if it has problems, the run stops and lists them.

Guided planning can write the spec for you: see "From guided planning" below.

## Choose the two models

Building a model and animating it are different skills, so the job has two model rows:

- **Creation model** builds every model.
- **Animation model** writes the clips for every model that has them.

Each row is **Same as this job** until you press **Change…** and pick another server and model. The job's own model (under **Model**) only writes the spec. A row whose model can't see images says so in one line. The run still works, because `check_3d` reports in text as well as pictures, but a model that can see its render sheets usually does better.

## How a run goes

1. **Spec**: read `models.json`, or write it.
2. **Create**: for each model, the creation model writes `<id>.js` and checks it with `check_3d` until the checks pass. A model with clips is built as rigid parts under the named pivots, nested parent to child (`Hip_L > Knee_L`).
3. **Animate**: for each model with clips, the animation model writes `<id>.anim.js`, which takes the built model and returns its clips. It checks each clip's motion sheet. It never changes `<id>.js`; if it does, the run puts the file back.
4. **Report**: `REPORT-models.md` beside the spec lists each model as done, needs work or skipped, with its render sheet, clip sheets and open problems.
5. **Hand off**: a job that a plan chained starts the coding run, and tells it which models were not built (and, after an asset run, which images were not made). A standalone job does nothing here. A chained job you start by hand hands off too, unless you clear **Start the coding run when done**.

A model is done when `check_3d` reports no errors and its height is within 10% of the spec. Clips are done when every clip the spec names is there and its motion check reports no errors. Each model and each clip set gets a few turns (**Limits → Turns per model**). Every check is kept as an attempt, and the best one stays: done first, then one that built, then the fewest problems. When the turns run out, the run marks the model needs work with the best attempt's problems and moves on.

## Attended or unattended

**Run mode** _Attended_ stops once, after creation, and shows each model's render sheet. Answer **Keep**, **Skip it**, or type a note to rebuild it with that note before animation starts. _Unattended_ never stops. A run that a plan chains is always unattended.

## Allow textures

Off by default: models are coloured with materials, vertex colours and the kit's noise. With **Allow textures** on, the creation model can also draw tiling textures in code and map them onto its materials with `kit.texture` (see the `textures` page). Images from the asset generation job are never used on models.

## From guided planning

Turn on **Also generate 3D models** in a guided planning job. After the asset stage, a **3D models** stage reads the finished plan and writes `plan/<slug>/models.json`, using the ids the plan already uses, and adds a "3D models" table to `overview.md`. **3D creation** and **3D animation** under the switch choose the new job's two models; each is **Same as this job** (the planning job) by default.

- In _Unattended plan + code_, the run starts the 3D models job, unattended, and it starts the coding run when it finishes. With **Also generate assets** on too, the order is plan, assets, 3D models, coding. If a run in the chain can't start, the next one starts instead.
- In every other mode, the run creates the 3D models job, _Attended_ and not started, for you to start from the Jobs tab.
- **Overview only** writes no `models.json`, since there is no plan to read.
- **Allow textures** is off in the job it makes; turn it on there.

## Where the files go

Every model gets its own folder, `assets/generated/model/<id>/`:

- `<id>.js` — the build module.
- `<id>.anim.js` — the clips, when the model has any.
- `<id>.glb` — the model with its clips, ready for the game to load.
- `sheet.png` and `clip-<name>.png` — the render and motion sheets.
- `attempts/create-NN/` and `attempts/animate-NN/` — every attempt's file, GLB, sheets and problems. The report names the one kept.

## What it doesn't do

- No skinned meshes or bones: rigs are rigid parts under pivots.
- No editing models made elsewhere, such as in Blender. Use `check_3d` in the Code tab for those.
- No schedule: start a run by hand, or let guided planning chain it.
- No review after animation; the report shows each clip's motion sheet instead.
