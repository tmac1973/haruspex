---
title: Notebook agents
description: Having agents make, read and change notebooks — a notebook's own chat, asking from Chat, Shell or Code, working through a checklist or plan in Shell, and saving answers and tables to a notebook.
---

# Notebook agents

Agents can do in a notebook what you can: make one, read it, add cards, change a table a row at a time, write Python cards, and move or delete cards. A Python card an agent writes runs once, after the same approval prompt as any agent's Python (Settings → Chat → Approval prompt). Every change they make shows where it came from on the card, and **⋯ → History…** undoes it (see the `notebooks` page).

## Ask about this notebook

The panel on the right is the notebook's own chat, kept with it: "organize these notes", "research the companies I mentioned", "extract the prices as a table". The agent sees the notebook's cards every turn and has Chat's tools. Drop a PDF, Word, spreadsheet or text file on the panel to have it read into your next message; the agent can keep the original in the notebook too. **»** hides the panel and **« Ask** brings it back. **Clear** starts the chat over without touching the notebook.

A turn gets 25 steps (searches, reads, table edits). If it stops before it has written everything, it says what is left; ask it to carry on, or raise Settings → Notebooks → Max steps per turn.

## Ask an agent to make or change a notebook

In Chat, Shell or Code, ask in your own words: "make a notebook called speakers with a table of the speakers, their price and a link", "add the bugs you found to a checklist in notebook Fixes", "read notebook Fixes and work through it". The agent can list, read and search notebooks, add cards, change a table a row at a time, and move or delete cards (deleted ones go to Trash). In Chat and Code it loads these tools when a notebook comes up (see the `tool-loading` page). A research job's step can do the same when its prompt asks ("put the prices you found in a table in notebook Speakers"); its changes say "From Jobs" (see `job-types`). Agents only see notebooks when asked.

## Work through a checklist or a plan in a terminal

**⋯ → Work through in Shell…** opens a new Shell tab with a message typed into its assistant box, not sent: do the steps one at a time, tick each and write down what happened. It is on a checklist, on a table with a checkbox column (one step per row; its other columns, such as a command and the expected output, say what to do), and on the notebook's own **⋯** for every such card in order. What happened goes in the item's note, a table's Notes column, or the notebook's log table (a table with "log" in its title, such as "Build log") when there is one. `ssh` to the machine first if the steps are for another one, switch the tab to **Full access**, change the message if you like, and send it. The agent does one step, then stops and says what's next; say "go on", or ask it to run straight through. It starts again at the first unticked step, so a stopped turn or a closed tab loses nothing. When `sudo` asks for a password, you type it in the terminal (see the `shell` page).

## Keep a notebook up to date

**⋯ → Refresh on a schedule…** on a notebook makes a **Refresh notebook** job (see `job-types`): say what to update ("check each speaker's current price and update the Price column") and set its schedule in the Jobs tab. Each run changes only what you named; its changes say "From Jobs" on the cards, and History undoes them.

## Save from a chat

In Chat, Shell and Code, **📓** under an answer saves it as a text card, and **📓 Save to notebook** on a table (shown on hover) saves it as a table card, with link cells kept as links. Right-click text you've selected in an answer for **Add selection to notebook…**. Each asks which notebook, or makes a new one; the card links back to the conversation. A job run's output, in the Jobs tab or on a Home card, saves the same way, and its card says "From Jobs" and links back to the run. A finished audit run also has **📓 Save to notebook** at its top, which saves its findings as tables (see the `job-types` page).

## Email a notebook

In Chat, with an email account that has **Allow sending** on, ask "email the Trip notebook to Sam as a PDF". The draft opens in **Review email** with the notebook attached (a PDF unless you ask for Word, OpenDocument, a web page or Markdown), and you send it. Ask for one card to attach only that card; a file card attaches its file. See the `email` page.

## What agents don't do with notebooks

- They don't look in your notebooks unless you ask, and Memory never reads them (see the `memory` page).
- They can't open the files a notebook keeps. They can only attach one to an email draft you review.
- With Settings → General → **Show the Notebooks tab** off, or in lean mode, agents and jobs have no notebook tools.
