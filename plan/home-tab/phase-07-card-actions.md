# Phase 07 — Card actions: open, ask about this, draft reply

**Depends on:** 01, 03, 04, 05, 06 · **Enables:** 09 (its item menu and drafts); 08 stays read-only and does
not use these actions

## Goal
Make card items actionable. Every item card gets Ask about this, which opens a
new chat with the item attached. Email items get Open (the full message in a
reader) and Draft reply, which streams an editable draft and sends only
through the existing email review modal. Meetings and news items open their
link.

## Files touched
- `src/lib/home/askAbout.ts` (new) — builds the attachment text and opens a
  new chat.
- `src/lib/stores/chat.svelte.ts` — new `newConversationWithDraft(text)`:
  calls `createConversation()`, makes it active, and sets a pending input
  draft for it.
- `src/lib/components/ChatView.svelte` — on mount or conversation change,
  takes the pending draft (if any) into the input and focuses it.
- `src/lib/agent/inferenceQueue.svelte.ts` — `InferenceConsumer` gains
  `{ kind: 'home'; label: string }` (the Rust side stores the consumer as
  opaque JSON, so no Rust change).
- `src/lib/components/home/ItemActions.svelte` (new) — the per-row action
  menu.
- `src/lib/components/home/EmailReader.svelte` (new) — modal showing
  `email_read_full` output.
- `src/lib/components/home/DraftReply.svelte` (new) — inline draft panel.
- `src/lib/home/draftReply.ts` (new).
- `src/lib/components/home/cards/ImportantEmailsCard.svelte`,
  `MeetingsCard.svelte`, `NewsCard.svelte` — wire actions.
- `docs/guide/home.md`, `docs/guide/integrations.md`.

## Steps
1. `askAbout(cardTitle, item)`: formats the item's source facts (for email:
   `source.from`, `source.subject`, `source.date`, `source.snippet` from
   phase 04; for meetings: `summary`, `start`–`end`, `location`,
   `organizer`, `attendees` from phase 05; for news: `source.title`,
   `source.source`, `source.link`, `summary` from phase 06) as a quoted block
   headed with the card name; calls `newConversationWithDraft`;
   `setActiveTab('chat')`. Nothing is sent until the user presses Enter.
   For email, the full body is not fetched; the user can ask the chat to
   read it with the email tools.
2. Email Open: `EmailReader` calls `email_read_full(account, message_id)` and
   shows headers and body; a Draft reply button inside it does step 3.
3. `draftReply(accountId, messageId, instruction?)`:
   `email_reply_context` gives recipients, subject, threading headers and the
   quoted original. `withInferenceSlot({ consumer: { kind: 'home', label:
   'Draft reply' } }, () => runEphemeralTurn({ userMessage, systemPrompt,
   toolAllowlist: [], interactive: false, workingDir: null, contextSize:
   resolveBackendDescriptor().contextSize, onAssistantDelta, signal }))`.
   It uses the default foreground priority from phase 03, since the user is
   waiting for it.
4. `DraftReply` panel under the row: optional one-line instruction ("decline
   politely"), streaming text into an editable textarea, Stop, Regenerate,
   and Review & send. Review & send calls `askEmailReview` with
   `{ to, cc, subject, body, in_reply_to, references }`; only the modal's Send
   sends. Draft reply is hidden when the account lacks `send_enabled`, with a
   tooltip naming Settings → Integrations → Email.
5. Meetings: row click opens the event's join link if present, otherwise
   nothing; Ask about this on every row. News: headline opens the link; Ask
   about this on every row.
6. Docs: `home.md` actions section, stating Draft reply never sends on its
   own; `integrations.md` one line on Draft reply from Home.

## Build gate
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test`
- `node scripts/guide-check.mjs` passes

## Test plan
- Unit: `askAbout` text for each item kind; no send happens.
- Unit: `draftReply` passes threading headers through to the review draft;
  aborting stops the turn.
- Component: `DraftReply` disables Review & send while streaming; Draft reply
  hidden without `send_enabled`.
- Hand: draft a reply to a real message, edit it, Review & send, cancel in the
  modal — nothing is sent; repeat and send to yourself; the reply threads in
  your mail client.

## Commit
`feat(home): open, ask about and draft replies from Home cards`

## Rollback
Revert the commit. Cards fall back to read-only rows from phases 04–06. No
stored data changes.
