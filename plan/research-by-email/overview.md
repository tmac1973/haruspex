# Research by email — Project Overview

## Problem

Haruspex can research a question well, but only from the machine it runs on
(or from guest chat on the local network). Away from home, with only a phone,
there is no way to hand it a question and get an answer back. Email already
reaches the phone, Haruspex already reads IMAP and sends SMTP, and the research
job already knows how to search and read the web.

The risk is what makes this more than glue. An inbox is a public door: anyone
can send mail with a forged `From: you@example.com`, and "from you, to you" is
a favourite spam trick precisely because filters trust it. A job that acts on
email has to prove the request is really the user's, and it must not be able to
send anything from the machine, whatever the request (or a web page it reads)
tells it to do.

## Goals

- A **Research by email** job type: on its schedule it checks one email
  account's inbox for requests, researches each one with web tools only, and
  replies in the same thread.
- A request is an email **from the account to itself** whose subject contains a
  **trigger phrase** the user chooses. Matching ignores case.
- A request is acted on only when **a matching copy is in the account's Sent
  folder**: the same Message-ID exactly, from and to the account, with the
  phrase. Mail from outside lands only in the Inbox, so a forged request fails
  this check however good the forgery, even one that reuses the Message-ID of
  some other mail the user sent.
- The reply goes **only to the account's own address**: never to `Reply-To`,
  `Cc` or anything else in the request.
- Research runs with **web tools only** (`web_search`, `fetch_url`,
  `research_url`, `haruspex_docs`). No files, shell, memory, email, calendar,
  contacts, MCP, cameras, image or music tools. No working directory.
- A **reply in the thread continues the research**: the earlier question and
  answer go in as context, and quoted text is stripped from the new message.
- Every request is **recorded in Haruspex's database**, and a trusted one is
  **moved to a `Haruspex` folder when it is picked up**, so a restart or a
  failed move never answers one twice. Ignored requests move to
  `Haruspex/Ignored`.
- Answers are **HTML with a plain-text part**, rendered from the model's
  Markdown, ending with the numbered sources the model lists (or a line saying
  it listed none).
- If research fails, a **short failure email** is sent instead of the answer.
- A **per-day cap** the user sets (default 10, or no limit). Requests over it
  are ignored and shown as such.
- Each request's **Authentication-Results** (DKIM, SPF, DMARC) are parsed and
  shown on the card. They never block a request in v1.
- An **Email requests** Home card that creates the job and lists recent
  requests with their state: waiting, researching, sending, answered, failed,
  or ignored with the reason.
- The editor **warns** when the trigger phrase is short or common, and when the
  account's provider may not keep a Sent copy.

## Non-goals

- Attachments in a request. They are ignored; the email body is the request.
- Image, music, video or 3D generation, or any tool beyond web research.
- IMAP IDLE. Pickup lags by up to the job's interval.
- More than one email account per job. A second account is a second job, and
  an account can have only one Research by email job.
- Senders other than the account itself (a work address, family members).
- Blocking requests on DKIM/DMARC results.
- An acknowledgement email at pickup.
- Making Haruspex reachable while it is closed. It must be open for the
  schedule to fire, as for every job.
- Running the same job on two computers. Moving a request at pickup makes a
  double answer unlikely, not impossible; the guide says to use one computer.

## Users & primary flow

The user is Haruspex's owner, away from their computer with only a phone.

1. In Haruspex, they add **Home → Add card → Email requests…**, pick an email
   account with **Allow sending** on, and type a trigger phrase such as
   `ask haruspex`. The card creates a Research by email job (every 15 minutes
   to start) and the editor shows any warnings.
2. Later, on their phone, they email their own address with the subject
   `ask haruspex: best e-bike under £2000 for hills` and the question in the
   body.
3. At the next check, Haruspex lists inbox messages whose subject has the
   phrase, from the account's own address, not yet handled and not sent by
   Haruspex itself.
4. For each one it looks for a matching copy in the Sent folder. Without one,
   the request waits up to an hour (phones sometimes save to Sent late), then
   is ignored, moved to `Haruspex/Ignored` and shown on the card as "No copy
   in Sent".
