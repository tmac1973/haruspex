---
title: Code tab
description: Coding sessions in a project folder — starting and reopening sessions, diffs and command cards, steering the agent, background processes, model and effort per session.
---

# Code tab

The Code tab is a coding agent that works in one project folder. It reads and edits files and runs commands there, and shows each edit as a diff and each command as a card. It is on Linux and macOS; on Windows the tab is hidden for now.

## Start a session

Click **New session** (or **+** next to the open sessions) and pick the project folder. The dialog starts from the last folder you used. The folder is fixed for the life of the session: the agent can't read or write outside it.

Type what you want and press `Enter`. The first message names the session. Each session is saved after every reply, so closing the app, or a crash, loses nothing that was finished.

## Find and reopen sessions

The list on the left holds every saved session, grouped by folder, newest first. Click one to open it as a tab above the conversation. Right-click a session to **Rename** or **Delete** it; deleting removes the conversation, not any files. Closing a tab (**×**) keeps the session in the list. The **‹** button hides the list.

Long sessions show their last 20 turns; **Show earlier** brings back older ones.

## Read what the agent did

- **Edits** show as a diff: removed lines in red, added lines in green, with line numbers. A new file shows as all added. Diffs past 40 lines show **Show all … lines**.
- **Commands** show as a card with the command, its exit code, how long it took and its output. Long output shows its last 20 lines until you click **Show all**. **Copy** copies the command.
- Searches and file reads show as a short step list, as in Chat.
- **Reasoning** that led to a step sits above it, collapsed. While the agent thinks, it shows live as **Thinking…**.
- A call still being written shows as a row: **Writing** with the file and its size so far, **Editing** with the file, or **Preparing command…** with the command once it arrives.

## Steer or stop the agent

While the agent works you can keep typing. `Enter` queues your message, shown as **Queued**, and the agent reads it at its next step (then it shows as **Delivered**). Click **×** on a queued message to drop it. **Stop**, or `Esc`, ends the turn; anything it never read comes back into the input box. `/` opens the commands and skills list, as in Chat.

A dot on a session's tab shows it is working (filled) or waiting for another turn to finish (hollow). Only one turn uses the model at a time; the others wait their turn.

## Pick the model and effort

The header above the conversation holds:

- the **folder** — click it to open it in your file manager;
- the **model** — the button names the session's model. Click it to pick **Settings model** (follows Settings → Inference, whatever it is set to), **Remote server** (a server saved in Settings → Inference: click **Probe** and pick a model) or **OpenRouter (cloud)** (click **Load models** and pick one), then **Save**. The local model is only reachable through **Settings model**, and picking a model here never starts it;
- **Effort** — how hard the model thinks, for models that publish effort levels;
- the **AGENTS.md** badge when the repo's instructions are in use (see the `skills` page), and how full the context is.

Changes apply from the next message.

## Background processes

For servers, watchers and long builds the agent starts the command in the background. **Running: N** in the header lists them: **Output** shows what each has printed, **Stop** ends it. Closing the session's tab stops its background processes, and asks first. So does quitting the app.

## Command approval and limits

Commands that look safe run on their own. A risky one (such as `sudo`, `rm -rf`, or a pipe to a shell) opens **Run this command?** first, and one that reaches outside the folder always asks. Settings → Code holds the command time limit, the step limit per task, the background log size and **Auto-approve commands**. See the `settings` page.

## What it doesn't do yet

- There is no terminal: each command runs on its own, so `cd` and environment changes don't carry over, and commands that ask for a password (`sudo`) fail. Run those yourself in the Shell tab.
- No undo or checkpoints: use git.
- No forking a session or moving it to its own window.
- Small local models make mistakes and get stuck; see the `models` page.
