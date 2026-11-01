---
title: Loading tools when needed
description: How Chat and the Code tab send a short tool list and load groups of tools such as video editing only when a request needs them, and the Auto, On and Off choices.
---

# Loading tools when needed

Every tool the assistant can use is described to the model at the start of each message. With several integrations on (email, pictures, music, video editing, an MCP server), those descriptions come to about 27,000 tokens before you type anything. That fills a small context window early and makes every reply slower to start.

With **Load tools when needed** on, Chat and the Code tab send the tools used most (web search and pages, reading and writing files, Python, the guide, memory, skills) and list the rest by group in one line each. When a request needs a group, the model loads it first. The same message then starts at about 7,000 tokens.

## Turn it on or off

Settings → General → Load tools when needed:

- **Auto** (default) — on for models above 12B, and for models whose name doesn't give a size. Off for 9B and smaller models, which choose the right group less reliably.
- **On** — always, whatever the model.
- **Off** — every tool is sent with every message, as before.

The choice can't be changed while lean mode is on: lean mode already sends a short fixed list (see the `lean-mode` page).

## The groups

Documents (PDF, Word, OpenDocument, spreadsheets, slides), email, calendar, contacts, pictures, music, speech, video generation, video editing, screen capture, writing skills, and game assets in the Code tab. Each MCP server is a group of its own. A group is listed only when its tools are available: email appears once an account is connected, video editing once it is turned on and a working folder is set.

## What you see

The first time a request needs a group, the steps under the answer show **Loaded video tools** (or the group's name) before the tool itself. That is one extra step. The tools then show as usual, for example **Looking at clips in ep012**.

- A request for a file (a PDF, a spreadsheet, slides) starts with the documents tools already loaded.
- In Chat, a group stays loaded for the rest of the turn. A later message loads it again when it needs it, unless Settings → Chat → Keep tool results from the previous turn in context keeps the last turn's tools in view.
- In the Code tab, a group stays loaded until the session is summarised.

## What it doesn't do

- It never adds a tool you have turned off, and never removes one you have on: it changes when the model sees a tool, not which tools it has.
- The Shell assistant, jobs, guests on Guest chat and subtasks always get their full tool list.
- A model that doesn't load a group it needs answers without those tools. If a request about video, email or another group gets a vague answer, name the group ("use the video tools to…") or set this to Off.
