---
title: Home
description: The Home tab — cards showing what Haruspex is doing: running and recent jobs, Code sessions that need you, and pinned jobs' latest results. Adding, arranging and removing cards.
---

# Home

The Home tab is the first tab. It shows cards that tell you at a glance what Haruspex is doing, so you don't have to visit each tab to find out. Ctrl / ⌘ + 1 opens it; Chat moved to Ctrl / ⌘ + 2, and the other tab keys moved up one with it (see the `shortcuts` page).

Home isn't shown in Lean or Lean + files (see the `lean-mode` page).

## The cards you start with

A new Home has two cards. Both read what Haruspex is doing right now, so they need no setup and no model.

- **Jobs** — the job running now, with its step and progress (for example "Step 2 of 4 · 3/7"), how many runs are queued, and the five latest runs of any job. Click a run to open it in the Jobs tab. See the `jobs` page.
- **Code sessions** — Code sessions that are running, queued, waiting on a shell command, or waiting on you. **Needs attention** means the session is asking you something: a command to approve or a question to answer. Click a session to open it in the Code tab. Idle sessions aren't listed. Sessions in a Code window you detached aren't listed either; look in that window. See the `code-sessions` page.

## Pin a job

**Add card → Pinned job…** asks which job, then shows a card with that job's latest result: the last step's output from its newest successful run. Long output is cut short, with **Show more**. If the newest run failed, its error shows above the result. While the job runs, the card says so and names the step.

- **Run now** starts a run, the same as Run in the Jobs tab. It is greyed out while the job is running or queued.
- **Open** shows the job and its latest run in the Jobs tab.

The card updates when a run finishes, scheduled runs included. If you delete the job in the Jobs tab, the card says so and can only be removed.

## Add, arrange and remove cards

- **Add card**, top right, adds a card at the end. A card you removed can be added back from here.
- Each card's **⋯** menu has **Move up**, **Move down**, **Wide** (the card spans two columns) or **Normal width**, **Edit job** for a card with a job (it opens the job in the Jobs tab, where you change its schedule), and **Remove**. Removing a pinned job's card asks first; the job stays in the Jobs tab unless you tick **Also delete the job**.

Cards that make their own job have a **Home** badge on it in the Jobs tab, and their job runs only when no chat or Code turn is using the model, so a card never makes you wait. Removing such a card deletes its job too unless you untick **Also delete the job**. Some of them can tell you when they find something: **⋯ → Notify on new items** sends a desktop notification naming what is new. It is off until you turn it on.

On a narrow window the cards stack in one column.

Your cards and their order are saved and kept across restarts. Removing every card leaves Home empty; the starting cards aren't added again.

## Unknown card

A card made by a newer version of Haruspex shows as **Unknown card** in an older one. It can only be removed.
