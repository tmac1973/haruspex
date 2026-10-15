---
title: Code subtasks
description: Subtasks in the Code tab — helper agents the coding agent hands parts of a task to, how many run at once, and how to turn them off.
---

# Code subtasks

A subtask is a helper agent the coding agent starts on its own to handle one part of your request, such as "find every caller of this function" or "work out how the tests mock the database". For the Code tab itself, see the `code` page.

## What a subtask does

The agent decides when to use subtasks; you ask as usual. Each subtask starts with an empty context in the session's folder, does its one task, and hands back a short report (at most 4,000 characters). The agent sees the report, not everything the subtask read, so long investigations take less of the session's context.

In this release subtasks only read. They search, read files and run commands that only read (`ls`, `cat`, `grep`, `git log` and the like); any other command is refused without asking you. They use the session's model and effort.

A subtask shows in the conversation as one of the agent's steps, named after its task, with the report as its result.

## Run several at once

Subtasks the agent starts together run at the same time when the model server takes more than one request at once: raise Settings → Inference → Parallel streams for the bundled server, or use a server that runs several. With one stream they run one after another; they still keep the session's context small.

Up to 4 run at once, and the agent starts at most 8 per turn.

## Stop subtasks

**Stop** on the session stops the turn and every subtask it is waiting for.

## Turn subtasks off

Settings → Code → Subtasks: **Read only** (the default) or **Off**. Off, the agent does every part itself.

## What subtasks don't do

- They don't write or edit files, and don't run commands that might.
- They don't ask you anything, and can't see the conversation: the agent writes each one's task in full.
- They don't start subtasks of their own, or leave anything running.
- They're only in the Code tab, not the Shell tab's Full access or Chat.
