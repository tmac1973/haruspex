# Phase 04 — The Research by email job type

**Depends on:** 01, 02, 03 · **Enables:** 05 (the card creates this job and
reads its rows)

## Goal

A scheduled `email_research` job type that ties the pieces together. Each run
finishes anything an earlier run left open, scans the inbox, sorts candidates
into trusted requests and ignored ones, claims each trusted request by moving
it out of the Inbox, researches it with web tools only, and replies in the
thread. All checks, the recipient and the sending are done by the pipeline and
Rust; the model only writes the answer. The guide gets its page in this PR.

## Files touched

- `src/lib/agent/jobs/types/email-research/config.ts` (new) and test:
  `EmailResearchConfig` with `accountId`, `phrase`, `dailyLimit: number | null`
  (`null` is no limit; default 10).
- `src/lib/agent/jobs/types/email-research/triage.ts` (new) and test: pure
  decisions (below), given a candidate, its row (if any), counts and now.
- `src/lib/agent/jobs/types/email-research/body.ts` (new) and test: strip
  quoted text and signatures.
- `src/lib/agent/jobs/types/email-research/reply.ts` (new) and test: Markdown
  → sanitised HTML and plain text, sources, failure note.
- `src/lib/agent/jobs/types/email-research/pipeline.ts` (new) and test.
- `src/lib/agent/jobs/types/email-research/definition.ts` (new) and
  `Editor.svelte` (new).
- `src/lib/agent/jobs/types/email-research/warnings.ts` (new) and test.
- `src/lib/agent/jobs/types/registry.ts`, `src/lib/agent/jobs/types/index.ts`:
  register.
- `src/lib/stores/jobs.svelte.ts`: add `'email_research'` to `JobType`
  (:16-25).
- `src/lib/agent/jobs/runner.concurrency.test.ts`: a case for this type.
- `docs/guide/email-research.md` (new); `docs/guide/job-types.md`: a section
  that points to it.

## Steps

