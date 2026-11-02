---
title: Home
description: The Home tab — cards that show at a glance what Haruspex is doing: the job running now and recent runs, and Code sessions that are working or waiting on you. Adding, arranging and removing cards.
---

# Home

The Home tab is the first tab. It shows cards that tell you at a glance what Haruspex is doing, so you don't have to visit each tab to find out. Ctrl / ⌘ + 1 opens it; Chat moved to Ctrl / ⌘ + 2, and the other tab keys moved up one with it (see the `shortcuts` page).

Home isn't shown in Lean or Lean + files (see the `lean-mode` page).

## The cards you start with

A new Home has two cards. Both read what Haruspex is doing right now, so they need no setup and no model.

- **Jobs** — the job running now, with its step and progress (for example "Step 2 of 4 · 3/7"), how many runs are queued, and the five latest runs of any job. Click a run to open it in the Jobs tab. See the `jobs` page.
- **Code sessions** — Code sessions that are running, queued, waiting on a shell command, or waiting on you. **Needs attention** means the session is asking you something: a command to approve or a question to answer. Click a session to open it in the Code tab. Idle sessions aren't listed. Sessions in a Code window you detached aren't listed either; look in that window. See the `code-sessions` page.

## Add, arrange and remove cards

- **Add card**, top right, adds a card at the end. A card you removed can be added back from here.
- Each card's **⋯** menu has **Move up**, **Move down**, **Wide** (the card spans two columns) or **Normal width**, and **Remove**.

On a narrow window the cards stack in one column.

Your cards and their order are saved and kept across restarts. Removing every card leaves Home empty; the starting cards aren't added again.

## Unknown card

A card made by a newer version of Haruspex shows as **Unknown card** in an older one. It can only be removed.
