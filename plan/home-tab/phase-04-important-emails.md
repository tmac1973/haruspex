# Phase 04 — Important emails card

**Depends on:** 01, 02, 03 · **Enables:** 07 (email actions)

## Goal
The first judged card. A new `email_digest` job type lists unread INBOX
messages from the last N hours without the model, asks the model once to pick
the important ones by the user's rule, and saves validated message handles
with a one-line reason. The card renders subject, sender and date from IMAP,
never from model text.

## Files touched
- `src-tauri/src/integrations/email/*` — `EmailListing` gains `seen: bool`
  (IMAP `\Seen` in the existing FLAGS fetch); `email_list_recent` gains
  `unseen_only: Option<bool>`.
- `src/lib/ipc/gen/EmailListing.ts` — regenerated.
- `src/lib/stores/jobs.svelte.ts` — add `'email_digest'` to `JobType`.
- `src/lib/agent/jobs/types/email-digest/definition.ts` (new).
- `src/lib/agent/jobs/types/email-digest/pipeline.ts` (new).
- `src/lib/agent/jobs/types/email-digest/Editor.svelte` (new).
- `src/lib/agent/jobs/types/index.ts` — register after `research`.
- `src/lib/home/cardTypes.ts` — `important_emails` (kind `judged`,
  `addable` when an email account is enabled; fields in step 7).
- `src/lib/components/home/cards/ImportantEmailsCard.svelte` (new).
- `src/lib/components/home/forms/ImportantEmailsForm.svelte` (new) — Add card
  form.
- `docs/guide/home.md`, `docs/guide/jobs.md`, `docs/guide/integrations.md`.

## Steps
1. Rust: read the `\Seen` flag where flags are already fetched for listings;
   add the field and the `unseen_only` filter; add a test with a fixture
   listing. Regenerate IPC types.
2. Type config: `{ accountIds: string[]; rule: string; hours: number
   (default 24); max: number (default 8) }`. `background: true`,
   `supportsSchedule: true`, `hasPlannedSteps: false`. Stages: Fetch, Pick.
3. Pipeline, Fetch stage (no model): resolve each id in `accountIds` to its
   `EmailAccount` with `resolveEmailAccounts` (skipping disabled or missing
   accounts, and naming them in the step output), then call
   `invoke('email_list_recent', { account, hours, maxResults: 50,
   unseenOnly: true })` per account. The command lists INBOX only.
   Candidates are `{ id: accountId + '|' + message_id, accountId, messageId,
   from, subject, date, snippet }`. With no candidates, `setResult({ items:
   [] })` and finish without a model turn.
4. Pick stage: `pickWithRetry` from phase 03 with no tools. The prompt lists
   candidates as numbered lines with their `id`, gives the rule, and asks for
   `{"items":[{"id":"…","why":"…"}]}` with at most `max` items, `why` under
   12 words. `resultSchema`: idField `id`, fields `{ why: 'string' }`,
   `max` from config. Known ids are the candidate ids. After it returns, the
   pipeline adds `source: { accountId, messageId, from, subject, date,
   snippet }` to each item from the Fetch data and calls `setResult`. If
   `pickWithRetry` throws, the step fails with its message.
5. The step's markdown `output` is a short bullet list ("subject — why") so
   the run view in the Jobs tab is readable.
6. Editor: account multi-select, rule (one line), hours, max. The registry
   entry's `defaultSchedule` is `{ kind: 'interval', minutes: 30 }`; the Add
   card form starts with it.
7. Registry entry: `jobType: 'email_digest'`, `notifies: true`,
   `itemLabel: (i) => i.source.subject`. Card: reads the latest succeeded
   run's `result_json` (`latestSucceeded` from `getLatestRun`); a failed
   `latest` shows its error above it and renders each item's `source`
   fields (from IMAP, not the model) with `why` under them. Shows "No important
   mail." for an empty list, the error for a failed run, and "waiting" or
   "running" while a run is live. Row click: nothing yet (actions come in
   phase 07).
8. Add card form: account(s), rule (placeholder "From my manager, or about
   invoices"), interval. Submit calls `createCardJob('important_emails', typeConfig, schedule)`.
9. Docs: `home.md` section; `jobs.md` lists the new job type;
   `integrations.md` notes the card under email.

## Build gate
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff
- `node scripts/guide-check.mjs` passes

## Test plan
- Rust: listing carries `seen`; `unseen_only` filters.
- Unit: pipeline with a fake `runJobTurn` — empty inbox skips the model;
  invented id is dropped; malformed JSON retries once then fails; `source`
  fields come from Fetch data even when the model echoes a different subject
  (validation removes the extra field); a disabled account is skipped.
- Component: card states (empty, items, error, running).
- Hand: start a chat turn that runs a long shell command, then press
  Refresh on the card; the Jobs card shows "Waiting for chat" through the
  tool call and the email run starts only after the chat turn ends.
- Hand (9B default model): add the card against a real account with a rule;
  confirm every item is a real unread message; mark one read in another
  client; Refresh; it drops off.

## Commit
`feat(home): important emails card backed by an email digest job`

## Rollback
Revert the commit. Existing `email_digest` jobs become an unknown type, which
the Jobs tab already treats as unavailable; their cards show "Unknown card"
from the phase-01 guard. `seen` on `EmailListing` is additive.
