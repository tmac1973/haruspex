# Phase 06 — News card

**Depends on:** 01, 02, 03, 04 · **Enables:** 07 (Open and Ask about this on news
items)

## Goal
The second judged card. A `news_digest` job type fetches the user's RSS or
Atom feeds without the model, asks the model once to pick the items that match
the user's interests, and saves validated item ids with a one-line summary.
Headlines, sources and links come from the feeds.

## Files touched
- `src/lib/stores/jobs.svelte.ts` — add `'news_digest'` to `JobType`.
- `src/lib/agent/jobs/types/news-digest/definition.ts` (new).
- `src/lib/agent/jobs/types/news-digest/pipeline.ts` (new).
- `src/lib/agent/jobs/types/news-digest/feeds.ts` (new) — RSS 2.0 and Atom
  parsing with `DOMParser`, and the preset list.
- `src/lib/agent/jobs/types/news-digest/Editor.svelte` (new).
- `src/lib/agent/jobs/types/index.ts` — register after `email_digest`.
- `src/lib/home/cardTypes.ts` — `news` (kind `judged`; fields in step 5).
- `src/lib/components/home/cards/NewsCard.svelte` (new).
- `src/lib/components/home/forms/NewsForm.svelte` (new).
- `docs/guide/home.md`, `docs/guide/jobs.md`,
  `docs/guide/search-and-network.md`.

## Steps
1. Type config: `{ feeds: string[]; interests: string; hours: number
   (default 24); max: number (default 6) }`. `background: true`,
   `supportsSchedule: true`. Stages: Fetch, Pick. The registry entry's
   `defaultSchedule` is `{ kind: 'daily', time: '07:00' }`.
2. Presets in `feeds.ts`: a short list of general and tech feeds with
   published RSS URLs (BBC News world, The Guardian world, NPR News, Ars
   Technica, Hacker News front page). Each URL is checked by hand to return a
   feed before it goes in the list. The form shows them
   as checkboxes plus a custom URL field.
3. Fetch stage: `proxy_fetch` each feed with the network proxy; parse items
   to `{ id, title, link, source, published, summary }`. `id` is the first 16
   hex characters of SHA-256 (`crypto.subtle.digest`) over the feed URL, a
   newline, and the item's guid (or its link when there is no guid), so an
   item keeps its id across runs. `summary` is the first 300 characters of
   the description with tags stripped. Keep items from the last
   `hours`; drop duplicate links; cap at 60 newest. A feed that fails is
   listed in the step output and skipped. No items → save `{ items: [] }`
   with no model turn.
4. Pick stage: `pickWithRetry` (phase 03) with no tools, listing candidates
   with ids, the interests line, and the output shape
   `{"items":[{"id":"…","summary":"…"}]}`, `summary` under 20 words.
   `resultSchema`: idField `id`, fields `{ summary: 'string' }`, `max` from
   config. The pipeline then adds `source: { title, link, source, published,
   excerpt }` (excerpt = the feed summary) from the Fetch data and calls
   `setResult`.
5. Registry entry: `jobType: 'news_digest'`, `notifies: true`,
   `itemLabel: (i) => i.source.title`. Card: items with headline (link), source and age, the model's summary
   under it. Empty ("No matching news."), error and running states work as on the
   phase-04 email card.
6. Add card form (`NewsForm.svelte`): preset feed checkboxes, a custom feed
   URL list, the interests line (placeholder "Local politics, Rust, space"),
   hours, max, and the schedule starting at `defaultSchedule`. Submit calls
   `createCardJob('news', typeConfig, schedule)`.
7. Docs: `home.md` section; `jobs.md` new type; `search-and-network.md` notes
   that feeds are fetched through the network proxy.

## Build gate
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test`
- `node scripts/guide-check.mjs` passes

## Test plan
- Unit: `feeds.ts` with recorded RSS 2.0 and Atom samples, a feed with no
  guid, and HTML in descriptions.
- Unit: pipeline with a fake turn — invented id dropped, links come from the
  feed, one failing feed does not fail the run.
- Hand (9B): add the card with two presets and an interests line; check every
  link opens the article the headline names.

## Commit
`feat(home): news card backed by a feed digest job`

## Rollback
Revert the commit. Existing `news_digest` jobs and cards fall back to the
unknown-type handling: the Jobs tab marks the type unavailable, and Home shows
"Unknown card" through the phase-01 guard.
