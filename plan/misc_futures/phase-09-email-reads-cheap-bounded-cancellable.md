# Phase 09 — Email: cheaper, bounded, cancellable reads

Depends on: — / Enables: 11

## Goal

Make reading mail cheap, bounded and cancellable, and capture the headers
that phase 11 needs for replies.

**The review findings** (`src-tauri/src/integrations/email/`):
- **Wasteful list call.** `list_recent` fetches every message whole
  (`BODY.PEEK[]`, attachments included, `imap_client.rs:297`), up to 50 of
  them, then MIME-parses each one to make a 240-character snippet.
- **No time limits.** No network call has a timeout, and the frontend never
  passes the tool's abort signal, so a stalled server hangs the turn.
- **Inaccurate results:**
  - `hours` is rounded to whole days;
  - accounts are queried one after another;
  - error placeholders sort last and can be trimmed away;
  - defaults disagree (20 in the comments, 25 in the code).
- **Poor text extraction.** HTML-to-text keeps `<style>` and `<script>` text,
  loses paragraphs and drops links. Quote stripping cuts at the first `>`
  line, which loses inline replies.
- **Unsupported setups.** STARTTLS is refused for IMAP, so a custom provider
  that needs it can't connect. UIDs are used without checking UIDVALIDITY.
- **Missing headers.** Message-ID, In-Reply-To, References, Reply-To and Cc
  aren't parsed, so replies can't thread.

## Files touched

- `src-tauri/src/integrations/email/imap_client.rs`: the fetch shape,
  timeouts, a session cache, STARTTLS, UIDVALIDITY.
- `src-tauri/src/integrations/email/parser.rs`: HTML-to-text, quote handling,
  the new headers, previews from partial bodies.
- `src-tauri/src/integrations/email/commands.rs`: `call_id`,
  `email_cancel`, and `NormalizedMessage`'s new fields.
- `src-tauri/src/lib.rs`: register `email_cancel` and
  `email_forget_session`.
- `src/lib/components/EmailAccountForm.svelte`: call `email_forget_session`
  on save.
