---
title: Jobs
description: The Jobs tab — saved prompts run by hand or on a schedule: research, audit, guided planning, autonomous coding and asset generation, plus per-job models.
---

# Jobs

The Jobs tab runs saved prompts without you watching, on a schedule or when you press Run. Each run streams live in its own view, stops at the first error, and stays in that job's run history. If you start several, they run one after another.

## Run a job by hand or on a schedule

Set **Schedule** in the job editor: Manual only, Every hour, Daily, Weekly, or Every N minutes/hours. Haruspex must be open for a schedule to fire; a run that comes due while the app is closed is dropped, not run later. While a job runs, Haruspex keeps your machine from going to sleep.

Guided planning, autonomous coding and asset generation can't be scheduled, because they stop to ask you things. They only run when you start them.

## Choose a working directory

Audit, guided planning, autonomous coding and asset generation need a **Working directory**: the model reads your code and writes its files there. Research jobs work with or without one; without one the model has no file tools.

## Give a job its own model

Under **Model**, a job uses the Settings model by default. It can instead use a **Remote server** (any OpenAI-compatible server: URL, model, optional API key, context size, vision) or **OpenRouter (cloud)**, where prompts leave your device. Use this to send a heavy audit or planning job to a bigger or faster model. A job on a remote model does not block the Chat or Shell tabs from using your local model at the same time.

These job types work much better with a bigger model. Audit, guided planning and autonomous coding read and write code, which is where the 4B and 9B models are weakest.

## See what a run spent

Each run's **Tokens** card shows what every step used and how close it came to filling the context window. A step that ran out of room says "trimmed N×". **Export JSON** saves the figures.

## The job types

**Research.** A list of steps run in order. Each step is a fresh conversation that gets the previous step's output, so you can chain "search, summarise, write a report". Each step can turn on **Deep research**.

**Audit.** Runs one prompt many times independently (1–20 runs), groups the findings, checks each group against the source, and writes one report sorted into confirmed, refuted and uncertain. Repeating the run cancels out the noise of any single run. Options: number of runs, max turns per run, **Read-only runs** (recommended), your own instructions, and an optional output file.

**Guided planning.** Turns a rough idea into an `overview.md` and phase files (`phase-NN-*.md`) in dependency order. It plans only and never writes code.

- It interviews you one question at a time and reads your codebase. Answer "proceed" to any question to move on.
- Stages: overview, outline, phase files, verification, approval.
- **Run mode**: *Attended* stops at three checkpoints (overview, outline, finished plan). *Unattended plan* skips only the final approval. *Unattended plan + code* starts an autonomous coding run when the plan is done. Nothing skips the interview.
- **Verification**: a separate reviewer reads the plan fresh for ordering, "TBD" decisions and unreachable steps. *Full* revises until clean (up to five rounds). *Lite* checks once, revises once and passes the rest to the coding run. *Skip* leaves it to you; it isn't offered with *Unattended plan + code*.
- **Web research** lets the planner search (via Settings → Search). **Use git** off drops the commit steps from the plan.
- **Also generate assets** (*Unattended plan + code* only, needs Settings → Image) writes an asset spec and runs asset generation before coding. You can give the asset and coding runs their own models.
- **Planning skill**: pick the kind of project. Haruspex ships `plan-2d-game`, `plan-3d-game`, `plan-web-app`, `plan-cli-tool` and `plan-api-service`. The interview adds that kind's questions, skipping ones your description already answers, and the reviewer checks the plan meets the skill's requirements. Edit them or add your own in Settings → Skills (see the `skills` page).

**Autonomous coding.** Takes a **Plan directory** (usually a guided planning output folder; hand-written plans work too). It first asks you about every open decision, or settles them itself with **Settle decisions without asking**. Then it codes unattended, one small step at a time, each checked and committed, with a deeper check at the end of each phase. A step that keeps failing is marked blocked and the run moves on. **Create a working branch for this run** (recommended) puts the work on its own git branch; **Use git** off makes no commits at all. It ends with `REPORT-coding.md` (what was built, what is blocked and why, next steps) and a project `README.md`.

**Asset generation.** Makes the images a project needs from a JSON asset spec: sprites and icons in sheets, tiling textures. If the spec doesn't exist, it writes one from your **What to make** description. It first makes a style anchor that every asset follows; *Attended* stops once to show you the anchor. It needs an image backend in Settings → Image; see the `images` page.
