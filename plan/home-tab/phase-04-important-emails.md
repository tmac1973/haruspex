# Phase 04 — Important emails card

**Depends on:** 01, 02, 03 · **Enables:** 07 (email actions)

## Goal
The first judged card. A new `email_digest` job type lists unread INBOX
messages from the last N hours without the model, asks the model once to pick
the important ones by the user's rule, and saves validated message handles
with a one-line reason. The card renders subject, sender and date from IMAP,
never from model text.

## Files touched
- `src-tauri/src/integrations/email/imap_client.rs` — `LIST_QUERY` gains
  `FLAGS`; `EmailListing` gains `seen: bool`; the listing search adds
  `UNSEEN` when asked.
- `src-tauri/src/integrations/email/commands.rs` — `email_list_recent` gains
  `unseen_only: Option<bool>`.
- `src/lib/ipc/gen/EmailListing.ts` — regenerated.
- `src/lib/stores/jobs.svelte.ts` — add `'email_digest'` to `JobType`.
- `src/lib/agent/jobs/types/email-digest/definition.ts` (new).
- `src/lib/agent/jobs/types/email-digest/pipeline.ts` (new).
- `src/lib/agent/jobs/types/email-digest/Editor.svelte` (new).
- `src/lib/agent/jobs/types/index.ts` — register after `research`.
- `src/lib/components/jobs/JobEditor.svelte` — `typeSectionTitles` entry
  `email_digest: 'Email digest'`.
- `src/lib/home/cardTypes.ts` — `important_emails` (kind `judged`,
  `addable` when an email account is enabled; fields in step 8).
- `src/lib/components/home/cards/ImportantEmailsCard.svelte` (new).
- `src/lib/components/home/forms/ImportantEmailsForm.svelte` (new) — Add card
  form.
- `docs/guide/home.md`, `docs/guide/jobs.md`, `docs/guide/integrations.md`.

## Steps
1. Rust: the listing fetch has no FLAGS today. Add `FLAGS` to `LIST_QUERY`
   (`imap_client.rs`) and read `\Seen` into `seen`; update the
   `LIST_QUERY` test that checks the query's parts. With `unseen_only`,
   the `uid_search` query gains `UNSEEN`, so the server filters. Add a test
   with a fixture listing. Parsing follows mail-parser 1.0 (`AddressList`,
   `PartKind` in `parser.rs`). Regenerate IPC types.
2. Type config: `{ accountIds: string[]; rule: string; hours: number
   (default 24); max: number (default 8) }`. `background: true`,
   `supportsSchedule: true`, `hasPlannedSteps: false`. Stages: Fetch, Pick.
   `pausedByLean` (`types/lean.ts`) pauses every type but research, so this
   job is paused in Lean and Lean + files and its scheduled runs are
   skipped. That matches Home being hidden in lean mode.
3. Pipeline, Fetch stage (no model): resolve each id in `accountIds` by
   filtering `getSettings().integrations.email.accounts` on `id` and
   `enabled`. `resolveEmailAccounts` is not used: it takes one selector and
   returns every account for an empty one. Disabled or missing accounts are
   skipped and named in the step output. Then call
   `emailCall('email_list_recent', { account, hours, maxResults: 50,
   unseenOnly: true }, ctx.signal)` (`agent/tools/email.ts`) per account, so
   a cancelled run stops the IMAP call. The command lists INBOX only.
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
6. Required fields, per the #834 contract: `validate` refuses an empty
   `accountIds` ("Choose an email account.") and an empty `rule` ("Say what
   counts as important."); `missingRequired` returns `['Email account',
   'Rule']` for the same cases. `configDefaults()` leaves both empty, so the
   registry test's blank-config check holds. The Editor sets `required` on
   the account picker and the rule input while they are empty.
7. Editor: account multi-select, rule (one line), hours, max. The registry
   entry's `defaultSchedule` is `{ kind: 'interval', minutes: 30 }`; the Add
   card form starts with it.
8. Registry entry: `jobType: 'email_digest'`, `notifies: true`,
   `itemLabel: (i) => i.source.subject`. Card: renders the latest succeeded
   run's `result_json` (`latestSucceeded` from `getLatestRun`), each item's
   `source` fields (from IMAP, not the model) with `why` under them. When
   `latest` failed, its error shows above those items. "No important mail."
   for an empty list; "waiting" or "running" while a run is live. Row click:
   nothing yet (actions come in phase 07).
9. Add card form: account(s), rule (placeholder "From my manager, or about
   invoices"), interval. Submit calls `createCardJob('important_emails', typeConfig, schedule)`.
10. Docs: `home.md` section, with the card's detail. `jobs.md` and
   `integrations.md` are within a few bytes of the 6 KB page limit, so each
   gets a one-line pointer to the `home` page and loses a sentence of the
   same length elsewhere.

## Build gate
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff
- `node scripts/guide-check.mjs` passes

## Test plan
- Unit: `registry.test.ts`'s `missingRequired` check passes for
  `email_digest` with its blank defaults.
- Rust: listing carries `seen`; `unseen_only` filters.
- Unit: pipeline with a fake `runJobTurn` and `emailCall` routed through
  `invokeRouter` — empty inbox skips the model;
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
