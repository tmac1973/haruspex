---
title: Lean mode
description: Run Haruspex as chat and research only, for a small model or a slow machine, and what lean mode turns off.
---

# Lean mode

Lean mode keeps Haruspex to Chat and Jobs, and Chat to conversation, web research and reading your files. It suits a model of 9B or smaller, or a machine without a fast GPU.

## Why it helps

Every tool Chat can use is described to the model at the start of each reply. With a working folder and a few integrations, that is over 30 tools and several thousand tokens before you have typed anything. On a slow machine that is minutes of waiting, a small context window fills up early, and a small model picks tools worse when it has many to choose from. Lean mode sends about 15. Settings → General → Load tools when needed does the same for larger models without turning anything off; it can't be changed while lean mode is on (see the `tool-loading` page).

## Turn it on or off

The setup wizard asks, as its last step, and recommends Lean for a model of 9B or smaller or a machine without a fast GPU (no graphics card, or slow integrated graphics). For a remote server's model it goes by the size in the model's name, and recommends Full when the name doesn't say.

After that, Settings → General → Lean mode. While it is on, a **Lean mode** badge shows in the header; click it to come back to the switch.

The switch can't be turned on while a Code or Shell turn is running. Finish or stop the turn first. Turning it off works at any time.

If you set Haruspex up before lean mode existed, it offers lean mode once, in a card at the bottom left, when the same rule fits your model or machine. **Not now** closes it for good.

If you switch to a bigger model while lean mode is on (one over 9B, or a remote model whose name doesn't give a size), the badge shows a dot: that model can run the full app. The dot shows once for each model, and never for the model you turned lean mode on with.

## What Chat can still do

- Search the web, read pages, and find images to show in an answer.
- Read files in the working folder: text, PDF, Word, spreadsheets and pictures (pictures need a model that can see them).
- Answer questions about Haruspex from this guide.
- Remember something when you ask it to, if memory is on (see the `memory` page).
- Use your installed skills, except the ones for pictures, music, speech, video and game art: Settings → Skills marks them "Off in lean mode" (see the `skills` page).

## What it turns off

- Job types other than Research. Other jobs stay in the Jobs list, marked **Paused by lean mode**; they can't be run, and a scheduled run is skipped rather than saved for later.
- The Code and Shell tabs. Ctrl / ⌘ + 3 and 4 do nothing, Chat has no open-in-Shell button, and a Code task in the tasks list says to turn lean mode off. A detached Code or Shell window shows a note instead of the session.
- Writing files of any kind: text, documents, spreadsheets, slides and PDFs. Chat puts what you asked for in its reply instead.
- The Python sandbox.
- Writing or changing skills.
- Speech, image, music and video generation.
- Email, calendar, contacts, screen capture and MCP servers.

Settings → General → Lean mode lists which of these you have set up. Their settings stay as they are; the model just isn't offered their tools, and turning lean mode off brings them all back.

Hidden is not closed. Code sessions keep their history, open terminals keep running, and turning lean mode off shows them as you left them.

## From another computer

Remote control follows lean mode too (see `remote-control`). The page shows Chat only, and a script can't start or send to a Code session or make a job other than research. `app.mode` tells a script whether lean mode is on.

## What it doesn't change

- A research job keeps its own tools, file writing included.
- The model itself, its context size and its other settings.
