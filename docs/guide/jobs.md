---
title: Jobs
description: The Jobs tab — saved prompts run by hand or on a schedule: research, audit, guided planning, autonomous coding, asset generation and 3D models, plus per-job models.
---

# Jobs

The Jobs tab runs saved prompts without you watching, on a schedule or when you press Run. Each run streams live, stops at the first error, and stays in the job's run history. Runs queue one after another.

## Run a job by hand or on a schedule

Set **Schedule** in the job editor: Manual only, Every hour, Daily, Weekly, or Every N minutes/hours. Haruspex must be open for a schedule to fire; a run missed while it is closed runs once at the next launch. While a job runs, Haruspex keeps your machine from going to sleep.

Guided planning, autonomous coding, asset generation and 3D models can't be scheduled, because they stop to ask you things.

In lean mode only research jobs run; the rest show as paused (see the `lean-mode` page).

## Find and organize jobs

A job started by another job's run sits under that job; its arrow shows them. **Filter jobs** matches names, descriptions and types. Drag the list's right edge to resize it. Deleting a job keeps the jobs it started. A job a Home card made has a **Home** badge (see the `home` page).

## Fill in the job editor

The editor opens one section at a time and folds the rest to a summary. An empty required field has an amber border, and its section a badge such as "1 required". If Save is refused they turn red, and the first section to fix opens.

Every type but research and the digests needs a **Working directory**: the model reads your code and writes its files there. Without one, a research job's model has no file tools.

## Give a job its own model

Under **Model**, a job uses the Settings model by default. It can instead use a **Remote server** (any OpenAI-compatible server) or **OpenRouter (cloud)**, where prompts leave your device. A job on a remote model leaves your local model free for Chat and Shell. While the job is selected, the status badge names its model.

Audit, guided planning and autonomous coding work much better with a bigger model (see the `models` page).

## See what a run spent

Each run's **Tokens** card shows what every step used and how full its context got. A step that ran out of room says "trimmed N×". **Export JSON** saves the figures.

## The job types

**Email and news digests.** What two Home cards run (see the `home` page).

**Research.** A list of steps run in order. Each step is a fresh conversation given the last step's output, to chain "search, summarise, write a report". Each step can turn on **Deep research**. Python runs without asking, in a sandbox of the run's own that sees none of your chats.

**Audit.** Runs one prompt many times independently (1–20), groups the findings, checks each group against the source, and writes one report sorted into confirmed, refuted and uncertain. Options: number of runs, max turns per run, **Read-only runs**, your own instructions, and an optional output file.

**Guided planning.** Turns a rough idea into an `overview.md` and phase files (`phase-NN-*.md`) in dependency order. It plans only and never writes code.

- It interviews you one question at a time and reads your codebase. Answer "proceed" to any question to move on.
- Stages: overview, outline, phase files, verification, approval.
- **Overview only** stops once you approve `overview.md`, for a project that needs no phases: open the folder in the Code tab and point the agent at the overview.
- **Run mode**: _Attended_ stops at three checkpoints (overview, outline, finished plan). _Unattended plan_ skips only the final approval. _Unattended plan + code_ starts an autonomous coding run when the plan is done. Nothing skips the interview.
- **Verification**: a separate reviewer reads the plan fresh for ordering, "TBD" decisions and unreachable steps. _Full_ revises until clean (up to five rounds). _Lite_ checks once, revises once and passes the rest to the coding run. _Skip_ leaves it to you; it isn't offered with _Unattended plan + code_.
- **Web research** lets the planner search (via Settings → Search). **Use git** off drops the commit steps from the plan.
- **Also generate assets** (_Unattended plan + code_ only, needs Settings → Image) writes an asset spec and runs asset generation before coding. Under **Later stages**, **Change…** gives the asset or coding run its own model.
- **Planning skill**: pick the kind of project. Haruspex ships `plan-2d-game`, `plan-3d-game`, `plan-web-app`, `plan-cli-tool` and `plan-api-service`. The interview adds that kind's questions and the reviewer checks the plan against the skill's requirements. Edit them or add your own in Settings → Skills (see the `skills` page).

**Autonomous coding.** Takes a **Plan directory**, such as a guided planning folder. It first asks you about every open decision, or settles them itself with **Settle decisions without asking**. Then it codes unattended, one plan phase at a time. At the end of each phase it runs the verification command settled in that interview and commits the phase. A phase that keeps failing gets a few repairs, then is committed marked unverified. **Create a working branch for this run** (recommended) puts the work on its own git branch; **Use git** off makes no commits at all. It ends with `REPORT-coding.md` and a project `README.md`. Lookups can go to subtasks (see the `code-subtasks` page).

**Asset generation.** Makes the images a project needs from a JSON asset spec: sprites and icons in sheets, tiling textures. If the spec doesn't exist, it writes one from your **What to make** description. It first makes a style anchor for every asset to follow; _Attended_ stops to show it to you. It needs an image backend in Settings → Image; see the `images` page.

**3D models.** Builds models from a `models.json` spec with `check_3d` and animates them, each half on a model you choose. See the `3d-models` page.
