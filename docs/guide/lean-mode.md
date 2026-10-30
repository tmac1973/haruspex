---
title: Lean mode
description: Run Haruspex as chat and research only, for a small model or a slow machine, and what lean mode turns off.
---

# Lean mode

Lean mode keeps Chat to conversation, web research and reading your files. It suits a model of 9B or smaller, or a machine without a fast GPU.

## Why it helps

Every tool Chat can use is described to the model at the start of each reply. With a working folder and a few integrations, that is over 30 tools and several thousand tokens before you have typed anything. On a slow machine that is minutes of waiting, a small context window fills up early, and a small model picks tools worse when it has many to choose from. Lean mode sends about 15.

## Turn it on or off

Settings → General → Lean mode. While it is on, a **Lean mode** badge shows in the header; click it to come back to the switch.

The switch can't be turned on while a Code or Shell turn is running. Finish or stop the turn first. Turning it off works at any time.

## What Chat can still do

- Search the web, read pages, and find images to show in an answer.
- Read files in the working folder: text, PDF, Word, spreadsheets and pictures (pictures need a model that can see them).
- Answer questions about Haruspex from this guide.
- Remember something when you ask it to, if memory is on (see the `memory` page).
- Use your installed skills (see the `skills` page).

## What it turns off

- Writing files of any kind: text, documents, spreadsheets, slides and PDFs. Chat puts what you asked for in its reply instead.
- The Python sandbox.
- Writing or changing skills.
- Speech, image, music and video generation.
- Email, calendar, contacts, screen capture and MCP servers.

Settings → General → Lean mode lists which of these you have set up. Their settings stay as they are; the model just isn't offered their tools, and turning lean mode off brings them all back.

## What it doesn't change

- Code and Shell tabs, and jobs, keep their own tools.
- The model itself, its context size and its other settings.
