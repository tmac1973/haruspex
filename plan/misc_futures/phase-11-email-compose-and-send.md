# Phase 11 — Email: compose and send, after review

Depends on: 09 (session handling, timeouts, threading headers), 10 (passwords
from the keychain) / Enables: —

## Goal

With **Allow sending** on for an account, the model in Chat can draft a reply
or a new message. Every draft opens a review dialog, where the user sees it
and can edit everything. Only the user's click on **Send** sends it.

**What sending means here:**
- **Threading.** Replies thread correctly (In-Reply-To, References,
  "Re:"), and a copy is saved to the Sent folder.
- **Never automatic** (decision 5). There is no tool that sends without the
  dialog; jobs never get the tool; auto-approve doesn't apply.
- **Sending is still a stub today.** `lettre 0.11` is a dependency and
  `EmailAccount` already has SMTP fields and `sendEnabled`, but
  `smtp_client::send_message` always returns an error, and the account form
  hard-codes `sendEnabled: false`.

## Files touched

- `src-tauri/src/integrations/email/smtp_client.rs`: a real transport, and
  building the message.
- `src-tauri/src/integrations/email/imap_client.rs`: append to Sent; a
  headers-only fetch for the message being replied to.
- `src-tauri/src/integrations/email/commands.rs` and `lib.rs`:
  `email_test_smtp`, `email_send`, `email_reply_context`.
- New `src/lib/stores/emailReview.svelte.ts` and
  `src/lib/components/EmailReviewModal.svelte`, mounted in
  `src/routes/+layout.svelte` beside the other approval modals.
- `src/lib/agent/tools/email.ts`: the `email_compose` tool.
- `src/lib/agent/tools/registry.ts`: gating.
- `src/lib/components/EmailAccountForm.svelte` and
  `settings/EmailSection.svelte`: the toggle, SMTP fields, a send test.
- `README.md`: the Email integration section.
- Tests; `./scripts/export-ipc-types.sh`.

## Steps

1. **SMTP transport.** `send_message(account, msg)` builds lettre's
   `AsyncSmtpTransport<Tokio1Executor>`:
   - implicit TLS for `TlsMode::Implicit` (465), STARTTLS (required, never
     opportunistic) for `TlsMode::Starttls` (587);
   - delete the `send_is_not_implemented_in_phase_10_1` test and the module's
     dead-code allowances;
   - credentials resolved as in phase 10;
   - 30 s timeouts.
   - Errors name the host and the step: "smtp.gmail.com refused the login —
     check the app password in Settings → Email".
2. **`OutgoingMessage`** gains `cc`, `in_reply_to`, `references` and
   `from_name`. The built message has:
   - `Date`;
   - a generated `Message-ID` at the sender's domain;
   - plain-text UTF-8 with a quoted-printable body;
   - `In-Reply-To` and `References` when replying, where References is the
     original's References plus its Message-ID.
3. **Save to Sent.** After a successful send, IMAP-APPEND the raw message to
   the mailbox that LIST reports with the `\Sent` special-use flag.
   - Providers whose server saves sent mail itself skip this. Gmail does, so
     `provider.rs` gets `saves_sent: bool`.
   - Failure is reported as "Sent, but could not save a copy to Sent: …".
     It is not an error.
4. **`email_test_smtp(account)`** connects and authenticates without sending.
   The form runs it on phase 10's explicit Save whenever Allow sending is on.
5. **The account form.**
   - An **Allow sending** toggle, off by default, with the tooltip "Lets the
     assistant draft mail for you to review and send".
   - Turning it on reveals the SMTP host, port and security fields,
     prefilled from the provider preset.
   - `sendEnabled` is saved from the toggle. Remove both hard-coded
     `sendEnabled: false` values: the saved account (around :63-64) and the
     test payload (around :99).
6. **`email_reply_context(account_id, handle)`** does one headers-and-text
   fetch through phase 09's bounded `fetch_full` path, with the
   `rfc_message_id` / `references` fields, and returns:
   - `from`, `reply_to`, `to`, `cc`, `subject`, `date`;
   - `rfc_message_id`, `references`;
   - a quoted plain-text body, capped at 8k characters.
