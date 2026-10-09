---
title: Code sessions
description: Code tab sessions — the session list, forking from a message into a git worktree or read-only, sessions sharing a folder, and moving a session to its own window and back.
---

# Code sessions

How to find, fork and move sessions in the Code tab. For what a session does, see the `code` page.

## Find and reopen sessions

The list on the left holds every saved session, newest first, with its folder and when it was last active. Two or more sessions in one folder sit under a folder row; click it to fold them. Click a session to open it as a tab above the conversation. Right-click a session to **Rename** or **Delete** it; deleting removes the conversation, not any files (but see worktrees below). Closing a tab (**×**) keeps the session in the list. The **‹** button hides the list.

Long sessions show their last 20 turns; **Show earlier** loads more.

## Fork a session from a message

Each of your messages and each answer has a **Fork from here** button (the branch icon, next to Copy; on your messages it shows when you point at the message). It asks where the fork works, then opens it as a tab:

- **New worktree** (in a git repository, the default): a new folder beside the project, `<project>-worktrees/<name>`, on a new branch named after the fork. The fork edits there freely. It starts from the last commit, so uncommitted changes and ignored files (`node_modules`, `.env`, build output) are not in it; the agent is told to set things up before building.
- **Same folder, read-only**: the fork shares the folder. Outside a git repository this is the only choice.

What the fork keeps:

- From an answer, the conversation up to and including that answer.
- From one of your messages, what came before; your message goes back in the input box to change and send again.

The original stays as it was. Background processes are not copied. You can't fork while the agent is working. In the list, a fork has a branch icon; point at it to see what it was forked from. Deleting the original leaves the fork.

Merging a fork's branch back is ordinary git; there is no merge button.

## Read-only sessions

A **Read-only** badge in the header marks a fork that shares its folder. Its agent can read, search and look things up, but can't write or edit files, every command asks you first (even with Settings → Code → Auto-approve commands on), and nothing runs in the background. To make changes, fork into a new worktree.

## Sessions sharing a folder

Several sessions can work in one folder, in any window. Only one edits at a time: while one session's turn is writing files or running commands that may change them, another session's edits are refused and its agent is told to wait or use a worktree. Commands that only read (`ls`, `git status`, `grep`) don't count.

When a session's turn changes files, the other sessions in that folder are told at the start of their next turn which files changed and by which session, so they re-read them. The note also shows in their conversation. Changes made by commands are not tracked. In a git repository, the agent is also told when the checked-out branch changed since its last turn, whether from the branch menu, the Shell or another terminal.

## Delete a worktree session

Deleting a session that has its own worktree offers **Also remove its worktree**. It is removed only when it has no uncommitted or untracked files; otherwise it is kept and you are told why. Its branch is always kept.

## Move a session to its own window

**⤢** on a session's tab moves it to a window of its own; its background processes keep running. It only works while the session is idle: while the agent works, waits for another turn or waits on a Shell tab, the button says why.

The window shows that one session, without the list. Its header names the model; the status badge stays in the main window. `F2` and `F3` work there as in the main window.

- **⇤ Re-attach** puts it back as a tab in the main window and closes the window (also only when idle).
- Commands that need a terminal still open in a Shell tab in the main window, which comes to the front. **Go to shell**, **Cancel** and **Stop** work as in the tab.
- Forks and `/new` made there open as tabs in the main window.
- Closing the window is like closing the tab: it stops the agent and the background processes, asking first if any run. Closing the main window closes these windows too.

A session is open in one window at a time. Clicking it in the list while it has a window brings that window to the front, and it can't be deleted until that window is closed.
