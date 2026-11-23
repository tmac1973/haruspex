---
title: Files & documents
description: Have the assistant write reports, letters, spreadsheets and slide decks into a folder you pick, read long documents, and look at models, images and video.
---

## Write a report as a Word or PDF file

Pick a working folder with the folder icon in the chat box and ask for the document by file name. The extension picks the format: `.pdf`, `.docx`, or `.odt` if you ask for it.

Tab: Chat or Code
Required settings: None

Prompt:

> Research the pros and cons of a four-day working week and save it as four-day-week.pdf in the report style, A4, with a contents page.

Example output:

The answer says it saved `four-day-week.pdf` to the working folder. The PDF has blue headings, a contents page with page numbers, tables with a bold header row, and page numbers at the foot of each page.

<!-- media: first two pages of the generated report-style PDF, title and contents page -->

Read more: documents, chat

## Make a slide deck with a chart

Ask for a presentation and the assistant writes a PowerPoint `.pptx` into the working folder. Charts are drawn by PowerPoint itself, so you can still change their numbers there.

Tab: Chat or Code
Required settings: None

Prompt:

> Make a 6-slide deck called q3-sales.pptx in the dark theme: a cover, a bar chart of sales by region (North 120, South 95, East 140, West 80), the growth figure as a big number, and speaker notes.

Example output:

The answer says it saved `q3-sales.pptx`. The deck opens with a cover slide, has a bar chart slide you can edit with Edit Data, a stat slide with one big number, and notes on each slide for presenter view.

<!-- media: q3-sales.pptx open in LibreOffice Impress, showing the cover and the bar chart slide -->

Read more: slides, chat

## Summarise a long document

Put the file in the working folder and ask. The assistant reads text, Markdown, PDF, Word and Excel files.

Tab: Chat
Required settings: None

Prompt:

> Summarise annual-report.pdf in ten bullet points for someone with five minutes, and list anything it says about job cuts.

Example output:

**In brief**

- Revenue rose …, mostly from …
- The company plans to …
- …

**Job cuts:** the report mentions … on page …

Read more: chat

## Turn a folder of notes into a spreadsheet

The assistant can read every file in the working folder and write an Excel `.xlsx` or LibreOffice `.ods` from them.

Tab: Chat
Required settings: None

Prompt:

> Go through the meeting notes in this folder and make actions.xlsx with one row per action: date, owner, action and due date.

Example output:

The answer says it saved `actions.xlsx` to the working folder, with one row for each action it found across the notes, and lists any notes where an owner or due date was missing.

<!-- media: actions.xlsx open in a spreadsheet app with the four columns filled -->

Read more: chat

## Turn a CSV into a report with charts

The assistant draws the charts with Python, saves them as PNGs, then places them in the document.

Tab: Chat
Required settings: None

Prompt:

> Use expenses.csv to make expenses-2025.docx: a short summary, a pie chart of spending by category and a table of the ten largest items.

Example output:

The answer says it saved the chart and `expenses-2025.docx`. The Word file has a heading, a short summary, the pie chart on a line of its own, and a table with the amounts lined up on the right.

<!-- media: expenses-2025.docx open in Word or LibreOffice showing the pie chart and the table -->

Read more: documents, chat

## Look through a folder of models, images or video

Open a folder from the Code tab and step through its files with the arrow keys. The viewers show `.glb` models, images, sounds and videos; they never change the files.

Tab: Code
Required settings: None

Prompt:

> Open → Folder… → ~/Pictures/renders

Example output:

A viewer window opens on the folder's first model, else its first image, with a tree of the folder's files beside it. Press → to show the next one; the bar gives each image's size in pixels and on disk.

<!-- media: image viewer window with the folder tree on the left and a render fitted to the window -->

Read more: viewers