7. **The `email_compose` tool** (category `email`).
   - Arguments:
     - `to?`, `cc?`, `subject?`, `body` (required);
     - `account_id?`, which defaults to the only send-enabled account, and is
       required when there are several;
     - `reply_to?`, a message handle from `email_list_recent`;
     - `reply_all?`, default false;
     - `include_quote?`, default true.
   - **For a reply:**
     1. fill the recipients from Reply-To, else From; with `reply_all`, add
        the original To and Cc minus the user's own address;
     2. subject is "Re: " plus the original subject, unless it already starts
        with "Re:";
     3. append "On <date>, <from> wrote:" and the `>`-quoted original when
        `include_quote` is true.
   - **Gating** (decision 5):
     - `ctx.interactive` must be true; otherwise it refuses with "Sending
       needs you present to review it";
     - auto-approve has no effect: the dialog always shows, whatever
       `isAutoApproveActive()` or code-mode auto-approve say;
     - at least one account must have `sendEnabled`.
   - Then it opens the review (step 8) and returns its outcome:
     - "Sent to <recipients> (Message-ID …)"; or
     - "The user discarded the draft." plus their note, if they wrote one.
   - The schema says the tool **opens a draft for the user to review**,
     not that it sends.
   - **Offered:** only in Chat, only when an account has sending allowed,
     never in a job's allowlist, and never in the Shell tab (which gets no
     email tools). `registry.ts` gains `hasSendableEmail` beside `hasEmail`
     (around :159), and `email_compose` is filtered on it by name. It also
     requires the `interactive` filter flag from phase 07, or the same flag
     added here if 07 hasn't landed.
8. **The review dialog** (`emailReview.svelte.ts`). It follows the
   `memoryApproval` pattern: a store holding a promise, one review at a time.
   - **Fields:**
     - From (an account select when several are send-enabled);
     - To and Cc (editable, validated as addresses);
     - Subject;
     - Body (an editable textarea);
     - the quoted original, collapsed under "Show quoted message".
   - **Buttons:**
     - **Send** calls `email_send` and shows progress, then closes on
       success; on an error it keeps the dialog open with the error shown;
     - **Discard** returns `discarded`;
     - a short "Tell the assistant why (optional)" field is sent with a
       discard.
   - Esc and closing the dialog count as Discard.
   - A reply's draft opens with the cursor at the top of the body.
9. **README.** Replace "There is no sending at all" with a short paragraph:
   - Allow sending is per account;
   - every message is reviewed before it goes;
   - jobs can't send.

## Build gate

The overview's gate. `check-ipc` must pass.

## Test plan

- **Rust:**
  - the built message has Date, Message-ID, and the correct In-Reply-To and
    References for a reply;
  - "Re:" isn't doubled;
  - non-ASCII subjects and bodies encode correctly;
  - the reply recipients for reply and reply-all exclude the user's own
    address.
- **Rust, SMTP against a local fake:** an in-process listener that speaks
  enough SMTP for lettre (EHLO, AUTH, MAIL, RCPT, DATA, QUIT) receives the
  expected message, and a server that never answers fails within the timeout.
- **TS, tool:**
  - refused when not interactive;
  - under auto-approve, the dialog still opens (the tool never sends without
    it);
  - not offered without a send-enabled account, and not in a job allowlist;
  - a reply draft is pre-filled from `email_reply_context`;
  - the result reports sent or discarded with the note.
- **Component, review modal:**
  - the edited To, Subject and Body are what `email_send` receives;
  - an invalid address disables Send;
  - a send error keeps the dialog open;
  - Esc discards.
- **Manual,** with a real account:
  - turn Allow sending on and the SMTP test passes;
  - ask "reply to the last email from <me> saying thanks", review, edit one
    word, and send; the reply threads under the original in the mail client
    and appears in Sent;
  - ask for a new message to yourself, then discard it with a note; the
    assistant acknowledges the note and nothing is sent;
  - confirm a job can't see `email_compose` in its tool list.

## Commit

`feat(email): draft replies and new mail for the user to review and send`

## Rollback

Revert the commit and re-export the IPC types. `sendEnabled` stays in saved
settings, ignored by the old code.

## As built — notes

- **Reply recipients are computed in Rust** (`smtp_client::reply_context`):
  Reply-To else From, never the user's own address (replying to one's own
  message goes to its recipients), and reply-all's Cc less the user and the
  To. `email_reply_context` returns them with the subject, threading
  headers and the quote; the tool only picks.
- **`saves_sent_copy(provider)`** is a function, not a preset field: Gmail
  and Fastmail file sent mail themselves; iCloud, Yahoo and Custom get an
  APPEND. Yahoo is a guess — if its copies show up twice, add it.
- **The Sent mailbox** is the one LIST flags `\Sent`, else a well-known
  name (Sent, Sent Items, Sent Messages, Sent Mail, INBOX.Sent).
- **lettre's per-command timeout does not cover the greeting,** so every
  SMTP call also runs under a 45 s outer limit.
- **`email_send` refuses an account without Allow sending** in Rust too, not
  only in the tool.
- **No `from_name`:** messages go from the bare address; nothing set a
  display name.
- **`interactive` reaches `getToolSchemas`** through the same lines phase 07
  adds, so the two merge cleanly. An allowlist can never include
  `email_compose`.
- **The SMTP fields moved out of Advanced** into a block shown when Allow
  sending is on; Test connection also logs in to SMTP then.
- **`email_compose` lives in `tools/email-compose.ts`**, with its tests.
- **Not done:** the manual checks with a real account.
