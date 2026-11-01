---
title: Code tab
description: Coding sessions in a project folder — starting one, diffs and command cards, editor windows, commands that need a terminal (sudo), steering, background processes, the git branch, model and effort.
---

# Code tab

The Code tab is a coding agent that works in one project folder: it reads and edits files and runs commands there. For Windows (a Windows folder or WSL), see the `code-windows` page.

## Start a session

Click **New session** (or **+** by the tabs) and pick the project folder; **Work in a new worktree** gives it its own branch (see the `code-sessions` page). **Open in Code** in a Shell tab's assistant starts one in its folder. The folder is fixed for the session: the agent can't read or write outside it.

Type what you want and press `Enter`. After the first reply the model names the session; a name you gave it is never replaced. Sessions save after every reply.

To show the agent a UI bug, the camera button takes the screen, a window or a region for your next message.

## Look things up on the web

The agent can search the web and read pages, with Chat's search and proxy setup; see the `search-and-network` page. To test your web app in a browser, see the `integrations` page.

## Read what the agent did

- **Edits** show as a diff with line numbers; past 40 lines **Show all … lines** expands it. Unlike Chat, rewrites don't ask first. A second whole rewrite in one turn needs a command (a test, say) run first.
- **Commands** show as a card: command, exit code, time taken and output (the last 20 lines until **Show all**). **Open in Shell** types it into a new Shell tab at the folder, not run.
- Searches and file reads show as a step list.
- **Reasoning** sits above its step, collapsed (live: **Thinking…**); what the agent **says** before a step sits above it in grey.
- A call still being written shows as a row: **Writing**, **Editing** or **Preparing command…**.
- **File names** inside the folder (`src/app.ts:42`), in diffs, reads, results and answers, open the file in an editor window, at its top.

## Commands that need a terminal

Commands that need a password (`sudo`) or a terminal can't run here, so the agent hands them to you: a new Shell tab opens at the folder with the command typed in, not run. Check it, then press `Enter`.

The conversation shows **Waiting for you in Shell N — press Enter there**, with **Go to shell** and **Cancel**. Then the agent gets the exit code, output and command as run. **Cancel** stops the wait (the agent goes on without it); **Stop** ends the turn; either way the Shell tab stays. Closing the Shell tab first gives no result. If the shell doesn't report finished commands (an old fish), the agent asks you.

## Edit files

Files open in an editor window, one per folder, a tab per file. **⤢** on a tab moves the file to its own window. For keys, see the `shortcuts` page. The agent can open files there but doesn't see your edits.

An outside edit reloads the file and keeps your place. With unsaved edits it shows **Changed on disk** (**Reload** / **Keep mine**), and saving over a change you haven't seen asks **Overwrite** or **Reload first**. A deleted file shows **Deleted on disk**; saving recreates it. **Live reload unavailable** means outside changes won't show. Closing a window with unsaved edits asks first; closing the main window closes the editors.

## Steer or stop the agent

While the agent works, `Enter` queues your message and its images (**Queued**); the agent reads them once its running tools finish (**Delivered**) and says what it will do. **×** drops a queued message. **Stop** (`Esc`) ends the turn, which the agent won't redo unasked; unread messages return to the input box. `/` opens the commands and skills list, as in Chat.

A dot on a session's tab shows it working (filled) or waiting for the model (hollow), which one turn uses at a time; a turn lets go of it while a tool runs over a few seconds or waits for you. **Stop** on a waiting session gives your message back.

## Pick the model and effort

The header above the conversation holds:

- the **folder** — click to open it in your file manager;
- the **git branch**, with **●** for uncommitted changes. Click it to switch branch, or to start one with **Branch from current…** or **Branch from main…** (shown when another branch is checked out). Switching waits until the agent is idle and changes are committed or stashed; it warns when another open session uses the repo;
- the **model** — click it to pick **Settings model** (follows Settings → Inference), **Remote server** (one saved in Settings → Inference: **Probe**, then pick a model) or **OpenRouter (cloud)** (**Load models**, then pick one), then **Save**. The local model is only reachable through **Settings model**; picking one never starts it;
- **Effort** — how hard the model thinks, where it has levels;
- the **AGENTS.md** badge when the repo's instructions are in use (see the `skills` page), and how full the context is.

Model and effort apply from the next message.

## Background processes

Servers, watchers and long builds run in the background. **Running: N** in the header lists them: **Output** shows what each printed, **Stop** ends it. Closing the tab (it asks first) or quitting stops them.

## Command approval and limits

Safe-looking commands run on their own. A risky one (`sudo`, `rm -rf`, a pipe to a shell) opens **Run this command?** first; one that reaches outside the folder always asks. Prompts from several sessions queue. **Allow for this session** lasts until its tab closes. Settings → Code holds the command time limit, the step limit, the background log size and **Auto-approve commands**. See the `settings` page.

## What it doesn't do yet

- Each command runs on its own, so `cd` and environment changes don't carry over.
- No undo or checkpoints; use git.
- Small local models make mistakes and get stuck; see the `models` page.