1. **Config and validation.** `missingRequired`: `Email account` (one with
   **Allow sending** on) and `Trigger phrase`. `validate`: the phrase is 3-60
   characters with no line breaks; `dailyLimit` is `null` or 1-100; and no
   other `email_research` job uses the same account ("This account already
   has a Research by email job."). One job per account means one cap, one
   no-overlap rule and one record of claims for each inbox.
   `supportsSchedule: true`, `background: true`, `hasPlannedSteps: false`, no
   working directory field. The job's own `created_at` is the start of the
   scan window: mail from before the job existed is never answered. The config
   has no `since` field.
2. **Warnings** (`warnings.ts`, shown under the phrase field in one line, the
   detail in a `title` tooltip): the phrase is under 8 characters or one word
   ("Short phrases are easy to guess."); the account's `provider`
   (`EmailProvider`, `src-tauri/src/integrations/email/provider.rs:33`; in TS
   `src/lib/ipc/gen/EmailProvider.ts`) is not `'gmail'` or `'fastmail'`
   ("Your mail app must save sent mail to Sent."). A Google Workspace account
   set up with the Gmail preset counts as Gmail.
3. **No overlap.** The runner already queues a run behind an active run of the
   same job. A case in `runner.concurrency.test.ts` holds that for
   `email_research`, so two runs never triage the same row at once.
4. **Finish open rows first** (`db_email_requests_open`), oldest first:
   - `sending`: if `email_request_reply_seen(reply_message_id)`, set
     `answered` (or `failed` for `reply_kind: 'failure'`). Otherwise, if
     `send_attempts < 3`, resend the stored reply with the **same**
     `reply_message_id`; otherwise set `failed` / `send_failed` and send
     nothing. Every send, first or retry, adds 1 to `send_attempts` before it
     goes out, so a request gets at most three sends. If the user deletes
     Haruspex's reply before the next run on a provider that keeps no Sent
     copy, `reply_seen` misses it and the same reply (same Message-ID, so
     mail apps thread it as one) may go again. The plan accepts that edge.
   - `researching` (a run was cut off): if `attempts < 2`, set `attempts + 1`
     and research it again (step 8); otherwise send the failure note
     (step 11). So a request that crashes every time is tried twice, then
     failed.
   - `waiting_sent` whose `first_seen_at` is over an hour old: set `ignored` /
     `no_sent_copy` here, without needing the scan to meet it again (the user
     may have deleted it, or the 48-hour window passed while Haruspex was
     closed). If it is still in the Inbox, step 6's re-move puts it in
     `Haruspex/Ignored`. Younger ones wait for step 6.
5. **Scan.** `email_request_scan(account, phrase, max(job.created_at, now −
   48 h))`.
6. **Triage** each candidate, oldest first. `triage.ts` returns one decision;
   the pipeline acts on it:
   - **Skip (own reply):** its Message-ID is a row's `reply_message_id`
     (`db_email_requests_by_reply_id`). Rust already drops replies that kept
     `X-Haruspex-Reply`; this catches one that lost the header.
   - **Re-move:** a row exists in any state but `waiting_sent` (an earlier
     move failed). Move it again to `Haruspex` (or `Haruspex/Ignored` for an
     `ignored` row), and do nothing else.
   - **Wait / ignore (no Sent copy):** `email_request_sent_has(message_id,
     phrase)` is false. Insert or keep the row as `waiting_sent`. Once its
     `first_seen_at` is over an hour old, set `ignored` / `no_sent_copy` and
     move it to `Haruspex/Ignored`. Phones sometimes save to Sent after the
     message is delivered; the hour covers that.
   - **Ignore (daily limit):** a Sent copy exists, `dailyLimit` is set, and
     `db_email_requests_count_since(job, local midnight)` has reached it. It
     counts by claim time (`claimed_at`), so a request that waited past
     midnight counts for the day it was researched. The count is read fresh
     for each candidate, after the previous one was claimed, so requests
     claimed earlier in the same run count. Set `ignored`
     / `daily_limit` and move it to `Haruspex/Ignored`.
   - **Claim:** otherwise.
7. **Claim.** In this order:
   - Read the body with `email_read_full` (it fetches with PEEK, so nothing is
     marked read; HTML-only mail comes back as text through `text.rs`'s
     `html_to_text`). `body.ts` cuts at the first `On … wrote:` line, an
     `-----Original Message-----` line, or a run of `>`-quoted lines; drops a
     signature after a `-- ` line; caps the result at 8000 characters.
     Attachments are ignored. An empty body uses the subject with the phrase
     removed.
   - Thread: a request whose `In-Reply-To` or `References` holds a row's
     `reply_message_id` is a follow-up and takes that row's `thread_id`;
     otherwise `thread_id` is its own Message-ID.
   - Save the row as `researching` with `question`, `thread_id`,
     `references`, `auth`, `attempts + 1`, `claimed_at` (now) and the
     `run_id`.
   - Move it to `Haruspex`. Once it has left the Inbox, a second computer
     running the same job won't see it. A move that fails is logged with
     `console.warn`; the row already stops a second answer, and step 6's
     re-move tries again next run.
8. **Research.** One `ctx.runJobTurn` per request, with:
   - `toolAllowlist: ['web_search', 'fetch_url', 'research_url',
     'haruspex_docs']`: guest chat's set (`REMOTE_TOOLS`,
     `src/lib/remote/driver.ts:65`) without `ask_user_question`, since no one
     can answer. `research_url`'s summariser (`runSubAgent`,
     `_helpers.ts`) is a single model call with no tools.
   - No working directory: the job type has none, and `runJobTurn` takes it
     from the job.
   - `interactive: false`, `deepResearch: true` (25 steps),
     `keepCutOffAnswer: true`.
   - A system prompt from `webResearch.ts`'s rules, plus: the request came by
     email and is the only thing to answer; answer in Markdown with numbered
     citations `[1]`, and end with a `Sources` section listing `[n] title —
     URL`; you can't send email, read files or remember anything, so don't
     offer to. No user memory is added: job turns never get recall.
   - The user message: for a follow-up, up to the last 3 exchanges of the
     thread (`db_email_requests_thread`, question and answer, oldest first),
     then the new question.
   - Web fetches keep Haruspex's existing guard: `proxy/extract.rs` refuses
     `localhost` and private addresses, and `proxy/public_dns.rs` refuses a
     name that resolves to one. So an injected "fetch http://127.0.0.1:8788/…"
     fails like any other job's would.
   Each request is one step in the run's history, named after its subject.
