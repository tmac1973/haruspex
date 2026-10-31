---
title: Slide decks
description: Making a PowerPoint or LibreOffice deck in Chat: orientation, themes, layouts, charts and tables, pictures, notes, crowded slides, the LibreOffice check, and .odp limits.
---

# Slide decks

Ask for a presentation and the assistant writes a PowerPoint `.pptx` file into the working folder. Ask for an `.odp` file if you want LibreOffice Impress's own format instead, though LibreOffice opens `.pptx` too. Chat needs a working folder for this; see the `chat` page.

The assistant writes the whole deck in one go. It can't open and change a deck that already exists: ask again and it writes a new one.

## Landscape or portrait

Decks are landscape (16:9) unless you say otherwise. Portrait (9:16) suits a deck read on a phone, shown on a vertical screen, or posted as a story. Say where the deck will be shown and the assistant picks. Portrait uses larger text, sized for a phone, so a slide holds fewer words. Bullets on their own sit a little above the middle of the page, and a picture goes above the bullets instead of beside them.

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

- **cover**: the opening slide, with the title and a tagline on a coloured background. Given a picture, it becomes an image slide.
- **section**: a divider between parts of the talk.
- **content**: a title and bullets, with a picture beside them if there is one.
- **two-column**: two lists, for a comparison. Portrait stacks them, one under the other.
- **image**: a picture filling the slide, with the title on a strip across its foot.
- **quote**: a quotation and who said it.
- **stat**: one big number and what it means.

Asking for "a slide comparing the two plans" or "the growth figure as a big number" is usually enough. Bullets nest up to three levels, and can start with a few words in bold. Both columns of a two-column slide use the same text size.

## Charts and tables

A content slide can show a chart or a table, drawn by PowerPoint itself, so you can still change it there: click a chart and choose Edit Data to change its numbers. Charts are bar, line, pie or doughnut, with up to 8 series and 24 labels. Tables take up to 8 columns and 25 rows, and a column of numbers lines up on the right. Ask for the data as a chart and the assistant passes the numbers; it doesn't draw a picture of a chart.

With bullets, the chart or table sits beside them (above them in portrait), and without, it fills the slide. A slide shows one picture, chart or table.

## Pictures

A slide can show a PNG, JPEG or GIF from the working folder, up to 10 MB. Have the picture made or downloaded first: generate one (see the `images` page) or download it. A picture keeps its shape. A content slide fits it beside the bullets, or on the whole slide when there are none, and an image slide crops its edges to fill the page.

## Speaker notes

Ask for speaker notes and each slide gets them on its notes page, which PowerPoint and LibreOffice show in presenter view.

## When a slide is too full

Text and tables shrink a step or two to fit. A slide with far more than fits is refused: no file is written, and the assistant is told which slides to split and how many lines fit. It usually splits them and tries again by itself. If it doesn't, ask it to.

## The assistant checks its own slides

If LibreOffice is installed and the model can see images, the assistant looks at each deck it writes: LibreOffice draws the slides, and the model gets them as numbered sheets of up to nine slides each, 18 in all. It checks for text running off a slide or over a picture, charts and tables too small to read, and colours that don't read. If it finds a problem, it writes the deck again, at most twice, keeping its theme and orientation. Without LibreOffice, or with a model that can't see images, the deck is written all the same, unchecked. Haruspex doesn't install LibreOffice: get it from libreoffice.org or your package manager.

The check uses LibreOffice's own copy of its settings, so it works while you have LibreOffice open. It adds a few seconds to each deck.

## What an .odp deck leaves out

An `.odp` deck has no themes, speaker notes, charts or tables. Its cover, quote and stat slides become plain divider slides, a two-column slide lists both columns as one, an image slide shows its picture beside the caption, and a chart or table becomes a list of its numbers. The assistant says when it had to do this. For the full design, ask for `.pptx`.

## What it doesn't do

There are no animations or slide transitions, and no scatter, area or stacked charts.
