# Home tab — Project Overview

## Problem
Haruspex has been able to schedule jobs for a long time, but scheduled jobs
have nowhere to show what they produce. A run's output sits in the Jobs tab's
run history, so nobody schedules anything. At the same time, the things a user
wants to check through the day are spread out: email, calendar, weather and
news live in other apps, and the state of Haruspex itself (a code session
waiting for an answer, an autonomous-coding run halfway through its checklist)
is only visible from inside each tab.

A user who opens Haruspex has no single place that answers "what needs me
right now, and what is going on?".

## Goals
- A new **Home** tab, first in the tab bar, that shows a responsive list of
  cards the user can add, remove, reorder and size (normal or wide).
- Three kinds of card, each with the mechanism that fits it:
  - **Live** cards read app state directly: job runs, code sessions that need
    attention, autonomous-coding progress. No schedule, no model.
  - **Fetched** cards call a data source on an interval without the model:
    upcoming meetings (CalDAV / Google / ICS), today's weather.
  - **Fetched** also covers a GitHub card: issues and pull requests that need
    you, read through the catalog's GitHub MCP server.
  - **Judged** cards are backed by a scheduled job whose model picks, ranks or
    summarises: important emails, today's news.
- A **pinned job** card: any existing job can be pinned to Home, showing its
  latest run's output as markdown, its status and a Run now button.
- Judged cards return item IDs plus a short reason; the card renders the facts
  (subject, sender, date, headline, link) from the source, not from model text.
- A judged card's job is a normal job, visible and editable in the Jobs tab.
  The card stores its type, the job's id, its layout and its notify choice;
  the job's settings live only in the job.
- Freshness: on launch, a judged card older than its interval runs once; each
  card has a Refresh button; each card shows when it was last updated.
- Card jobs wait while a chat or code turn is in progress on the same model
  (including while that turn runs a tool), and show "waiting" until then.
- Per-card, opt-in desktop notifications for new items.
- Actions: Open (code session, job run, email, a meeting's join link, a news
  link), Ask about this (a new chat
  with the card's data attached), and Draft reply on emails, which you edit and
  send through the existing email review modal.
- Home appears in the Remote control web client, read-only, with Open links.
- `docs/guide/` gets a `home` page and updates to the pages it touches.

## Non-goals
- Not available in lean mode; Home is hidden there like Shell and Code.
- No free-form dashboard grid (no x/y/w/h placement or resize handles).
- No user-defined output schemas for pinned jobs; they render markdown.
- No email is ever sent without the user's click in the review modal.
- No actions from the Remote control web client; it is read-only in this
  project.
- No running scheduled work while the app is closed.
- No change to the landing tab: the app still opens on the last tab used.
- No change to the job editor layout (reworked in #834); this project only
  adds the two new types' sections, the Home badge, and a prefilled new-job
  draft (for the GitHub card's Plan this issue).

## Users & primary flow
Every Haruspex user outside lean mode.

1. The user opens the Home tab (Ctrl+1). A new user sees the live Haruspex
   cards (Jobs, Code sessions) and an Add card button.
2. They choose Add card → Important emails, pick an account, write what
   "important" means in one line, and choose an interval.
3. Haruspex creates a job for the card. The card shows "waiting" or "running",
   then a list of messages, each with a one-line reason.
4. They click Draft reply on one message. A draft streams in, they edit it,
   and Send opens the existing review modal.
5. They add Upcoming meetings and Weather; both show data at once without a
   model run.
6. A code session stops to ask a question; its row on the Code sessions card
   turns to "needs attention". Clicking it opens that session.
7. Later they open the Jobs tab and change the email card's interval there;
   the card follows.
8. On their phone, the Remote control page shows the same cards read-only.

## Constraints
- Stack: SvelteKit 5 runes, Tauri 2, SQLite through Rust `db_*` commands,
  settings as plain JSON in `stores/settings.ts`.
- One local llama-server lane by default; the Rust inference queue is FIFO
  with no chat priority. Card jobs must not delay a chat turn.
- The default model is Qwen 3.5 9B. Judged jobs must work on it: one task per
  step, structured output validated, and a clear failure state when invalid.
- The scheduler runs only while the app is open.
- Network calls go through the configured proxy (`proxy_fetch`).
- A changed Tauri command or `#[ts(export)]` struct means running
  `./scripts/export-ipc-types.sh`.
- Visible changes update `docs/guide/` in the same PR (Guide check).
- Keyboard shortcuts live in `src/lib/shortcuts.ts`; moving every tab digit
  updates the `shortcuts` guide page and its test.
- UI copy: one short sentence per section, details in tooltips, full Settings
  paths.
- The job editor rework (#834) is merged. New job types follow its contract:
  a `missingRequired` hook that agrees with `validate`, `required` on the
  inputs it names, and an entry in `JobEditor.svelte`'s `typeSectionTitles`.

## Success criteria
- Home is the first tab; Ctrl+1 opens it; the other tab shortcuts shift by one
  and the `shortcuts` page matches.
- In lean mode, Home is not shown and a stored `home` tab falls back to Chat.
- A code session waiting on an approval or question shows as "needs
  attention" on Home within a second, and clicking it opens that session.
- Adding Important emails creates one job visible in the Jobs tab; editing its
  interval there changes the card's refresh; removing the card asks whether to
  delete the job.
- Every message on the Important emails card exists in the account's INBOX;
  a model reply naming an unknown ID is dropped, and a reply that fails the
  schema shows an error on the card instead of stale or invented content.
- With a chat turn in progress on the same model, a due card job shows
  "waiting" and starts only after the turn ends.
- After the app was closed past a card's interval, the card runs once after
  launch, not once per missed interval.
- Upcoming meetings and Weather show data with no model run.
- The GitHub card lists only issues the token can see that match its
  filters, with no model run, and says which Settings path to use when the
  GitHub MCP server is missing or stopped.
- Draft reply never sends; Send goes through the email review modal.
- The Remote control web client shows Home cards read-only.
- `npm run check`, `npm run lint`, `npm run test`, `cargo test` and
  `cargo clippy` pass at every phase.

## Decisions
- **Audience** → every user, but not in lean mode.
- **Landing tab** → unchanged: the app opens on the last tab used.
- **Card set for the full release** → Haruspex status, Important emails,
  Upcoming meetings, Weather and News; GitHub added later (below).
- **Pin any job** → yes; a generic card shows the job's last output as
  markdown with status and Run now.
- **Layout** → ordered responsive list; reorder; each card normal or wide.
- **Notifications** → per card, opt-in, off by default.
- **Remote control** → Home shown read-only; actions stay on the desktop.
- **Contention with chat** → card jobs wait until no chat or code turn is
  streaming.
- **Freshness** → run once on launch when stale, plus a Refresh button;
  opening the tab does not trigger runs.
- **Email actions** → Draft reply produces an editable draft; sending only
  through the existing review modal.
- **GitHub card** (added after the first approval) → a fetched card fed by
  the catalog's GitHub MCP server through `mcp_call_tool`, with no model and
  no GitHub integration of its own. Issues come from `list_issues` filtered
  by the app, because the server's `search_issues` is semantic on github.com;
  pull requests from `search_pull_requests`. Presets for issues from others, reviews
  requested and pull requests from others; Work on this opens a code session
  or a guided-planning job in the local checkout.
- **Tab position** → first; Ctrl+1 is Home and the other digits shift.
