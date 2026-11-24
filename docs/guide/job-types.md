---
title: Job types
description: What each kind of job in the Jobs tab does: digests, research, notebook refresh, audit, guided planning, autonomous coding, asset generation and 3D models, and their options.
---

# Job types

Pick a job's type in the job editor's **Job type** (see the `jobs` page for running and scheduling jobs).

**Digests.** Email and news digests are what two Home cards run (see the `home` page). A camera digest summarises camera logs, leading with entries camera alerts flagged, and can email the result (see the `camera-log` and `camera-alerts` pages).

**Refresh notebook.** On its schedule, does what you wrote ("update the prices in the Models table") to one notebook, with the notebook tools and web search, changing only what it names. Each card it changes says "From Jobs" and its History can undo it. **⋯ → Refresh on a schedule…** on a notebook starts one (see the `notebook-agents` page).

**Research by email.** Answers questions you email to yourself with a trigger phrase in the subject, using web tools only, and replies in the thread. It acts only on a request with a matching copy in your Sent folder. See the `email-research` page.

**Research.** A list of steps run in order, each a fresh conversation given the last step's output, with optional **Deep research**. Python runs without asking, in the run's own sandbox.

**Audit.** Runs one prompt many times independently (1–20), groups the findings, checks each group against the source, and writes one report sorted into confirmed, refuted and uncertain. Options: runs, max turns per run, **Read-only runs**, your own instructions, an output file.

**Guided planning.** Turns a rough idea into an `overview.md` and phase files (`phase-NN-*.md`) in dependency order. It never writes code.

- It interviews you one question at a time and reads your codebase. Answer "proceed" to any question to move on.
- **Overview only** stops once you approve `overview.md`, for a project that needs no phases.
- **Run mode**: _Attended_ stops at three checkpoints (overview, outline, finished plan). _Unattended plan_ skips only the final approval. _Unattended plan + code_ starts an autonomous coding run when the plan is done. Nothing skips the interview.
- **Verification**: a separate reviewer reads the plan fresh for ordering, "TBD" decisions and unreachable steps. _Full_ revises until clean (up to five rounds). _Lite_ checks once, revises once and passes the rest to the coding run. _Skip_ (not with _Unattended plan + code_) leaves it to you.
- **Web research** lets the planner search (via Settings → Search). **Use git** off drops the commit steps from the plan.
- **Also generate assets** (_Unattended plan + code_ only, needs Settings → Image) writes an asset spec and runs asset generation before coding. Under **Later stages**, **Change…** gives the asset or coding run its own model.
- **Also generate 3D models** writes `models.json` and makes a 3D models job; see the `3d-models` page.
- **Planning skill**: pick the kind of project. Haruspex ships `plan-2d-game`, `plan-3d-game`, `plan-web-app`, `plan-cli-tool` and `plan-api-service`. The interview and the reviewer follow that kind's requirements. Edit them or add your own in Settings → Skills.

**Autonomous coding.** Takes a **Plan directory**, such as a guided planning folder. It first asks you about every open decision, or settles them itself with **Settle decisions without asking**. Then it codes unattended, one plan phase at a time. At the end of each phase it runs the verification command settled in that interview and commits the phase. A phase that keeps failing gets a few repairs, then is committed marked unverified. **Create a working branch for this run** puts the work on its own git branch; **Use git** off makes no commits at all. It ends with `REPORT-coding.md` and a project `README.md`. Lookups can go to subtasks (see the `code-subtasks` page).

**Asset generation.** Makes the images a project needs from a JSON asset spec: sprites and icons in sheets, tiling textures. Without a spec, it writes one from **What to make**. Every asset follows a style anchor, which _Attended_ stops to show you. It needs an image backend in Settings → Image; see the `images` page.

**Video sequence.** Turns a brief into one long generated video: sections of chained clips, joins, music and narration, cut into a Shotcut or Kdenlive project and rendered. _Attended_ asks what the brief leaves open and stops to show the spec, the stills and each section's first clip; a stopped run has **Resume**. It is listed only when Settings → Video editing → **Let the assistant edit videos** is on and Settings → Video generation has a video model. See the `video-sequence` page.

**3D models.** Builds models from a `models.json` spec with `check_3d` and animates them, each half on a model you choose. See the `3d-models` page.
