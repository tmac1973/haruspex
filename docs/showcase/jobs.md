---
title: Jobs & automation
description: Saved prompts that run by hand or on a schedule: research, audits, planning a project, coding it, and making its assets.
---

## Run a research job on a schedule

A research job is a list of steps run in order, each given the last step's output. Set **Schedule** to Daily and it runs while Haruspex is open; a run missed while it was closed runs at the next launch.

Tab: Jobs
Required settings: None

Prompt:

> Search for new releases and security advisories for PostgreSQL, Redis and nginx from the last 24 hours. List each with its date and a link.

Example output:

Each run streams live and stays in the job's run history:

- PostgreSQL: … (link)
- Redis: no new releases
- nginx: …

Read more: jobs, job-types

## Audit your code for bugs

An audit runs one prompt several times independently, groups the findings, checks each against the source, and writes one report.

Tab: Jobs
Required settings: None (a working directory)

Prompt:

> Look for places where user input reaches a SQL query or a shell command without being checked.

Example output:

The report sorts the findings into confirmed, refuted and uncertain:

- **Confirmed**: `src/export.ts` builds a shell command from a file name …
- **Refuted**: `src/search.ts` looked unsafe, but the query is parameterised …

Read more: job-types, jobs

## Triage an audit's findings in a notebook

When an audit finishes, **📓 Save to notebook** at the top of the run puts its findings in a notebook as a table, with a Triage column to mark each one as you work through it. Set **Save findings to a notebook** to _One notebook, kept up to date_ and each run updates the same table, keeping what you've triaged.

Tab: Jobs
Required settings: None (a working directory)

Prompt:

> Find error paths that drop an error without logging it or telling the user.

Example output:

A **Findings** table, most severe first:

| Finding | Location | Severity | Runs | Triage |
|---|---|---|---|---|
| Upload failure is swallowed | `src/upload.ts:88` | high | 4 | Open |
| Retry loop hides the last error | `src/sync.ts:140-152` | medium | 2 | Open |

A summary card and a **Not verified** table sit beside it.

Read more: job-types, notebooks

## Turn an idea into a project plan

Guided planning interviews you one question at a time, reads your codebase, and writes an `overview.md` and phase files in dependency order. It never writes code.

Tab: Jobs
Required settings: None (a working directory)

Prompt:

> A small web app for our allotment group: members book shared tools and see who has what.

Example output:

First question: _Who signs in: every member with their own account, or one shared login for the group?_ Answer "proceed" to move on.

After the interview, the plan folder holds `overview.md` and `phase-01-…md`, `phase-02-…md` and so on. _Attended_ stops at the overview, the outline and the finished plan for your approval.

Read more: job-types, jobs

## Let a job code the plan for you

An autonomous coding job takes a plan folder, asks you about every open decision, then codes unattended one phase at a time. It runs the agreed check at the end of each phase and commits it.

Tab: Jobs
Required settings: None (a working directory and a plan directory, such as one guided planning wrote)

Prompt:

> plan/tool-booking/

Example output:

One commit per phase, on its own branch with **Create a working branch for this run**. A phase that keeps failing is committed marked unverified. The run ends with `REPORT-coding.md` and a project `README.md`.

Read more: job-types, code-subtasks

## Make the art for a game

An asset generation job makes the sprites, icons and tiling textures a project needs from a JSON spec, or writes the spec from what you describe. Every asset follows one style anchor, which _Attended_ shows you first.

Tab: Jobs
Required settings: Settings → Image generation → Add model

Prompt:

> Pixel-art sprites for a top-down farming game: a farmer walking in four directions, chickens, crops at three stages, and grass and dirt tiles.

Example output:

The job shows the style anchor for your approval, then makes each asset in that style: sprite sheets, icons and tiles. **Review assets** shows each one, and **Make again** with a note redoes it.

<!-- media: Review assets view with the farmer sprite sheet and the grass and dirt tiles -->

Read more: job-types, images, textures

## Make a job from a chat

Once a chat has settled what you want, ask for a job. The model drafts one and opens it in the Jobs tab, filled in and not saved; nothing runs until you save it and press Run.

Tab: Chat or Code
Required settings: None

Prompt:

> Make that a planning job.

Example output:

The Jobs tab opens a new guided planning job with a name, the working directory, its settings and a brief of what the chat settled. Its interview asks only what the chat left open.

Read more: jobs, job-types

## Pin a job's latest result to Home

A Pinned job card shows the output of a job's newest successful run, with **Run now** and **Open**.

Tab: Home
Required settings: None (Add card → Pinned job…, then pick the job)

Prompt:

> Add card → Pinned job… → Daily release watch

Example output:

The card shows the last step's output of the job's newest successful run. If the newest run failed, its error sits above.

Read more: home, jobs

## Keep a notebook's prices up to date

A Refresh notebook job re-runs one instruction against a notebook on a schedule, a row at a time, so you can see and undo each change.

Tab: Jobs
Required settings: None (a notebook)

Prompt:

> Check each speaker's current price at its retailer link and update the Price column in the Models table.

Example output:

Updated 2 of 3 prices in Speakers → Models:

- JBL Charge 5: $179.95 → $159.95
- UE Boom 3: unchanged
- Soundcore Motion+: $119.99 → $99.99

Read more: notebook-agents, job-types
