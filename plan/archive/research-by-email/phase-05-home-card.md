# Phase 05 — The Email requests Home card

**Depends on:** 03 (it lists rows), 04 (it creates and edits the job, and
reads its run results) · **Enables:** nothing further; this completes the
feature

## Goal

**Home → Add card → Email requests…** creates a Research by email job and
shows its recent requests with their state, so the user can see what was
answered, what failed, and what was ignored and why. The ignored list is how
they notice someone probing the phrase.

## Files touched

- `src/lib/home/cardTypes.ts`: an `email_requests` entry after
  `important_emails` (:117-130): `jobType: 'email_research'`,
  `defaultSchedule` interval 15, `form: EmailRequestsForm`, `component:
  EmailRequestsCard`, `notifies: true`, `itemLabel` "answer".
- `src/lib/components/home/forms/EmailRequestsForm.svelte` (new): account
  (only ones with **Allow sending** and no Research by email job yet; one that
  has a job is listed greyed out, with "Already has a job" in its tooltip),
  trigger phrase with the Phase 04
  warnings, daily limit with a **No limit** option.
- `src/lib/components/home/cards/EmailRequestsCard.svelte` (new) and test.
- `src/lib/engine/home.ts`: list `email_requests` where `important_emails` is
  listed (:158, :266).
- `docs/guide/home.md`: an **Add card → Email requests…** paragraph.
- `docs/guide/email-research.md`: mention the card as the easy way to set it
  up.

`createCardJob` (`src/lib/home/cardJobs.ts:23`) needs no change: the job's
`created_at` already marks the start of the scan window (Phase 04 step 1).

## Steps

1. The card reads `db_email_requests_list(job_id, 20)` when it mounts and after
   each run of its job finishes (the same run-finished hook Important emails
   uses).
2. Each row shows the subject (phrase removed), time, and a state chip:
   **Waiting** (`waiting_sent`), **Researching** (`researching`), **Sending**
   (`sending`), **Answered**, **Failed**, **Ignored**. Ignored and Failed show
   the reason in plain words ("No copy in Sent", "Daily limit", "Research
   failed", "Couldn't send"). A small line shows DKIM, SPF and DMARC as pass,
   fail, none or absent; the full summary is in a `title` tooltip.
3. Clicking an answered row expands the question and answer (Markdown,
   rendered like chat). **Open run** goes to the job run in the Jobs tab.
4. Above the list, one line: the phrase and account ("Email me@acct.com with
   'ask haruspex' in the subject."). With the account's sending turned off,
   the card is greyed out with the reason in its tooltip, like other cards that
   need something first.
5. Desktop notifications come from the card frame's existing "notify on new
   items" (`CardFrame.svelte`, `HomeTab.svelte:157`), fed by the `items` list
   Phase 04 puts in each run's result: one per newly answered request. Ignored
   and failed requests don't notify.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`; the
Guide check passes.

## Test plan

- `EmailRequestsCard.test.ts`: each of the six states renders its chip, and
  Ignored and Failed their reason; expanding shows the answer; an empty list
  shows the setup line only.
- Form: an account without **Allow sending** isn't offered; a weak phrase shows
  the warning; **No limit** saves `dailyLimit: null`.
- Manual: add the card, send a request and a forged one, and watch both appear
  with the right states and one notification for the answer.

## Commit

`feat(home): add an Email requests card for research by email`

## Rollback

Revert the commit. Saved cards of the removed type are dropped by the card
registry on load; their jobs stay in the Jobs tab and keep working.
