---
title: Notebook agents
description: Having agents make, read and change notebooks — a notebook's own chat, asking from Chat, Shell or Code, documents dropped into the chat, and saving answers and tables to a notebook.
---

# Notebook agents

Agents can do in a notebook what you can: make one, read it, add cards, change a table a row at a time, write Python cards, and move or delete cards. A Python card an agent writes runs once, after the same approval prompt as any agent's Python (Settings → Chat → Approval prompt). Every change they make shows where it came from on the card, and **⋯ → History…** undoes it (see the `notebooks` page).

## Ask about this notebook

The panel on the right is the notebook's own chat, kept with it: "organize these notes", "research the companies I mentioned", "extract the prices as a table". The agent sees the notebook's cards every turn and has Chat's tools. Drop a PDF, Word, spreadsheet or text file on the panel to have it read into your next message; the agent can keep the original in the notebook too. **»** hides the panel and **« Ask** brings it back. **Clear** starts the chat over without touching the notebook.

## Ask an agent to make or change a notebook

In Chat, Shell or Code, ask in your own words: "make a notebook called speakers with a table of the speakers, their price and a link", "add the bugs you found to a checklist in notebook Fixes", "read notebook Fixes and work through it". The agent can list, read and search notebooks, add cards, change a table a row at a time, and move or delete cards (deleted ones go to Trash). In Chat and Code it loads these tools when a notebook comes up (see the `tool-loading` page). Agents only see notebooks when asked.

## Save from a chat

In Chat, Shell and Code, **📓** under an answer saves it as a text card, and **📓 Save to notebook** on a table (shown on hover) saves it as a table card, with link cells kept as links. Right-click text you've selected in an answer for **Add selection to notebook…**. Each asks which notebook, or makes a new one; the card links back to the conversation.

## What agents don't do with notebooks

- They don't look in your notebooks unless you ask, and Memory never reads them (see the `memory` page).
- They can't open the files a notebook keeps.
- With Settings → General → **Show the Notebooks tab** off, agents have no notebook tools.
