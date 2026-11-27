---
title: Notebooks
description: Keep research, notes and lists in notebooks of text, tables, checklists, files and Python, and have agents in every tab make and work through them.
---

## Turn research into a notebook

Ask in Chat, and have the answer kept as a notebook with a typed table you can sort, total and edit later.

Tab: Chat
Required settings: None

Prompt:

> What are some good Bluetooth speakers under $200? Make a new notebook called "Speakers" with a table of the speakers, their key features, price, and a link to a retailer that sells them.

Example output:

A notebook **Speakers** with a table card:

| Name              | Key features                     |   Price | Retailer     |
| ----------------- | -------------------------------- | ------: | ------------ |
| JBL Charge 5      | IP67, 20 h battery, power bank   | $179.95 | amazon.com/… |
| UE Boom 3         | 360° sound, floats, 15 h battery | $149.99 | amazon.com/… |
| Soundcore Motion+ | aptX, IPX7, 12 h battery         | $119.99 | amazon.com/… |

The card says "From Chat: Bluetooth speakers", and its History can undo any change.

Read more: notebooks, notebook-agents

## Organize your notes

Type rough notes into a notebook, then ask its own chat to sort them out and look things up.

Tab: Notebooks
Required settings: None

Prompt:

> Organize these thoughts: a short summary, a checklist of next steps, and a table of the companies I mentioned with what I said about each. Research what each company does.

Example output:

Your notes stay at the top; below them the agent adds a summary card, a **Next steps** checklist (Call Globex about API pricing, Compare Stripe vs Paddle…) and a **Vendors** table with a column of what you said about each.

Read more: notebook-agents, notebooks

## Pull a table out of a document

Drop a PDF, Word or spreadsheet file on a notebook's chat and ask for what you need from it.

Tab: Notebooks
Required settings: None

Prompt:

> Extract the price list from this PDF as a table, with the item, unit price and minimum order.

Example output:

A table card **Price list** with typed columns (the unit price as currency), and the PDF kept as an attachment card beside it.

Read more: notebook-agents, notebook-files

## Keep a list of bugs to work through

In a Code session, keep what the agent found as a checklist, then come back to it later and tick items off as they're fixed.

Tab: Code
Required settings: None (a project folder)

Prompt:

> Make a notebook called "Fixes" with the bugs you found as a checklist. … Later: read notebook Fixes and let's work through it.

Example output:

A **Fixes** notebook with one checklist item per bug. As the session fixes each one it ticks it off, and the card says "From Code: …".

Read more: notebook-agents, code

## Outline a folder

Ask the Shell assistant to look around and write down what it finds.

Tab: Shell
Required settings: None

Prompt:

> Have a look at ~/Projects and make a notebook outlining what's in it.

Example output:

A notebook **Projects** with a text card per project (what it is, its language, when it was last changed) and a table of their sizes.

Read more: notebook-agents, shell

## Chart a table with Python

A Python card reads the notebook's tables as pandas DataFrames, and keeps its output, plots included.

Tab: Notebooks
Required settings: Settings → Chat → Enable Python sandbox (on by default)

Prompt:

> Add a Python card that charts price against battery hours for the speakers in the Models table, with each point labelled.

Example output:

A Python card with the code and, under it, a scatter plot of the three speakers. Change a price and the output says "stale" until it runs again.

Read more: notebook-files, notebook-agents

## Move your notebooks to another computer

Back up every notebook, with its files and history, to one file, and restore it on another computer or after a reinstall.

Tab: Settings
Required settings: None

Prompt:

> Settings → Notebooks → Back up… on the first computer, then Settings → Notebooks → Restore… on the other.

Example output:

"Backed up 14 notebooks, 212 cards, 31 files." On the other computer: "Restored: added 14 notebooks."

Read more: notebook-files

## Print a notebook or email it

Print a notebook, or one card of it, with its pictures, or email it from your own account with its pictures inside and its files attached.

Tab: Notebooks
Required settings: Email needs an account with Allow sending on (Settings → Integrations → Email)

Prompt:

> ⋯ → Print… on the Speakers notebook; or ⋯ → Email card… on its Models table.

Example output:

A print window shows the notebook as a white page, with the system print dialog open over it. Email opens a Review email window with the subject "Models — Speakers" and the table as formatted text, ready for a recipient. Tick **Attach as PDF** to send a PDF of it too.

Read more: notebook-files, email

## File a card as a GitHub issue

Turn a checklist or a table of findings into an issue, or add it to one that's already open, without copying and pasting.

Tab: Notebooks
Required settings: The GitHub server in Settings → MCP servers, with a token that can write issues

Prompt:

> ⋯ → File card as GitHub issue… on the "Bugs to fix" checklist; or ⋯ → Add card to a GitHub issue… and paste the issue's link.

Example output:

**File on GitHub** opens with the repository you used last, the card's title and its checklist as the issue's text. Tick the `bug` label and click **Create issue**: "Opened an issue in tmac1973/haruspex." with **Open** to see it.

Read more: notebook-files

## Have an agent work through a setup guide

Turn a step-by-step checklist into work done: an agent in a terminal does each step, ticks it, and writes a note on it with what happened. You type any `sudo` password yourself.

Tab: Notebooks, then Shell
Required settings: A capable model; the Shell tab set to Full access

Prompt:

> ⋯ → Work through in Shell… on the "Install OpenHands" checklist, or on the notebook itself when the plan is a table per phase with a Done column. In the new tab, `ssh` to the server, click the lock for Full access, and send the drafted message.

Example output:

The agent runs `sudo apt install docker.io`, and **🔑 Type your password in the terminal** shows until you do. Then it ticks "Install Docker" with the note "Installed docker.io 27.3; added tim to the docker group, log out and back in for it to apply." and stops: "Next is Open port 3000. Go on?"

Read more: notebook-agents, shell
