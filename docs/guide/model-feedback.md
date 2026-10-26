---
title: Model feedback on tools
description: Let the model report problems with Haruspex's own tools while it works and after each job run, saved on this computer for whoever is improving Haruspex.
---

# Model feedback on tools

The model is the one that uses Haruspex's tools all day. With this on, it can say when one got in its way: a tool that failed when it should not have, a misleading result, an error that did not say what to do, or something it needed and did not have. It is meant for people working on Haruspex, and works best with a capable model.

It is off by default.

## Turn it on

1. Open Settings → Feedback.
2. Turn on **Let the model report problems with Haruspex's tools**.

## What the model does with it

- In every chat, Shell and Code turn, every subtask and every job turn, the model gets a `haruspex_feedback` tool. In Chat, Shell and Code it is also asked to use it, including when it had to work around a tool. It reports a problem, then carries on with the task. A turn makes at most three reports.
- After each job run that made tool calls, the job's model gets one more turn to look back over the run's calls and report what got in the way. It is skipped after a run you cancel. It uses the job's model and an inference slot, like the run did.

Guests (see the `guest-chat` page) never get the tool.

## Where reports go

Each report is one line of JSON in a file per month, in the `agent_feedback` folder of Haruspex's data folder. **Open reports folder** in Settings → Feedback opens it.

A report holds what the model said, the tool it was about, the model's name, the app version, and the last few tool calls behind it with their arguments and results, shortened. Those calls can include file contents, web pages and command output.

Nothing is sent anywhere. To share a report, copy it out yourself.

## What it doesn't do

- The model does not mention reports in its answers, and you are not shown them in the chat.
- It is not for problems with your task, a website or a file; only Haruspex's tools.
- A report is the model's opinion. The calls saved with it show whether the tool or the model was at fault.

## Read the reports

From a Haruspex checkout, `node scripts/agent-feedback.mjs` counts reports by tool and kind and prints the latest. Pass a folder or `.jsonl` file to read somewhere else, and `--all` to print every report.
