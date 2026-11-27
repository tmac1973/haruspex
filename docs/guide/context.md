---
title: Context during a long task
description: What happens when one turn's tool results fill the model's context — trimmed results, what their stubs keep, reading them back with recall_result — and what it doesn't do.
---

# Context during a long task

## Why results get trimmed

A turn that reads many files or long pages can fill the model's context before it is done. When the prompt reaches about 70% of the context size, Haruspex replaces older tool results with short stubs until it is back near 55%. The three newest results are never trimmed.

## What a stub keeps

Each stub names the call and its size, and keeps a few facts read from the output: the exit code, test totals, the first error line, the page address. Often that is enough to go on.

## Read a trimmed result back

In Chat, Code and the Shell, the model can call `recall_result` with the stub's id to read the exact text again: a range of lines, numbered from 1 as `fs_read_text` numbers them, or only the lines that contain a word. It is the original output, not a new run: a command does not run twice and a page is not fetched again.

## What it doesn't do

- One step reads back only as much as fits below the trim point, so a recall does not set off the next trim. The model asks for the rest in a later step.
- The ids last for one turn. Between turns, long chats and Code sessions summarise older messages instead (see the `chat` and `code-sessions` pages).
- Lean mode leaves `recall_result` out to keep the tool list short. Its stubs ask the model to run the tool again (see the `lean-mode` page).
- Jobs that read files, run commands or fetch pages can use `recall_result` too: autonomous coding, guided planning, audits, asset and model generation, email research and notebook refresh. A job that has the model only judge or report, such as a news or email digest, has no use for it.
- A larger Settings → Inference → Context Size means fewer trims.
