# Phase 05 — Card history, rollback and source badges

**Depends on:** 01, 02, 03, 04 · **Enables:** 06 and 07 (agent edits are safe
to apply immediately once rollback exists in the UI)

## Goal
Every card shows who last changed it, with a link back to the conversation,
Code session or job that did it. Every card has a History view showing its
revisions, with a preview, and one click restores any revision. This is the
safety net behind letting agents apply changes directly.

## Files touched
- `src/lib/components/notebooks/SourceBadge.svelte` (new):
  - a small badge in `CardFrame`
  - for user edits it shows "Edited" and the time
  - for other sources it shows "From Chat: *<label>*", "From Code: *<label>*"
    and so on, with the full time in a tooltip
  - clicking it opens the source:
    - Chat: `setActiveTab('chat')` then `setActiveConversation(id)`
      (`src/lib/stores/chat.svelte.ts:917`)
    - notebook chat: `openNotebook(notebookId)` with the chat panel open
      (phase 07 adds the case)
    - Code: `setActiveTab('code')` then `openSession(id)`
      (`src/lib/stores/code.svelte.ts:1443`)
    - Jobs: `setActiveTab('jobs')` then `selectJob(jobId, runId)`
      (`src/lib/stores/jobsTabSelection.svelte.ts:38`); the source `ref` for
      jobs is `"<jobId>:<runId>"`
    - Shell: the Shell tab
  - a deleted source shows the label with no link
- `src/lib/components/notebooks/CardHistory.svelte` (new):
  - a popover listing revisions (time and source)
  - selecting one previews it read-only with the card's own component
  - "Restore this version" calls `notebook_card_rollback` with
    `source {kind:'user'}`
- `src/lib/components/notebooks/CardFrame.svelte`: mount the badge, and add
  "History…" to the card menu.
- `src/lib/components/notebooks/cards/*.svelte`: accept a `readonly` prop for
  previews.
- `src/lib/notebooks/source.ts` (new):
  - `describeSource(source)` returns the label text
  - `openSource(source)` performs the navigation
  - `sourceFromToolContext(ctx)`: phase 06 needs it, defined here so the
    mapping lives in one place
- `src/lib/notebooks/source.test.ts` (new).
- `docs/guide/notebooks.md`: an "Undo an agent's change" section.

## Steps
1. Write `source.ts` and its tests.
   - `sourceFromToolContext` maps the tool context's surface to a kind:
     - Chat → `chat` with the conversation ID and title
     - Shell → `shell`
     - Code → `code` with the session ID and title
     - a job run → `job` with the job ID and name
     - phase 07 adds the `notebook_chat` surface to this mapping when it
       creates that surface
2. Build SourceBadge and CardHistory, and add `readonly` to the five card
   kinds (text, table, checklist, attachment, image). Python cards (phase 08) add it when they are built.
3. After a rollback, reload the card and show the toast "Restored the version
   from <time>." The rollback itself is a revision, so it can be undone too.

## Build gate
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Unit: `describeSource` for every kind, and `sourceFromToolContext` for each
  surface (with mock contexts).
- Manual:
  1. Edit a table 5 times within a minute: History shows one grouped entry.
  2. Restore it, then restore the rollback entry: back to the edited state.
  3. A card whose source is a deleted conversation shows a label without a
     link.

## Commit
`feat(notebooks): show each card's source and restore earlier versions`

## Rollback
Revert the commit. History keeps being recorded by phase 01 regardless, and
only the UI goes away.
