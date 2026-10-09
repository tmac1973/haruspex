---
title: Code tab
description: Coding sessions in a project folder — starting one, diffs and command cards, editor windows, commands that need a terminal (sudo), steering, background processes, the git branch, model and effort.
---

# Code tab

The Code tab is a coding agent that works in one project folder: it reads and edits files and runs commands there. It is on Linux and macOS; on Windows the tab is hidden for now.

## Start a session

Click **New session** (or **+** next to the open sessions) and pick the project folder; the dialog starts from the last one you used. The folder is fixed for the session's life: the agent can't read or write outside it.

Type what you want and press `Enter`. After the first reply the model names the session (until then it is `<folder> · new session`); a name you gave it is never replaced. Each session is saved after every reply, so quitting or a crash loses nothing finished.

## Find, fork and move sessions

The list on the left holds every saved session. A session can be forked from any message, or moved to a window of its own and back; see the `code-sessions` page.

## Read what the agent did

- **Edits** show as a diff (removed lines red, added green, with line numbers); a new file is all added, and past 40 lines **Show all … lines** expands it. Unlike in Chat, rewriting a file doesn't ask first: the diff shows what changed.
- **Commands** show as a card: command, exit code, time taken and output (the last 20 lines until **Show all**). **Copy** copies the command; **Open in Shell** types it into a new Shell tab at the folder without running it.
- Searches and file reads show as a short step list, as in Chat.
- **Reasoning** sits above its step, collapsed (live as **Thinking…**), and what the agent **says** before a step sits under it.
- A call still being written shows as a row: **Writing**, **Editing** or **Preparing command…**.
- **File names** inside the folder, in diffs, reads, search results and answers (`src/app.ts:42`), open the file in an editor window, at its top.

## Commands that need a terminal

Commands that ask for a password (`sudo`) or need a terminal can't run here, so the agent hands them to you: a new Shell tab opens at the folder with the command typed in, not run. Check or change it, then press `Enter`.

The conversation shows **Waiting for you in Shell N — press Enter there**, with **Go to shell** and **Cancel**. When it finishes, the agent gets the exit code, the output and the command as you ran it. **Cancel** stops the wait (the agent carries on without the result); **Stop** ends the turn; either way the Shell tab stays. Closing the Shell tab first gives no result. If the shell doesn't report finished commands (an old fish, say), the agent asks you.

## Edit files

Files open in an editor window, one per folder with a tab per file; a file that has a tab already comes to the front. **⤢** on a tab moves the file to a window of its own. `Ctrl / ⌘ + S` saves; `Ctrl / ⌘ + W` closes the tab. The agent can open files there too, but doesn't see your edits unless you tell it.

When something else changes a file, the editor reloads it and keeps your place. With unsaved edits it shows **Changed on disk** (**Reload** / **Keep mine**), and saving over a change you haven't seen asks **Overwrite** or **Reload first**. A deleted file shows **Deleted on disk**; saving recreates it. Closing a window with unsaved edits asks first; closing the main window closes the editors too.

## Steer or stop the agent

While the agent works you can keep typing: `Enter` queues your message (**Queued**), and the agent reads it at its next step (**Delivered**). **×** drops a queued message. **Stop**, or `Esc`, ends the turn; anything unread comes back into the input box. `/` opens the commands and skills list, as in Chat.

A dot on a session's tab shows it working (filled) or waiting for another turn (hollow): only one turn uses the model at a time.

## Pick the model and effort

The header above the conversation holds:

- the **folder** — click it to open it in your file manager;
- the **git branch**, with **●** for uncommitted changes. Click it to switch branch or pick **New branch…**. Switching waits until the agent is idle and changes are committed or stashed; it warns when another open session uses the repository;
- the **model** — click it to pick **Settings model** (follows Settings → Inference), **Remote server** (one saved in Settings → Inference: **Probe**, then pick a model) or **OpenRouter (cloud)** (**Load models**, then pick one), then **Save**. The local model is only reachable through **Settings model**, and picking one here never starts it;
- **Effort** — how hard the model thinks, where the model offers levels;
- the **AGENTS.md** badge when the repo's instructions are in use (see the `skills` page), and how full the context is.

Model and effort apply from the next message; the status badge at the top names the model.

## Background processes

Servers, watchers and long builds run in the background. **Running: N** in the header lists them: **Output** shows what each printed, **Stop** ends it. Closing the session's tab (it asks first) or quitting the app stops them.

## Command approval and limits

Safe-looking commands run on their own. A risky one (`sudo`, `rm -rf`, a pipe to a shell) opens **Run this command?** first; one that reaches outside the folder always asks. Settings → Code holds the command time limit, the step limit per task, the background log size and **Auto-approve commands**. See the `settings` page.

## What it doesn't do yet

- Each command runs on its own, so `cd` and environment changes don't carry over.
- No undo or checkpoints: use git.
- Small local models make mistakes and get stuck; see the `models` page.
