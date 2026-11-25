---
title: Code sessions
description: Code tab sessions — the list, long sessions, worktree sessions, forks, rewinding, sessions sharing a folder, a missing folder, and a window of its own.
---

# Code sessions

How to find, fork, rewind and move sessions in the Code tab. For what a session does, see the `code` page.

## Find and reopen sessions

The list on the left holds every saved session, newest first, with its folder and last activity; **Search sessions** keeps those whose title or folder has every word, and dragging its edge widens it. Sessions sharing a folder sit under a folder row; click it to fold. Click a session to open it as a tab. Right-click a session to **Rename** or **Delete** it; deleting keeps your files (but see worktrees below). Closing its tab (**×**) keeps it listed. The **‹** button hides the list. Extra tabs scroll sideways (mouse wheel too); **←** **→** move between them.

Long sessions show their last 20 turns; **Show earlier** loads more.

If Haruspex closes mid-turn, the session keeps your message and each finished step; send one to go on.

## When a session gets long

Once a session fills about three quarters of the model's context, Haruspex summarises older turns; `/compact` does it now. The conversation you see stays whole: **Earlier turns summarised** marks the cut and opens the summary, which lists the agent's changes.

## Start a session in its own worktree

In a git repository, **New session** offers **Work in a new worktree** (remembered). The session works in a new folder, `<project>-worktrees/session`, on a new branch `session` (numbered when taken). It starts from the last commit, without uncommitted changes or ignored files (`node_modules`, `.env`); the agent is told to set things up before building.

## Fork a session from a message

Each of your messages and answers has **Fork from here** (the branch icon; on your messages, point at the message). It asks where the fork works, then opens it as a tab:

- **New worktree** (in a git repository, the default): its own worktree, as above, on a new branch named after the fork.
- **Same folder, read-only**: the fork shares the folder. Outside a git repository this is the only choice.

What the fork keeps:

- From an answer, everything up to and including it.
- From one of your messages, what came before; your message goes back in the input box to change and send again.

Background processes are not copied. You can't fork while the agent is working. In the list, a fork has a branch icon; point at it to see what it was forked from. Deleting the original leaves the fork.

Merging back is ordinary git; there is no merge button.

## Rewind a session to a message

**Rewind to here** (the arrow icon) cuts the session back to that message, in place. Rewinding to an answer keeps it; rewinding to your message puts it back in the input box.

It offers to put back what the agent's write and edit tools changed since. A file changed after the agent wrote it (by you, another session or a command) is only overwritten if you tick it. Changes made by commands (a build, `git`) aren't tracked and stay, as do folders and files over 16 MB. You can't rewind while the agent works or in a read-only session.

## Read-only sessions

A **Read-only** badge in the header marks a fork that shares its folder. Its agent can read, search and look things up, but can't write or edit files, every command asks you first (even with Settings → Code → Auto-approve commands on), and nothing runs in the background. To make changes, fork into a new worktree.

## Sessions sharing a folder

Several sessions can work in one folder. Only one edits at a time: while one session's turn writes files or runs commands that may change them, another's edits are refused and its agent is told to wait or use a worktree. Commands that only read (`ls`, `git status`, `grep`) don't count.

When a session's turn changes files, the other sessions there are told at the start of their next turn which files changed and by whom, so they re-read them; the note shows in their conversation. Changes made by commands are not tracked. In a git repository, the agent is also told when the checked-out branch changed since its last turn, wherever it was switched. Both notes survive a restart.

## When a session's folder is gone

If a session's folder was deleted, moved or is on an unmounted drive, it shows **Folder not found** with the path. You can still read it, but nothing runs. Haruspex checks when you open or switch to the session, and as each turn ends.

- **Choose folder…** points the session at another folder, after asking. The conversation stays, but paths in it still name the old folder.
- **Delete session** deletes it.

Haruspex never recreates the missing folder.

## Delete a worktree session

Deleting a session that has its own worktree offers **Also remove its worktree**. It is removed only when it has no uncommitted or untracked files; otherwise it is kept and you're told why. Its branch is always kept.

## Move a session to its own window

**⤢** on a session's tab moves it to a window of its own; its background processes keep running. It works only while the session is idle; unsent text and images go with it, both ways.

The window shows that one session, without the list. `F2` and `F3` work there too.

- **⇤ Re-attach** puts it back as a tab in the main window and closes the window (also only when idle).
- Commands that need a terminal open in a Shell tab in the main window. **Go to shell**, **Cancel** and **Stop** work as in the tab.
- Forks and `/new` made there open as tabs in the main window.
- Closing the window is like closing the tab: it stops the agent and background processes, asking first if any run. Closing the main window closes it too.

A session is open in one window at a time. In the list, one with its own window shows **⧉**; click it to bring that window forward. It can't be deleted until that window closes.
