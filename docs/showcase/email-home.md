---
title: Email, calendar & home
description: Home cards for important email, meetings, weather and news, research by email, your calendar and contacts, MCP servers and your screen.
---

## See only the emails that matter

Add a card to Home that checks your unread inbox and lists the messages that fit your rule, each with a short reason. Each one's ⋯ menu can draft a reply for you to review and send.

Tab: Home
Required settings: Settings → Integrations → Email → add an account

Prompt:

> From my manager, or about invoices

Example output:

The Important emails card lists matching unread messages with their sender, subject and age, and the model's reason under each. Nothing is marked as read.
<!-- media: Important emails card on Home with three messages and their reasons -->

Read more: home, integrations

## Ask a question by emailing yourself

Email your own address with a trigger phrase in the subject. Haruspex researches the question on the web and replies in the same thread, with the sources it read.

Tab: Home
Required settings: Settings → Integrations → Email → an account with Allow sending on; Home → Add card → Email requests…

Prompt:

> Subject: Ask Haruspex: best e-bike under £2000 for hills

Example output:

A reply arrives in the thread with the answer and a list of sources at the end. The Email requests card on Home shows the request as **Answered**; click it to read the question and answer.
<!-- media: Email requests card with an Answered request, and the reply in a phone mail app -->

Read more: email-research, home

## See your next meetings and the weather

Add an Upcoming meetings card and a Weather card to Home. Meetings show under Now, Later today and Tomorrow, with Join for video calls; the forecast covers now, today and tomorrow.

Tab: Home
Required settings: Settings → Integrations → Calendar & Contacts → add a calendar (for meetings)

Prompt:

> Leeds

Example output:

The Upcoming meetings card lists the next 12 hours of events with a **Join** button on ones with a Meet, Zoom or Teams link. The Weather card shows the forecast for the town you looked up, in °C or °F.
<!-- media: Upcoming meetings and Weather cards side by side on Home -->

Read more: home, integrations

## Ask about your calendar

The assistant can list and search your events. Calendar access is read-only, so it never changes anything.

Tab: Chat
Required settings: Settings → Integrations → Calendar & Contacts → add a calendar

Prompt:

> When am I free on Thursday afternoon?

Example output:

On Thursday you have:

- 13:00–13:30 Team sync
- 15:00–16:00 Design review

So you're free 13:30–15:00 and from 16:00 onwards.

Read more: integrations

## Find a contact's details

The assistant looks up contacts in your address books, read-only.

Tab: Chat
Required settings: Settings → Integrations → Calendar & Contacts → add a server account or Sign in with Google

Prompt:

> What's Sam's phone number?

Example output:

Sam Taylor in your contacts has:

- Mobile: 07700 900123
- Email: sam@example.com

Read more: integrations

## Follow the news you care about

Add a News card with your feeds and interests. Each morning at 7 the model picks the stories that match, each with a one-line summary.

Tab: Home
Required settings: None

Prompt:

> Local politics, Rust, space

Example output:

The News card lists the matching headlines from your feeds, each with a one-line summary. Click a headline to open the story, or use **⋯ → Ask about this** to start a chat about it.
<!-- media: News card on Home with several stories and summaries -->

Read more: home

## Use another app's tools through MCP

Add an MCP server from the catalog, such as Blender, and the assistant can use its tools. Blender needs to be running with its MCP addon.

Tab: Chat
Required settings: Settings → MCP servers → Add from the catalog → Blender

Prompt:

> In Blender, add a low table with four legs in the middle of the scene.

Example output:

The assistant calls the Blender server's tools to build the table, asking first for any tool marked "asks first", then says what it added to the scene.
<!-- media: Chat calling Blender MCP tools beside Blender showing the new table -->

Read more: integrations

## Ask about what's on your screen

Attach a screenshot of the screen, one window or a region with the camera button in the chat box, or let the assistant take one when you ask. It needs a model that reads images.

Tab: Chat
Required settings: Settings → Screen → Let the assistant take a screenshot when you ask it to (only for asking it to take one)

Prompt:

> Take a screenshot of the window I'm using and tell me what this error dialog means.

Example output:

Haruspex asks first, hides while it captures, then answers:

The dialog says the disk is full… Free some space in your home folder, then try again.

Read more: integrations, chat

## Send an answer to someone

Email or print one answer, or the whole conversation, from Chat. You add the recipient and send it yourself.

Tab: Chat
Required settings: Email needs an account with Allow sending on (Settings → Integrations → Email)

Prompt:

> Plan a three-day trip to Lisbon in March for two people who like food and walking.

Example output:

Under the answer, ✉️ opens a Review email window with the subject "Lisbon trip" and the plan as its text. 🖨️ opens the answer as a page with the print dialog over it.

Read more: chat-conversations, integrations
