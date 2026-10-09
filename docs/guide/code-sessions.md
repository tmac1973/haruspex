---
title: Code sessions
description: Code tab sessions — the session list, forking a session from a message, and moving a session to its own window and back.
---

# Code sessions

How to find, fork and move sessions in the Code tab. For what a session does, see the `code` page.

## Find and reopen sessions

The list on the left holds every saved session, newest first, with its folder and when it was last active. Two or more sessions in one folder sit under a folder row; click it to fold them. Click a session to open it as a tab above the conversation. Right-click a session to **Rename** or **Delete** it; deleting removes the conversation, not any files. Closing a tab (**×**) keeps the session in the list. The **‹** button hides the list.

Long sessions show their last 20 turns; **Show earlier** loads more.

## Fork a session from a message

Each of your messages and each answer has a **Fork from here** button (the branch icon, next to Copy; on your messages it shows when you point at the message). It makes a new session in the same folder and opens it as a tab:

- From an answer, the new session keeps the conversation up to and including that answer.
- From one of your messages, it keeps what came before, and puts your message back in the input box to change and send again.

The original session stays as it was. Background processes are not copied; they stay with the original. You can't fork while the agent is working.

In the list, a fork has a branch icon; point at it to see what it was forked from. Deleting the original leaves the fork.

## Move a session to its own window

**⤢** on a session's tab moves it to a window of its own; its background processes keep running. It only works while the session is idle: while the agent works, waits for another turn or waits on a Shell tab, the button says why.

The window shows that one session, without the list. Its header names the model; the status badge stays in the main window. `F2` and `F3` work there as in the main window.

- **⇤ Re-attach** puts it back as a tab in the main window and closes the window (also only when idle).
- Commands that need a terminal still open in a Shell tab in the main window, which comes to the front. **Go to shell**, **Cancel** and **Stop** work as in the tab.
- Forks and `/new` made there open as tabs in the main window.
- Closing the window is like closing the tab: it stops the agent and the background processes, asking first if any run. Closing the main window closes these windows too.

A session is open in one window at a time. Clicking it in the list while it has a window brings that window to the front, and it can't be deleted until that window is closed.