5. It checks the per-day cap, records the request, strips quoted text and
   signatures, parses Authentication-Results for display, and moves the
   request to the `Haruspex` folder.
6. It runs a deep-research turn with web tools only, and the request (and the
   thread's earlier answers, for a follow-up) as the only user content.
7. It sends the answer as a reply in the thread, to the account's address.
8. The card shows the request as answered, with its DKIM result. The user reads
   the answer on their phone, and can reply in the thread to dig further.

## Constraints

- Stack: SvelteKit 5 job types under `src/lib/agent/jobs/types/`, Home cards
  in `src/lib/home/cardTypes.ts`, Rust IMAP and SMTP in
  `src-tauri/src/integrations/email/`, SQLite in `src-tauri/src/db/`.
- IMAP today searches only INBOX and only by date, from, subject and unseen. It
  reads a fixed set of headers, and can trash but not move, flag or create
  folders. All of that is new work.
- SMTP today sends plain text only. HTML means a new multipart/alternative
  body.
- The model may be the 9B default. Prompts must be single-purpose, and the
  pipeline (not the model) does the checking, sending and moving.
- Haruspex's own replies are also from the account to itself and carry the
  phrase in their `Re:` subject. They must never be taken as requests.
- A request typed in a mail app that doesn't save to Sent can't pass the
  check, and the editor warns for providers other than Gmail and Fastmail
  (which save SMTP mail to Sent themselves). Haruspex's replies are not
  appended to Sent, as with camera alerts; they reach the account's own Inbox
  on every provider, which is where Haruspex looks for them after a crash.
- Web fetches keep Haruspex's existing refusal of `localhost` and private
  addresses (`proxy/extract.rs`, `proxy/public_dns.rs`), so a request can't
  reach this computer's own services through `fetch_url`.
- Untrusted input everywhere: request bodies, web pages and headers are data,
  never instructions to the pipeline.
- A visible feature, so `docs/guide/` gets a page and the `home` and
  `job-types` pages change in the same PRs.
- Changed Tauri commands or `#[ts(export)]` structs mean running
  `./scripts/export-ipc-types.sh`.

## Success criteria

- An email from the phone with the phrase gets an in-thread HTML answer, with
  sources, within one check interval plus research time.
- A forged request (right From and phrase, sent from another server) shows as
  Waiting, then after an hour as ignored with "No copy in Sent", in
  `Haruspex/Ignored`. No mail is sent. The same holds when it reuses the
  Message-ID of a real email the user sent to someone else.
- Haruspex's own replies are never answered, even though they match the phrase
  and appear in Sent.
- After a restart mid-run, no request is answered twice.
- The research turn is offered only the web allowlist; a test asserts the
  offered schemas.
- A follow-up reply in the thread is answered with the earlier exchange in
  context.
- Over the daily cap, requests are shown as ignored, and none is sent.
- The card shows each request's state and its DKIM/SPF/DMARC result.
- `npm run check`, `npm run lint`, `npm run test`, `cargo test` and
  `cargo clippy` pass, and the guide check passes.

## Decisions

- **Sender proof** → A matching copy must be in the Sent folder (exact
  Message-ID, from and to the account, with the phrase), plus a trigger phrase
  the user chooses (not a generated token), with warnings for a weak phrase.
- **Senders** → Only the account's own address.
- **Follow-ups** → A reply in the thread continues the research, with quoted
  text stripped.
- **Handled record** → Message-IDs in Haruspex's database, and the request
  moved to a `Haruspex` folder.
- **Storage** → A new `email_requests` SQLite table.
- **Run shape** → One job run per check, handling requests one after another.
- **Conversations** → None; the card and run history only.
- **Shipping** → One PR per phase.
- **UI** → A job type plus an Email requests Home card that creates it.
- **Reply format** → HTML with a plain-text part, sources at the end.
- **Acknowledgement** → None; only the answer, or a short failure email.
- **Limits** → A per-day cap the user sets (default 10, or no limit), and the
  deep-research step limit per request.
- **DKIM/DMARC** → Parsed and shown on the card, never blocking in v1.
- **Out of v1** → Inbound attachments, image/music generation, IMAP IDLE, more
  than one account per job.