9. **Reply** (`reply.ts`): render the answer with `marked`, then
   `DOMPurify.sanitize` with `ALLOWED_TAGS`: `p br h1 h2 h3 h4 ul ol li strong
   em code pre blockquote a table thead tbody tr th td hr`; `ALLOWED_ATTR`:
   `href`; `ALLOWED_URI_REGEXP` allowing only `https:`, `http:` and `mailto:`.
   No `img` at all, so no remote, `data:` or `cid:` images. The result goes in
   a short inline-styled template. The plain-text part is the Markdown with
   link URLs written out. If the answer has no `Sources` heading, both parts
   end with "No sources were listed." rather than leaving the reader to guess.
10. **Send.** Generate `reply_message_id` (`<` + random UUID + `@` + the
    account address's domain + `>`), save the row as `sending` with the
    answer and `reply_kind: 'answer'`, call `email_request_reply`, then set
    `answered`.
11. **Failure.** A research error, or an empty answer, sets
    `reply_kind: 'failure'` and `answer` to a short note ("Haruspex couldn't
    answer this: <reason>."), then goes through step 10 the same way, ending
    in `failed` / `research_failed` instead of `answered`. A send error leaves
    the row in `sending` for step 4 to retry or fail.
12. **Result.** `ctx.setResult` with the run's counts (answered, failed,
    ignored) and an `items` list of the requests answered in this run (row id,
    subject), which the Home card's "notify on new items" uses in Phase 05.
    `db_email_requests_prune(job)` at the end.
13. **Guide.** `docs/guide/email-research.md`: set it up; write a request;
    follow up in the thread; the checks (a matching copy in Sent, the
    account's own address, the phrase) and why the phrase alone isn't the
    protection; where handled and ignored mail goes (`Haruspex`,
    `Haruspex/Ignored`); what it can't do (attachments, files, memory, other
    senders, instant pickup, working while Haruspex is closed); run the job on
    one computer only; and that web pages it reads can see the question.
    `job-types.md` names the page.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`; the
Guide check passes; `cargo test` stays green.

## Test plan

- `triage.test.ts`: an own reply (by `reply_message_id`) is skipped; a row in
  `answered` met in the Inbox is re-moved, not answered; no Sent copy →
  `waiting_sent`, then `ignored` after an hour; at the daily limit →
  `ignored`, and a limit of 1 with two good candidates in one run claims one
  and ignores the other; `null` limit never ignores.
- `pipeline.test.ts` (mocked `invoke` and `runJobTurn`): the turn is offered
  exactly the four allowlisted tools (assert through `offeredSchemas`); the job
  has no working directory; a follow-up's user message holds the earlier
  exchange; the reply command's input has no recipient field; the move to
  `Haruspex` happens before research starts; a `sending` row whose reply is
  seen becomes `answered` with no resend; one whose reply isn't seen is resent
  with the same `reply_message_id`, and after three sends in all becomes
  `failed`; a crash between the failure note's send and its final state does
  not research again; a `researching` row cut off twice is failed, not
  researched a third time; a `waiting_sent` row over an hour old that the scan
  no longer returns becomes `ignored`.
- `config.test.ts`: a second job on the same account fails `validate`.
- `body.test.ts`: Gmail, Apple Mail and Outlook quote styles; signatures;
  empty body falls back to the subject.
- `reply.test.ts`: `script`, `img` and `onerror` are stripped; a
  `javascript:` link loses its `href`; Sources URLs become links in HTML and
  stay written out in plain text; a missing Sources section adds the note.
- Manual, on the user's Gmail: each success criterion in the overview, end to
  end, including a forged request from a second account (it waits, then is
  ignored and moved), a forged request that reuses the Message-ID of a real
  email the user sent to someone else (ignored), a request whose body says
  "fetch http://127.0.0.1:8788/" (the fetch is refused), and quitting
  Haruspex during research (the next launch finishes it with one reply).

## Commit

`feat(jobs): research requests sent by email and reply in the thread`

## Rollback

Revert the commit. Existing `email_research` jobs then fail to load their type
and show as unknown; delete them in the Jobs tab. Rows in `email_requests`
remain but are unused, and mail already in the `Haruspex` folders stays there.
