---
title: Slide decks
description: Making a PowerPoint or LibreOffice deck in Chat: landscape or portrait, themes, layouts, charts and tables, pictures, speaker notes, crowded slides, and what .odp leaves out.
---

# Slide decks

Ask for a presentation and the assistant writes a PowerPoint `.pptx` file into the working folder. Ask for an `.odp` file if you want LibreOffice Impress's own format instead, though LibreOffice opens `.pptx` too. Chat needs a working folder for this; see the `chat` page.

The assistant writes the whole deck in one go. It can't open and change a deck that already exists: ask again and it writes a new one.

## Landscape or portrait

Decks are landscape (16:9) unless you say otherwise. Portrait (9:16) suits a deck read on a phone, shown on a vertical screen, or posted as a story. Say where the deck will be shown and the assistant picks. A portrait slide holds less text, and its picture goes above the bullets instead of beside them.

## Choose a look

There are five themes:

- **light**, the default: white, with blue accents.
- **dark**: dark slate, for a dim room or a screen recording.
- **bold**: black and white with red accents.
- **warm**: cream, with terracotta accents and serif titles.
- **calm**: pale grey-green.

Ask for one by name, or describe the feel you want. You can't give it your own template, colours or fonts.

## Layouts

Each slide has one layout, and the assistant mixes them:

- **cover**: the opening slide, with the title and a tagline on a coloured background.
- **section**: a divider between parts of the talk.
- **content**: a title and bullets, with a picture beside them if there is one.
- **two-column**: two lists, for a comparison. Portrait stacks them.
- **image**: a picture filling the slide, with the title on a strip across its foot.
- **quote**: a quotation and who said it.
- **stat**: one big number and what it means.

Asking for "a slide comparing the two plans" or "the growth figure as a big number" is usually enough. Bullets nest up to three levels.

## Charts and tables

A content slide can show a chart or a table, drawn by PowerPoint itself, so you can still change it there: click a chart and choose Edit Data to change its numbers. Charts are bar, line, pie or doughnut, with up to 8 series and 24 labels. Tables take up to 8 columns and 25 rows, and a column of numbers lines up on the right. Ask for the data as a chart and the assistant passes the numbers; it doesn't draw a picture of a chart.

With bullets, the chart or table sits beside them (above them in portrait), and without, it fills the slide. A slide shows one picture, chart or table.

## Pictures

A slide can show a PNG, JPEG or GIF from the working folder, up to 10 MB. Have the picture made or downloaded first: generate one (see the `images` page) or download it. A picture keeps its shape. A content slide fits it beside the bullets, or on the whole slide when there are none, and an image slide crops its edges to fill the page.

## Speaker notes

Ask for speaker notes and each slide gets them on its notes page, which PowerPoint and LibreOffice show in presenter view.

## When a slide is too full

Text and tables shrink a step or two to fit. A slide with far more than fits is refused: no file is written, and the assistant is told which slides to split. It usually splits them and tries again by itself. If it doesn't, ask it to.

## What an .odp deck leaves out

An `.odp` deck has no themes, speaker notes, charts or tables. Its cover, quote and stat slides become plain divider slides, a two-column slide lists both columns as one, an image slide shows its picture beside the caption, and a chart or table becomes a list of its numbers. The assistant says when it had to do this. For the full design, ask for `.pptx`.

## What it doesn't do

There are no animations or slide transitions, and no scatter, area or stacked charts.
