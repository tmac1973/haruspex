---
title: Research & answers
description: Ask questions and get answers from the web with sources, dig deeper with deep research, and ask about your files, images and data.
---

## Get a quick answer with sources

Ask about something current. The assistant searches the web, reads the pages and cites them with numbered chips you can click.

Tab: Chat
Required settings: None

Prompt:

> What changed in the latest Linux kernel release?

Example output:

The release mostly brings new hardware support and file system work [1]. The main changes:

- Support for … graphics and … laptops [1]
- Faster … for Btrfs [2]
- …

Numbered chips under the answer show each source; click one to open the page.

Read more: chat, search-and-network

## Research a question in depth

Turn on deep research with the magnifying-glass button in the chat box. The assistant searches more sources and takes more steps, so the answer is slower but wider.

Tab: Chat
Required settings: None

Prompt:

> Is a heat pump worth it for a 1970s semi-detached house in a cold, damp climate? Look at running costs, insulation and grants.

Example output:

**Short answer:** often yes, but only after the insulation is done [2][5].

- **Running costs** depend on … [1][3]
- **Insulation** matters most in older houses because … [2]
- **Grants** vary by country; check … [4]

Read more: chat, search-and-network

## Compare products or options

Ask for a side-by-side comparison. The assistant searches for each option and brings what it finds into one answer with sources.

Tab: Chat
Required settings: None

Prompt:

> Compare three e-readers under £150 for reading PDFs: screen size, battery life and whether they lock you into one store.

Example output:

**Reader A** — 7-inch screen, weeks of battery, … [1]
**Reader B** — larger screen, better for PDFs, but … [2][3]
**Reader C** — opens any store's books, … [4]

For PDFs, **Reader B** suits you best because …

Read more: chat, search-and-network

## Ask about a PDF or document

Pick a working folder with the folder icon in the chat box, then ask about a file in it. The assistant reads text, PDF, Word and Excel files; a scanned PDF needs a model that can see images.

Tab: Chat
Required settings: None

Prompt:

> Read tenancy-agreement.pdf. What notice do I have to give to leave, and are there any fees for ending early?

Example output:

You have to give **two months' notice** in writing (section 4.2) …

- Ending early: a fee of … applies before month six (section 7.1).
- …

Read more: chat

## Chart the data in a CSV

The assistant writes and runs Python in a sandbox inside the app, shows the chart in the answer and can save it to your working folder. It asks **Allow code execution?** first.

Tab: Chat
Required settings: None

Prompt:

> Load electricity.csv from my folder, plot monthly usage for the last two years and tell me which months went up the most.

Example output:

A line chart of monthly usage appears in the answer, followed by a short summary: usage rose most in … and …, by about …%. Click **code** on the step to see the Python it ran.

<!-- media: chat answer with a matplotlib line chart of monthly electricity use and a two-line summary -->

Read more: chat

## Ask about an image or a screenshot

Drop or paste an image into the chat box, or use the camera button to attach a screenshot of the screen, a window or a region. This needs a model that can see images.

Tab: Chat
Required settings: A model that can see images

Prompt:

> What's this error dialog telling me, and how do I fix it?

Example output:

The dialog says the disk is full, so the update couldn't unpack …

1. Open … and check free space.
2. Clear … then run the update again.

Read more: chat

## Ask Haruspex how to do something in Haruspex

The assistant reads the user guide and how this copy of Haruspex is set up before it answers, and says when the guide doesn't cover something.

Tab: Chat
Required settings: None

Prompt:

> How do I add my calendar, and is memory on?

Example output:

Memory is **on**. To add a calendar, open Settings → Integrations → Calendar & Contacts and choose **Add a calendar link** or **Add a server account** …

- …

Read more: getting-started, integrations

## Keep working while an answer is written

Send in another conversation while one is still answering, or send more in the same one to change its course. A queued message shows above the chat box until the assistant reads it.

Tab: Chat
Required settings: None

Prompt:

> Actually, only look at sources from the last year.

Example output:

**Queued** shows above the chat box. Once the running search finishes, the assistant answers with a line such as "Understood — I'll keep to sources from the last year," then carries on with the same question.

Read more: chat-conversations

## Fix a question and ask again

Change something you asked earlier and send it again, or get a fresh go at the last answer. The answers after it go, and the chat carries on from the new version.

Tab: Chat
Required settings: None

Prompt:

> Compare the three cheapest e-readers with a warm light.

Example output:

Point at your message and click ✏️. It goes back in the chat box. Change "three" to "five" and press `Enter`: the old answer goes and a new comparison is written in its place. Click 🔄 under an answer to have it written again from the same question.

Read more: chat-conversations
