---
title: Research by email
description: Email yourself a question with a trigger phrase and get a web-researched reply in the thread; setup, follow-ups and the checks.
---

# Research by email

A Research by email job lets you ask Haruspex a question from your phone. You email your own address with a trigger phrase in the subject. Haruspex sees it arrive, researches the question on the web and replies in the same thread.

## Set it up

The easy way is **Home → Add card → Email requests…**, which makes the job and shows its requests (below). Or, by hand:

1. In Settings → Integrations → Email, have the account you'll write from, with **Allow sending** on (see the `email` page).
2. In the Jobs tab, make a job of type **Research by email** (see the `jobs` page).
3. Pick the **Email account**, type a **Trigger phrase** such as `ask haruspex`, and set the **Daily limit** (10 by default, or **No limit**).
4. Leave **Answer when mail arrives** on, and give it a schedule as the backup check. Hourly is enough. With it off, the schedule is the only check, so every 15 minutes is a better start.
5. Leave **Working directory** empty. A Research by email job refuses one.

An account can have only one Research by email job. Mail that arrived before the job was made is never answered.

## How requests are picked up

With **Answer when mail arrives** on, Haruspex keeps a connection to the account's Inbox open, and the server tells it when new mail comes in. A request starts within seconds. If the request has no copy in Sent yet, Haruspex checks again a few times over the next half hour. A server that can't announce new mail is asked every 2 minutes instead.

After the computer sleeps, or the network drops, Haruspex connects again by itself, and it also checks mail that came in while it was away. The schedule still runs as the backup check.

## Ask a question

Email your own address. Put the phrase anywhere in the subject, in any case, for example `Ask Haruspex: best e-bike under £2000 for hills`. Put the question in the body. With an empty body, the subject without the phrase is the question.

The answer arrives as a reply in the thread, in HTML with a plain-text part. It ends with the sources the model read, or the line "No sources were listed." If the research fails, you get a short note saying why instead.

## Follow up

Reply to Haruspex's answer in the thread. The new question is answered with the last three questions and answers of that thread as context. Quoted text and signatures are removed from your reply first.

## What it checks

A request is answered only when all of these hold:

- It is from the account's own address, to that address, with the phrase in the subject.
- **A matching copy is in the account's Sent folder**: the same Message-ID, from and to the account, with the phrase.
- It is under the daily limit, counted from midnight.

The Sent copy is the real protection. Anyone can send mail with your address in From, but only mail you sent lands in your Sent folder. The phrase alone isn't enough, so a short one only makes ordinary mail to yourself more likely to match. The job's editor warns about a short phrase.

Gmail and Fastmail save a Sent copy of everything you send. With other providers, the mail app on your phone has to save it, and the editor warns about this. Phones sometimes save the copy late, so a request without one waits up to an hour before it is ignored.

DKIM, SPF and DMARC results are recorded for each request and shown on Home's Email requests card. They never stop a request.

## Where the mail goes

When Haruspex picks up a request, it moves it from the Inbox to a `Haruspex` folder. Ignored requests (no copy in Sent, or over the daily limit) go to `Haruspex/Ignored`. Nothing is marked read.

The move is also how two computers with the same job share the work. Whichever moves a request first answers it; the other sees it gone from the Inbox and leaves it. Replies go only to the account's own address, never to a Reply-To or Cc in the request, and no copy of them is saved to Sent.

## See the requests on Home

The Email requests card shows the phrase and address to use, and whether Haruspex is watching the inbox. Under that are the last 20 requests, newest first. Each has a state: **Waiting** (for its copy in Sent), **Researching**, **Sending**, **Answered**, **Failed** or **Ignored**. Failed and Ignored ones give the reason: No copy in Sent, Daily limit, Research failed, Couldn't send or Another computer took it. A line under each gives its DKIM, SPF and DMARC results.

Click an answered request to read its question and answer; **Open run** shows the run in the Jobs tab. The card is greyed out while the account has **Allow sending** off. **⋯ → Notify on new items** sends a notification for each new answer. A list of ignored requests you didn't send means someone is trying the phrase.

## What it can't do

- It uses web search, web pages and this guide only. It can't read or write files, run code, use memory, email, calendars, contacts, cameras or MCP servers, or make images or music.
- Attachments in a request are ignored.
- It answers only mail from the account to itself.
- Haruspex must be open to see a request. Mail that arrives while it is closed is picked up when it next starts. With **Answer when mail arrives** off, pickup waits for the next scheduled check.
- Two computers with the same job can still both answer a request if one couldn't move it (no network, or the mail server refused). Some mail servers also leave a narrow gap when both move it at the same moment.

Web pages it reads may see your question in the searches it makes, as with any web research.