- `src/lib/agent/tools/email.ts`: parallel fan-out, a separate errors list,
  the abort signal wired to cancel, and the hand-written listing types
  (`EmailListing` and `NormalizedMessage` aren't ts-exported).
- Tests in each file; `email.test.ts`; `./scripts/export-ipc-types.sh`.

## Steps

1. **Timeouts.** Wrap every network step in `tokio::time::timeout`:
   - connect and TLS: 15 s;
   - LOGIN: 20 s;
   - SELECT and each FETCH or SEARCH: 30 s.

   A timeout's error names the step and the host, for example "imap.gmail.com
   did not answer LOGIN within 20 s".
2. **Cancellation.**
   - Every command takes an optional `call_id`.
   - A call takes its session out of the cache (step 3) for its duration and
     returns it only on success. An aborted task, which leaves the session
     mid-protocol and raises no error, therefore never puts a broken session
     back.
   - The work runs as a spawned task registered under that id, the same
     pattern as `comfy.rs` `cancellable`.
   - `email_cancel(call_id)` aborts it.
   - In `email.ts`, each tool passes a fresh id and calls `email_cancel` when
     `ctx.signal` aborts.
3. **A session cache.**
   - Keep one authenticated session per account in a
     `Mutex<HashMap<account_key, (Session, Instant)>>`.
   - On reuse, send NOOP with a 5 s timeout and reconnect if it fails.
   - Drop a session after 120 s idle (checked on access) and on any error.
   - Logging out is best-effort.
   - The key is the account id. Saving the account in Settings calls a new
     `email_forget_session(account_id)`, so a changed password or host never
     reuses the old login.
4. **STARTTLS for IMAP.** When the account's IMAP security is STARTTLS,
   connect plain, issue STARTTLS, then upgrade with the same rustls config.
   Plain connections are never allowed.
5. **Cheap lists.**
   - **First fetch:** `UID FETCH <set> (UID FLAGS INTERNALDATE RFC822.SIZE
     ENVELOPE BODYSTRUCTURE)`.
   - **Choose the preview part** from BODYSTRUCTURE: the first `text/plain`,
     else the first `text/html`, skipping parts with an attachment
     disposition.
   - **Second fetch,** grouped by section number: `BODY.PEEK[<part>]<0.4096>`.
   - **Decode** using the part's transfer encoding and charset. HTML goes
     through the new HTML-to-text before the snippet is cut.
   - `has_attachments` and the attachment count come from BODYSTRUCTURE.
   - Whole messages are never downloaded for a list.
6. **Bounded reads.** `fetch_full` (`imap_client.rs:342`) fetches
   `RFC822.SIZE` and BODYSTRUCTURE first.
   - Under 5 MB: fetch the whole message, as today.
   - Over 5 MB: fetch only the chosen text part(s), up to 512 KB, and say in
     the result that attachments weren't downloaded.
   - The existing 40k-character cap on returned text stays.
7. **HTML to text**, by walking `scraper` nodes:
   - skip `head`, `style`, `script` and `template`;
   - block elements (`p`, `div`, `br`, `li`, `tr`, `h1`–`h6`, `table`) end a
     line, and `li` gets "- ";
   - a link whose text differs from its href is written "text (href)";
   - collapse spaces within a line and keep single blank lines between
     blocks.
8. **Quote handling.**
   - Strip only the trailing quoted block: an optional attribution line
     ("On … wrote:" in common locales, "-----Original Message-----") plus
     the contiguous `>` lines after it, to the end of the message.
   - Quotes interleaved with replies stay.
   - The summariser uses the stripped text. `read_full` returns the original.
9. **Headers.** `NormalizedMessage` gains `rfc_message_id`, `in_reply_to`,
   `references: Vec<String>`, `reply_to` and `cc`. The name `message_id`
   already holds our handle (`parser.rs:49`, `:76`; `email.ts:141`).
   - The handle in `message_id` becomes `"<uidvalidity>:<uid>"`.
   - A handle whose UIDVALIDITY no longer matches is refused with "That
     message list is stale — list again".
   - Bare-uid handles from before this change are accepted for one release.
10. **`hours`.** Keep `SINCE <date>` as a coarse server-side filter, then
    drop every message whose Date header is older than now minus `hours`
    (INTERNALDATE when the header is missing or unparseable).
11. **Fan-out** in `email.ts`:
    - query accounts in parallel;
    - the result returns `messages` (merged, sorted, trimmed to
      `max_results`) and, separately, `errors` (one per failing account),
      never mixed in with the messages;
    - defaults unify to 25 everywhere, comments included.

## Build gate

The overview's gate. `check-ipc` must pass.

## Test plan

- **Rust, unit:**
  - fetch-command strings for the list and read paths;
  - preview-part selection: a plain+HTML alternative picks plain; HTML-only
    picks HTML; an attachment-disposition text part is skipped;
  - decoding a quoted-printable and a base64 partial part;
  - HTML-to-text: a style block is removed, paragraphs and list items keep
    their structure, a link becomes "text (href)";
  - quotes: a trailing Gmail-style quote is stripped, and an interleaved
    reply keeps all of its text;
  - header parsing fills the new fields;
  - a stale UIDVALIDITY handle is refused;
  - the `hours` filter drops a message from 3 h ago for `hours: 2`.
- **Rust, timeouts:** a local TCP listener that accepts and never speaks
  makes `connect` fail within the connect timeout, with the host in the
  message.
- **TS, `email.test.ts`:**
  - two accounts are queried concurrently (both calls start before either
    resolves);
  - a failing account appears in `errors` and is never trimmed;
  - an abort calls `email_cancel` with the call's id.
- **Manual, with a real account:**
  - time `email_list_recent` for 25 messages before and after, and record
    both times and the bytes fetched, from the IMAP log, in the commit
    message;
  - read a message with a large attachment, and confirm the attachment is
    not downloaded;
  - summarise a reply-heavy thread.

## Commit

`perf(email): list from headers and a short preview, bound every call, and make reads cancellable`

## Rollback

Revert the commit and re-export the IPC types. Handles in the new form become
unreadable to the old code, so the model has to list mail again. Nothing is
stored.
