---
title: Jobs
description: The Jobs tab — saved prompts run by hand or on a schedule: research, audit, planning, coding, assets, 3D models and video sequences, plus per-job models and jobs drafted from a chat.
---

# Jobs

The Jobs tab runs saved prompts without you watching, on a schedule or when you press Run. Each run streams live, stops at the first error, and stays in the job's run history.

## Run a job by hand or on a schedule

Set **Schedule** in the job editor: Manual only, Every hour, Daily, Weekly, or Every N minutes/hours. Haruspex must be open for a schedule to fire; a run missed while it is closed runs once at the next launch. While a job runs or waits in the queue, Haruspex keeps your machine from going to sleep. Settings → General → **Keep the computer awake** picks which jobs do: All jobs, Not Home cards (the default, which leaves out Email digest, News digest, Research by email and Camera digest jobs), or Never. A sleeping machine doesn't wake for a scheduled job.

Guided planning, autonomous coding, asset generation and 3D models can't be scheduled, because they stop to ask you things.

In lean mode only research jobs run; the rest show as paused (see the `lean-mode` page).

## Run several jobs at once

Runs start side by side while their model has room (Settings → Inference → Parallel streams, or a server's slots), and a job on another model never waits. On a llama-toolchest server each model has its own slots; on other servers, models at one address share them. A job set up before this version picks up its model's slots when you open it and press **Probe**, then save. A run still waits for another run of its job, one in its working directory, or another type that asks you things. **1×** at the top of the job list runs one at a time, for benchmarks; so does lean mode. A run's view names the others under **Also running**.

## Find and organize jobs

Right-click a job in the list to **Run now**, **Duplicate** it (without its run history), **Archive** it or **Delete…** it; the editor has Delete and Duplicate too. A running job can't be deleted. A job another job's run started sits under it. **Filter jobs** matches names, descriptions and types. Deleting a job keeps the jobs it started. A job a Home card made has a **Home** badge (see the `home` page).

Archiving hides a job you're done with, and the jobs it started, without deleting its runs. **Archived** next to the filter shows them again, and right-click → **Unarchive** brings one back. Only a job with its schedule set to Manual can be archived, and giving an archived job a schedule unarchives it. A running job stays in the list even when it, or the job above it, is archived. Archiving doesn't stop a run or change the job.

## Turn a chat into a job

In Chat or the Code tab, ask the model to make a job from the conversation ("make that a planning job"). It drafts one and opens it in the Jobs tab, filled in and not saved: the type, a name, the working directory, the type's settings, and a brief of what the chat settled. Nothing runs until you save it and press Run. A newer draft replaces one you haven't touched; once you've edited a draft, you're asked before it's replaced.

The model can draft research, audit, guided planning, autonomous coding, asset generation, 3D models and video sequence jobs. A guided-planning job starts from the brief, so its interview asks only what the chat left open. An asset, 3D or video sequence job can carry a spec the chat wrote; Save writes it into the working directory, and stops if a different file is already at that path.

The model can't schedule a job or start one. It can't draft one in lean mode, from Shell, or from a Code session driven from another computer.

## Fill in the job editor

The editor opens one section at a time. An empty required field has an amber border and its section a badge ("1 required"); a refused Save turns them red and opens the first.

Every type but research and the digests needs a **Working directory**: the model reads your code and writes its files there. Without one, a research job's model has no file tools.

## Give a job its own model

Under **Model**, a job uses the Settings model by default. It can instead use a **Remote server** (any OpenAI-compatible server) or **OpenRouter (cloud)**, where prompts leave your device. While the job is selected, the status badge names its model.

Audit, guided planning and autonomous coding work much better with a bigger model (see the `models` page).

## See what a run spent

Each run's **Tokens** card shows what every step used and how full its context got. A step that ran out of room says "trimmed N×". **Export JSON** saves the figures.

## The job types

Digests, research, audit, guided planning, autonomous coding, asset generation and 3D models: see the `job-types` page for what each does and its options.
