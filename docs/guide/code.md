---
title: Code tab
description: Coding sessions in a project folder — sessions, diffs and command cards, opening files, commands that need a terminal (sudo), steering, background processes, model and effort.
---

# Code tab

The Code tab is a coding agent that works in one project folder. It reads and edits files and runs commands there, and shows each edit as a diff and each command as a card. It is on Linux and macOS; on Windows the tab is hidden for now.

## Start a session

Click **New session** (or **+** next to the open sessions) and pick the project folder. The dialog starts from the last folder you used. The folder is fixed for the life of the session: the agent can't read or write outside it.

Type what you want and press `Enter`. After the first reply the session's model names it in a few words (until then it shows as `<folder> · new session`); a name you gave it is never replaced. Each session is saved after every reply, so closing the app, or a crash, loses nothing that was finished.

## Find and reopen sessions

The list on the left holds every saved session, newest first, each with its folder and when it was last active underneath. Two or more sessions in one folder sit under a row for the folder; click it to fold them away. Click a session to open it as a tab above the conversation. Right-click a session to **Rename** or **Delete** it; deleting removes the conversation, not any files. Closing a tab (**×**) keeps the session in the list. The **‹** button hides the list.

Long sessions show their last 20 turns; **Show earlier** brings back older ones.

## Read what the agent did

- **Edits** show as a diff: removed lines in red, added lines in green, with line numbers. A new file shows as all added. Diffs past 40 lines show **Show all … lines**. Unlike in Chat, rewriting an existing file doesn't ask first: the diff shows what changed.
- **Commands** show as a card with the command, its exit code, how long it took and its output. Long output shows its last 20 lines until you click **Show all**. **Copy** copies the command; **Open in Shell** types it into a new Shell tab at the folder without running it.
- Searches and file reads show as a short step list, as in Chat.
- **Reasoning** that led to a step sits above it, collapsed. While the agent thinks, it shows live as **Thinking…**.
- What the agent **says** before a step (its plan) sits above the step, under the reasoning.
- A call still being written shows as a row: **Writing**, **Editing** or **Preparing command…**.
- **File names** in diffs, reads, search results and answers (`src/app.ts:42`) inside the folder are links that open the file in the editor, at its top.

## Commands that need a terminal

Commands that ask for a password (`sudo`) or need a terminal can't run in the Code tab, so the agent hands them to you: a new Shell tab opens at the folder with the command typed in but not run. Check or change it, then press `Enter`.

The conversation shows **Waiting for you in Shell N — press Enter there**, with **Go to shell** and **Cancel**. When the command finishes, the agent gets its exit code, its output and the command as you ran it. **Cancel** stops the wait (the agent carries on without the result); **Stop** ends the turn; the Shell tab stays open either way. Closing the Shell tab first gives the agent no result. If the shell doesn't report finished commands (an old fish, say), the agent asks you instead.

The agent can also open files in the editor for you to look at. It doesn't wait for you, and it doesn't see your edits unless you tell it.

## Steer or stop the agent

While the agent works you can keep typing. `Enter` queues your message, shown as **Queued**, and the agent reads it at its next step (then it shows as **Delivered**). Click **×** on a queued message to drop it. **Stop**, or `Esc`, ends the turn; anything it never read comes back into the input box. `/` opens the commands and skills list, as in Chat.

A dot on a session's tab shows it is working (filled) or waiting for another turn to finish (hollow). Only one turn uses the model at a time; the others wait their turn.

## Pick the model and effort

The header above the conversation holds:

- the **folder** — click it to open it in your file manager;
- the **model** — the button names the session's model. Click it to pick **Settings model** (follows Settings → Inference), **Remote server** (a server saved in Settings → Inference: click **Probe** and pick a model) or **OpenRouter (cloud)** (click **Load models** and pick one), then **Save**. The local model is only reachable through **Settings model**, and picking a model here never starts it;
- **Effort** — how hard the model thinks, for models that publish effort levels;
- the **AGENTS.md** badge when the repo's instructions are in use (see the `skills` page), and how full the context is.

Changes apply from the next message. While the session is in view, the status badge at the top of the window names its model too.

## Background processes

For servers, watchers and long builds the agent starts the command in the background. **Running: N** in the header lists them: **Output** shows what each has printed, **Stop** ends it. Closing the session's tab stops its background processes, and asks first. So does quitting the app.

## Command approval and limits

Commands that look safe run on their own. A risky one (such as `sudo`, `rm -rf`, or a pipe to a shell) opens **Run this command?** first, and one that reaches outside the folder always asks. Settings → Code holds the command time limit, the step limit per task, the background log size and **Auto-approve commands**. See the `settings` page.

## What it doesn't do yet

- Each command runs on its own, so `cd` and environment changes don't carry over.
- No undo or checkpoints: use git.
- No forking a session or moving it to its own window.
- Small local models make mistakes and get stuck; see the `models` page.
