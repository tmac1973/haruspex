---
title: Code sessions
description: Code tab sessions — the list, long sessions, worktree sessions, forks, sessions sharing a folder, a missing folder, and moving a session to its own window and back.
---

# Code sessions

How to find, fork and move sessions in the Code tab. For what a session does, see the `code` page.

## Find and reopen sessions

The list on the left holds every saved session, newest first, with its folder and last activity. Sessions sharing a folder sit under a folder row; click it to fold them. Click a session to open it as a tab. Right-click a session to **Rename** or **Delete** it; deleting removes the conversation, not files (but see worktrees below). Closing a tab (**×**) keeps the session in the list. The **‹** button hides the list. Tabs that don't fit scroll sideways, also by mouse wheel; **←** **→** move between them.

Long sessions show their last 20 turns; **Show earlier** loads more.

## When a session gets long

Once a session fills about three quarters of the model's context, Haruspex summarises its older turns before the next one. `/compact` does it now. The conversation you see stays whole; **Earlier turns summarised** marks the cut and opens the summary. File contents aren't kept, so the agent reads files again.

## Start a session in its own worktree

In a git repository, **New session** offers **Work in a new worktree** (remembered). The session works in a new folder, `<project>-worktrees/session`, on a new branch `session` (numbered when taken). It starts from the last commit, without uncommitted changes or ignored files (`node_modules`, `.env`); the agent is told to set things up before building.

## Fork a session from a message

Each of your messages and each answer has a **Fork from here** button (the branch icon, next to Copy; on your messages it shows when you point at the message). It asks where the fork works, then opens it as a tab:

- **New worktree** (in a git repository, the default): its own worktree, as above, in `<project>-worktrees/<name>` on a new branch named after the fork.
- **Same folder, read-only**: the fork shares the folder. Outside a git repository this is the only choice.

What the fork keeps:

- From an answer, the conversation up to and including that answer.
- From one of your messages, what came before; your message goes back in the input box to change and send again.

Background processes are not copied. You can't fork while the agent is working. In the list, a fork has a branch icon; point at it to see what it was forked from. Deleting the original leaves the fork.

Merging a branch back is ordinary git; there is no merge button.

## Read-only sessions

A **Read-only** badge in the header marks a fork that shares its folder. Its agent can read, search and look things up, but can't write or edit files, every command asks you first (even with Settings → Code → Auto-approve commands on), and nothing runs in the background. To make changes, fork into a new worktree.

## Sessions sharing a folder

Several sessions can work in one folder, in any window. Only one edits at a time: while one session's turn is writing files or running commands that may change them, another session's edits are refused and its agent is told to wait or use a worktree. Commands that only read (`ls`, `git status`, `grep`) don't count.

When a session's turn changes files, the other sessions in that folder are told at the start of their next turn which files changed and by which session, so they re-read them. The note also shows in their conversation. Changes made by commands are not tracked. In a git repository, the agent is also told when the checked-out branch changed since its last turn, whether from the branch menu, the Shell or another terminal. Both notes survive a restart: changes not yet told, and a branch switched while Haruspex was closed, are told on the next turn.

## When a session's folder is gone

If a session's folder was deleted, moved, or is on an unmounted drive, the session shows **Folder not found** with the path. You can still read it, but the input box is disabled and nothing runs. Haruspex checks when you open or switch to the session or its window comes to the front; if the folder goes mid-turn, the banner shows when the turn ends.

- **Choose folder…** points the session at another folder, after asking. The conversation stays, but paths in it still name the old folder.
- **Delete session** deletes it.

Haruspex never recreates the missing folder.

## Delete a worktree session

Deleting a session that has its own worktree offers **Also remove its worktree**. It is removed only when it has no uncommitted or untracked files; otherwise it is kept and you are told why. Its branch is always kept. When the last worktree goes, the empty `<project>-worktrees` folder goes with it.

## Move a session to its own window

**⤢** on a session's tab moves it to a window of its own; its background processes keep running. It only works while the session is idle; otherwise the button says why. Unsent text and images in the input box go with it, both ways.

The window shows that one session, without the list. Its header names the model; the status badge stays in the main window. `F2` and `F3` work there as in the main window.

- **⇤ Re-attach** puts it back as a tab in the main window and closes the window (also only when idle).
- Commands that need a terminal still open in a Shell tab in the main window, which comes to the front. **Go to shell**, **Cancel** and **Stop** work as in the tab.
- Forks and `/new` made there open as tabs in the main window.
- Closing the window is like closing the tab: it stops the agent and the background processes, asking first if any run. Closing the main window closes these windows too.

A session is open in one window at a time. In the list, a session with its own window shows **⧉**; clicking it brings that window to the front, and it can't be deleted until that window is closed.
