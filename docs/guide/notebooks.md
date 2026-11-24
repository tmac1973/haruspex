---
title: Notebooks
description: The Notebooks tab — keeping notes and research as cards, editing them, organizing notebooks with pins and tags, and getting deleted ones back from Trash.
---

# Notebooks

The Notebooks tab keeps notes and research you want to hold on to. A notebook is a list of cards, each with its own title. Notebooks are stored on this computer. Ctrl / ⌘ + 3 opens the tab (see the `shortcuts` page). It isn't shown in lean mode (see the `lean-mode` page), or with Settings → General → **Show the Notebooks tab** off. Off keeps your notebooks.

## Make a notebook

Click **+ New** in the list, type a title and press Enter. The list puts pinned notebooks first, then the rest by when they were last changed. Pin a notebook with 📌 next to its title.

Tags go in the line under the title, separated by commas. The tag chips above the list show only the notebooks with that tag; click the chip again to show all of them.

## Write in a text card

**+ Add card → Text** adds a card at the end; the **+** that appears between two cards adds one there. Click **Edit** (or double-click the text) to write. Text cards use Markdown: `**bold**`, `- lists`, `[a link](https://example.com)`, `## headings`. Links open in your browser. Changes save a second after you stop typing, and when you click **Done** or press Esc.

Each card has its own title; click it to rename. Drag a card by its ⋮⋮ handle, or use **⋯ → Move up / Move down**, to reorder.

## Keep a table

**+ Add card → Table** starts a table with two columns. Click a cell to type in it; Enter moves down, Tab moves right, Esc cancels. Each column has a type, set from the menu on its name: Text, Number, Currency, Link, Date, Checkbox or Status. Number and Currency columns get a total under the table. A value that doesn't fit its column's type is kept and tinted, so nothing is lost. The same menu renames, sorts, moves and deletes columns; **+** at the end adds one, and **+ Row** adds a row.

Pasting several lines copied from a spreadsheet into a cell adds them as rows. Tables with more than eight rows get a filter box. A table holds up to 5,000 rows.

## Tick off a checklist

**+ Add card → Checklist** adds a list of items to tick. Enter starts the next item; Backspace in an empty item removes it. Drag items by their ⋮⋮ to reorder, and **Hide done** hides the ticked ones.

## Ask an agent to make or change a notebook

In Chat, Shell or Code, ask in your own words: "make a notebook called speakers with a table of the speakers, their price and a link", "add the bugs you found to a checklist in notebook Fixes", "read notebook Fixes and work through it". The agent can list, read and search notebooks, add cards, change a table a row at a time, and move or delete cards (deleted ones go to Trash). In Chat and Code it loads these tools when a notebook comes up (see the `tool-loading` page). Agents only see notebooks when asked.

## Keep files and pictures

**+ Add card → Picture…** or **File…** picks files to keep in the notebook; dropping files onto a notebook does the same, placing them after the card under the pointer. Pictures show in the card, and clicking one enlarges it. Other files show their name and size: **Open** opens them in the app your computer uses for that type, **Save a copy…** saves them where you choose, and PDFs have **Preview**. Programs and scripts aren't opened from a notebook; save a copy instead. **Replace…** swaps in another file. Files up to 200 MB can be kept, and they stay on this computer.

## Link to a notebook

A link written `[speakers](notebook:<id>)` opens that notebook in this tab, and `notebook:<id>#<card>` scrolls to one of its cards. Agents use these links when they tell you about a notebook they made.

## Undo an agent's change

A card an agent changed shows where the change came from, such as "From Chat: Bluetooth speakers"; click it to open that conversation, Code session or job run. **⋯ → History…** lists the card's earlier versions: pick one to see it, then **Restore this version**. Changes from one source within two minutes share one version, and a card keeps its last 50. Restoring is itself a change, so it can be undone the same way.

## Get something back from Trash

**⋯ → Delete** on a card, or **⋯ → Delete notebook**, moves it to Trash; the message that appears has **Undo**. **🗑 Trash** at the bottom of the list shows everything deleted in the last 30 days: **Restore** puts it back, **Delete forever** removes it now. After 30 days it is removed on the next start.

## If someone else changed a card

If a card changed somewhere else while you were editing it, Haruspex reloads it and says so. What you typed stays in the editor, so you can copy it back in.

## What notebooks don't do

- They aren't one long document: each card is edited on its own.
- There are no folders; use pins, tags and search.
- Notebooks aren't copied to your other computers.
