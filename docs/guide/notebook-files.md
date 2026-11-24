---
title: Notebook files and Python
description: Keeping files and pictures in a notebook, Python cards that work with its tables, and exporting or importing notebooks (PDF, Word, OpenDocument, web page, Markdown, Jupyter, CSV, Excel).
---

# Notebook files and Python

What a notebook can hold besides text, tables and checklists, and how to get notebooks in and out of Haruspex. For the basics see the `notebooks` page.

## Keep files and pictures

**+ Add card → Picture…** or **File…** picks files to keep in the notebook; dropping files onto a notebook does the same, placing them after the card under the pointer. Pictures show in the card, and clicking one enlarges it. Other files show their name and size: **Open** opens them in the app your computer uses for that type, **Save a copy…** saves them where you choose, and PDFs have **Preview**. Programs and scripts aren't opened from a notebook; save a copy instead. **Replace…** swaps in another file. Files up to 200 MB can be kept, and they stay on this computer.

## Work with tables in Python

**+ Add card → Python** holds code that runs in the Python sandbox (Settings → Chat → Enable Python sandbox). The notebook's tables are pandas DataFrames in `tables["Title"]`; code reads them but never changes them. **▶ Run** (or Ctrl / ⌘ + S) runs it and keeps the output, plots included; "stale" means a table it read has changed since. Put a DataFrame in `result` and **Save as table card** keeps it as a new table. The cards of one notebook share variables; **Reset** clears them.

## Export a notebook

**⋯ → Export as…** on a notebook saves it as a PDF, a Word or OpenDocument file, a web page (one file, pictures inside), Markdown, or a Jupyter notebook (Python cards become code cells, with their output). Markdown with files or pictures is saved as a .zip with them in `files/`. A table's **⋯ → Export table as CSV… / Excel…** saves that table alone.

## Import notes and tables

**⤓ Import…** under the notebook list makes a notebook from each Markdown, CSV or spreadsheet file you pick; **⋯ → Import into this notebook…** adds to the open one. Markdown is split at its `##` headings: its tables become table cards and its task lists checklists. A CSV becomes one table, and a spreadsheet a table per sheet (up to 5,000 rows each).
