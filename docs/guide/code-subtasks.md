---
title: Code subtasks
description: Subtasks in the Code tab — helper agents the coding agent hands parts of a task to, read-only or writing in their own copy, how many run at once, and how to turn them off.
---

# Code subtasks

A subtask is a helper agent the coding agent starts on its own to handle one part of your request, such as "find every caller of this function" or "work out how the tests mock the database". For the Code tab itself, see the `code` page.

## What a subtask does

The agent decides when to use subtasks; you ask as usual. Each subtask starts with an empty context in the session's folder, does its one task, and hands back a short report (at most 4,000 characters). The agent sees the report, not everything the subtask read, so long investigations take less of the session's context.

A read-only subtask searches, reads files and runs commands that only read (`ls`, `cat`, `grep`, `git log` and the like); any other command is refused without asking you. Subtasks use the session's model and effort.

## Let subtasks change files

With Settings → Code → Subtasks at **Read and write**, the agent can also hand a change to a writing subtask. It works in its own copy of the project: a git worktree made from the folder as it is right then, uncommitted changes included, beside the repository in `<repo>-worktrees/.subtasks/`. Ignored dependency folders (`node_modules`, `.venv`, `venv`, `vendor`) are shared with it rather than copied, so it can build and test without installing. Its commands follow the session's approval rules: **Allow for this session** and **Auto-approve commands** cover it, and otherwise **Run this command?** names the subtask and its card says it is waiting for you.

When it finishes, its changes are applied to the folder: as they are, or merged when the folder changed meanwhile. If they clash with those changes nothing is applied, the card says **Didn't apply**, and the agent gets the patch to make the change itself; that copy stays until you delete the session. Changes from a subtask you stop are dropped.

Writing subtasks need a git repository, and aren't offered in a read-only session.

## Follow a subtask

Each subtask shows as a card among the agent's steps: its name (hover for the full task), whether it is waiting for a slot, running or done, and how long it took. While it runs, the card lists its own steps; once it ends they fold away behind **Show N steps**, and **Report** holds what it handed back. Cards are saved with the session. Settings → Remote control's page shows each card with its status and report, without the steps.

## Run several at once

Subtasks the agent starts together run at the same time when the model server takes more than one request at once: raise Settings → Inference → Parallel streams for the bundled server, or use a server that runs several. With one stream they run one after another; they still keep the session's context small.

Up to 4 run at once, and the agent starts at most 8 per turn.

## Let subtasks run in the background

The agent can also start a subtask in the background, for work it doesn't need before answering. Its answer doesn't wait: the subtask runs on, its card marked **Background**, and when it finishes its report arrives as a new turn, shown as **Subtask finished**, which the agent answers. With one stream it starts once the agent's turn ends. Up to 4 run at once per session. A session with background subtasks running can't move to another window until they end.

## Stop subtasks

**Stop** on a card stops that subtask; the agent carries on with what the others found, and is told you stopped it. **Stop** on the session stops the turn and the subtasks it is waiting for; background subtasks keep running. Closing or deleting the session stops them all.

## Turn subtasks off

Settings → Code → Subtasks: **Read only** (the default), **Read and write**, or **Off**. Off, the agent does every part itself.

## What subtasks don't do

- Read-only ones don't write or edit files, or run commands that might.
- Writing ones don't commit, and don't install or upgrade the shared dependency folders.
- They don't ask you anything, and can't see the conversation: the agent writes each one's task in full.
- They don't start subtasks of their own, or leave anything running.
- They're only in the Code tab, not the Shell tab's Full access or Chat.
