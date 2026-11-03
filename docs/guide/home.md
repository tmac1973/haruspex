---
title: Home
description: The Home tab — cards for jobs, Code sessions, pinned jobs, important email, news, meetings and weather. Adding and arranging cards, and acting on what they show.
---

# Home

The Home tab is the first tab: cards that show what Haruspex is doing and what needs you. The band at the top counts running and queued jobs, Code sessions waiting on you, important emails and your next meeting; a job or session count opens its tab. Ctrl / ⌘ + 1 opens it (see the `shortcuts` page). Home isn't shown in Lean or Lean + files (see the `lean-mode` page).

## The cards you start with

- **Jobs** — the job running now with its step and progress ("Step 2 of 4 · 3/7"), how many runs are queued, and the five latest runs. Click a run to open it.
- **Code sessions** — sessions that are running, queued, waiting on a shell command, or waiting on you (**Needs attention**: a command to approve or a question to answer). Click one to open it. Idle sessions and ones in a detached Code window aren't listed.

## Pin a job

**Add card → Pinned job…** shows a job's latest result: the last step's output of its newest successful run, with **Show more** for long output, and the newest run's error above it if that run failed. **Run now** starts a run; **Open** shows it in the Jobs tab. The card updates when any run finishes. If the job is deleted, the card says so and can only be removed.

## See the email that matters

**Add card → Important emails…** needs an email account (see the `integrations` page). Pick the accounts, say what counts as important ("from my manager, or about invoices"), how far back to look, how many to show and how often to check (every 30 minutes to start).

Each check lists your unread inbox mail and the model picks the ones that fit your rule, reading only sender, subject and first lines. Subject, sender and age come straight from your mail; the model's short reason sits under each, with a coloured edge, and it can't change what a message says it is. Read mail drops off at the next check, and checking never marks anything as read. **Refresh** checks now.

## Follow the news you care about

**Add card → News…** asks for RSS or Atom feeds (tick listed ones or paste your own) and your interests ("local politics, Rust, space"). Each morning at 7, or on **Refresh**, it reads the feeds and the model picks the stories that match, each with a one-line summary. Headlines, sources and links come from the feeds. A feed that can't be read is skipped.

## See your next meetings and the weather

**Add card → Upcoming meetings…** needs a calendar account. Tick calendars, or none for all, and say how far ahead to look (12 hours to start). Events show under Now, Later today and Tomorrow, with **Join** for Meet, Zoom, Teams, Webex, Whereby and Jitsi links. It reads every 10 minutes, with no model, and names a calendar it can't read.

**Add card → Weather…** looks up a town or city for you to pick, in °C or °F. The forecast comes from Open-Meteo (no account) through Settings → Network → Network Proxy, which is sent only the place's coordinates. Now, today and tomorrow; every 30 minutes.

Both keep their last result, shown at start-up with the time it was read. **↻** reads again now (weather under 10 minutes old comes back unchanged). A failed read keeps the last result and says what went wrong.

## Keep up with GitHub

**Add card → GitHub…** needs the GitHub MCP server (see the `integrations` page) and reads through it every 15 minutes, with no model. Pick **Issues from others** (open issues someone else filed), **Reviews requested** or **Pull requests from others**. Leave Owners and Repos empty for your own repos. It skips ones you've commented on and bots unless you untick those; labels, days and a maximum narrow it. If the server is stopped, the card says so above its last result.

An issue's **⋯** also has **Open code session**, which puts the issue in a new Code session's box unsent, and **Plan this issue**, a guided-planning job filled in from it (unsaved). Both need a Code session you've opened in a checkout of that repo.

## Act on what a card shows

Each email, story, meeting and GitHub item has a **⋯** menu.

- **Ask about this** opens a new chat with the item quoted in the box, for you to add a question and send. For an email it quotes what the card shows; ask the chat to read the whole message.
- **Open** shows a whole email. Clicking a headline opens the story; **Join** opens a meeting.
- **Draft reply** writes a reply to an email. Say how to reply ("decline politely") if you like, then edit the draft. **Review & send** opens the Review email window, and only its **Send** sends. It needs **Allow sending** on the account (Settings → Integrations → Email).

## Add, arrange and remove cards

**Add card**, top right, adds a card at the end; a removed card can be added back. One that needs an account or server first is greyed out; hover it to see what to set up. Each card's **⋯** menu has **Move up**, **Move down**, **Wide** (two columns) or **Normal width**, **Edit job** (its job's schedule and settings, in the Jobs tab) and **Remove**.

The email and news cards make their own job, which has a **Home** badge in the Jobs tab. It waits while a chat or Code turn is using the model (the card says "Waiting for chat"), and like every job but research it doesn't run in lean mode. **⋯ → Notify on new items** sends a desktop notification naming what's new; it is off until you turn it on. Removing such a card deletes its job unless you untick **Also delete the job**; removing a pinned job's card keeps the job unless you tick it.

Cards and their order are kept across restarts, and stack in one column on a narrow window. A card from a newer version of Haruspex shows as **Unknown card** and can only be removed.

Remote control's page shows Home too, read-only, from your phone or another computer (see the `remote-control` page).
