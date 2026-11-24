---
title: Notebooks
description: The Notebooks tab — notes and research kept as text, table and checklist cards; pins, tags and search; broken links; undoing changes; Trash; and notebooks on your other computers or phone.
---

# Notebooks

The Notebooks tab keeps notes and research you want to hold on to. A notebook is a list of cards, each with its own title. Notebooks are stored on this computer. Ctrl / ⌘ + 3 opens the tab (see the `shortcuts` page). It isn't shown in lean mode (see the `lean-mode` page), or with Settings → General → **Show the Notebooks tab** off. Off keeps your notebooks.

## Make a notebook

Click **+ New** in the list, type a title and press Enter. The list puts pinned notebooks first, then the rest by when they were last changed. Pin a notebook with 📌 next to its title.

Tags go in the line under the title, separated by commas. The tag chips above the list show only the notebooks with that tag; click the chip again to show all of them.

## Find something

**Search notebooks** above the list looks through every notebook's titles, text, table cells, Python code and file names; click a result to open it at that card, with the row highlighted. Settings → Notebooks → **Semantic search** also finds cards by meaning ("how long it plays unplugged" finds "battery life"); it downloads the model Memory uses and indexes notebooks on this computer.

## Write in a text card

**+ Add card → Text** adds a card at the end; the **+** that appears between two cards adds one there. Click **Edit** (or double-click the text) to write. Text cards use Markdown: `**bold**`, `- lists`, `[a link](https://example.com)`, `## headings`. Links open in your browser. Changes save a second after you stop typing, and when you click **Done** or press Esc.

Each card has its own title; click it to rename. Drag a card by its ⋮⋮ handle, or use **⋯ → Move up / Move down**, to reorder.

## Keep a table

**+ Add card → Table** starts a table with two columns. Click a cell to type in it; Enter moves down, Tab moves right, Esc cancels. Each column has a type, set from the menu on its name: Text, Number, Currency, Link, Date, Checkbox or Status. Number and Currency columns get a total under the table. A value that doesn't fit its column's type is kept and tinted, so nothing is lost. The same menu renames, sorts, moves and deletes columns; **+** at the end adds one, and **+ Row** adds a row.

Pasting several lines copied from a spreadsheet into a cell adds them as rows. Tables with more than eight rows get a filter box. A table holds up to 5,000 rows.

## Tick off a checklist

**+ Add card → Checklist** adds a list of items to tick. Enter starts the next item; Backspace in an empty item removes it. Drag items by their ⋮⋮ to reorder, and **Hide done** hides the ticked ones.

## Keep files, run Python, export

Pictures, files, Python cards, exporting a notebook to PDF, Word, a web page or Markdown (or importing one), and backing up all of them are on the `notebook-files` page.

## Have an agent do it

Agents in Chat, Shell, Code and each notebook's own chat can make and change notebooks for you; see the `notebook-agents` page.

## Find broken links

**⋯ → Check links** asks for every web link in the notebook (in text and Link columns) and marks those that no longer load with ⚠; point at one to see why. A notebook is checked again by itself when you open it a week after the last check. Links to this computer or your local network aren't checked, and a site that doesn't answer in time isn't marked. Checks use your proxy (see `search-and-network`).

## Link to a notebook

A link written `[speakers](notebook:<id>)` opens that notebook in this tab, and `notebook:<id>#<card>` scrolls to one of its cards. Agents use these links when they tell you about a notebook they made.

## Undo an agent's change

A card an agent changed shows where the change came from, such as "From Chat: Bluetooth speakers"; click it to open that conversation, Code session or job run. **⋯ → History…** lists the card's earlier versions: pick one to see it, then **Restore this version**. Changes from one source within two minutes share one version, and a card keeps its last 50. Restoring is itself a change, so it can be undone the same way.

## Get something back from Trash

**⋯ → Delete** on a card, or **⋯ → Delete notebook**, moves it to Trash; the message that appears has **Undo**. **🗑 Trash** at the bottom of the list shows everything deleted in the last 30 days: **Restore** puts it back, **Delete forever** removes it now. After 30 days it is removed on the next start.

## If someone else changed a card

If a card changed somewhere else while you were editing it, Haruspex reloads it and says so. What you typed stays in the editor, so you can copy it back in.

## Notebooks on your other computers

With a paired computer on (see `other-computers`), its notebooks are listed under its name and search looks in them too. Edit their text, tables and checklists, restore earlier versions, and use their chat (it runs there). Files up to 25 MB can be saved from them. Python, files, reordering and columns change only on that computer, and nothing is copied: they're there while it's on.

## Use them from your phone

Settings → Remote control's page has a **Notebooks** tab: search and read every notebook, edit text, tables and checklists, and use a notebook's chat (**Ask**). Python, files and pictures are shown there but changed only here.

## What notebooks don't do

- They aren't one long document: each card is edited on its own.
- There are no folders; use pins, tags and search.
- Notebooks aren't copied or merged between computers.
