# Phase 02 — SMTP: the reply email

**Depends on:** 01 (it uses the `REPLY_HEADER` constant) · **Enables:** 04
(the pipeline sends answers and failure notes through it)

## Goal

One command that sends a research reply: HTML with a plain-text part, threaded
to the request, marked with `X-Haruspex-Reply`, carrying a Message-ID the
caller chose, and addressed in Rust to the account's own address and nothing
else. No caller can pass a recipient or a header. The PR is labelled
`no-docs`.

## Files touched

- `src-tauri/src/integrations/email/smtp_client.rs`: `send_built_with_id
  (account, message_id, build)`, which `send_built` (:218) now calls with
  `new_message_id(&account.email_address)`.
- `src-tauri/src/integrations/email/request_reply.rs` (new): `build(from,
  message_id, &ReplyInput) -> Result<lettre::Message, String>`, like
  `camera/alert_mail.rs`'s `build`. Pure, with tests.
- `src-tauri/src/integrations/email/commands.rs`: `email_request_reply(account,
  input: ReplyInput) -> ()`.
- `src-tauri/src/integrations/email/mod.rs`, `src-tauri/src/lib.rs`: register.
- `src/lib/ipc/gen/*`: regenerated.

`OutgoingMessage` and `build_message` are not changed; this path builds its
own `lettre::Message`, as camera alerts do.

## Steps

1. `ReplyInput` (`#[ts(export)]`): `reply_message_id`, `request_message_id`,
   `references: Vec<String>`, `subject`, `text`, `html`. The caller generates
   `reply_message_id` (Phase 04 stores it before sending, so a crash mid-send
   is recovered with the same id and never a second one).
2. Validation in `request_reply::build`, all refusing with an error rather
   than cleaning:
   - `reply_message_id` and `request_message_id` pass Phase 01's
     `requests::is_valid_message_id`, the one rule for both phases.
     `reply_message_id`'s domain must be the account address's domain, as
     `new_message_id` makes.
   - `references` entries that fail the check are dropped; the last 20 kept.
   - `subject` with CR or LF is refused; it is capped at 200 characters.
   - `text` and `html` are each capped at 512 KB.
3. Headers: `From` and `To` are both `from` (the account's
   `email_address`, which `send_built_with_id` passes in); no `Cc`, `Bcc` or
   `Reply-To`. Subject is `reply_subject(subject)` (`smtp_client.rs:256`), so
   `Re:` isn't doubled. `In-Reply-To` is the request's id; `References` is the
   kept references plus the request's id. `Message-ID` is `reply_message_id`.
   Adds `REPLY_HEADER: 1` and `Auto-Submitted: auto-replied` (RFC 3834, so
   other autoresponders leave it alone). Headers are set through lettre's
   typed builders only, never from caller strings.
4. Body: `MultiPart::alternative()` with `SinglePart::plain(text)` then
   `SinglePart::html(html)`, both UTF-8.
5. `email_request_reply` calls `send_built_with_id(account, &input.reply_message_id,
   |from, id| request_reply::build(from, id, &input))`, which runs
   `require_sending` (:165) first. It does not append to Sent, matching camera
   alerts: Gmail and Fastmail keep a copy themselves, and the reply reaches the
   account's own Inbox on every provider, which is where Phase 04 looks for it.
6. The HTML is not sanitised here; Phase 04 builds it from Markdown and
   sanitises it.
7. Run `./scripts/export-ipc-types.sh`.

## Build gate

`cargo fmt -- --check`, `cargo clippy`, `cargo test`; `npm run check`; IPC
drift clean.

## Test plan

- Unit: `build` addresses only `from`, whatever the input holds; the sent
  Message-ID is exactly `reply_message_id`; threading headers are right; `Re:`
  isn't doubled; both marker headers are present.
- Unit: a subject with `\r\nBcc: x@y.com` is refused; a request id with a CR
  or a space is refused; a reply id on another domain is refused; bad
  references are dropped, not sent.
- Unit: the body is `multipart/alternative` with text before HTML.
- Unit: `send_built` still produces the same messages for camera alerts (its
  existing tests pass unchanged).
- Manual: call `email_request_reply` from devtools against a real request; on
  the phone it threads under the request and renders the HTML.

## Commit

`feat(email): send threaded HTML replies to the account's own address`

## Rollback

Revert the commit. `send_built` returns to generating its own id, which is
what it did before; nothing else calls the new command until Phase 04.
