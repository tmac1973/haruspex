# Phase 08 — Home in the Remote control web client

**Depends on:** 01, 02, 03, 04, 05, 06 · **Enables:** 09 (its payload and web renderer)

## Goal
Show Home in the Remote control web client, read-only. A phone sees the same
cards in the same order with the same data. Code session rows open that
session in the web client; join and news links open in the phone's browser. No card actions, no adding or
arranging.

## Files touched
- `src/lib/engine/types.ts` — `EngineOp` variant `{ type: 'home.cards' }`;
  event `home-card` (a card's row or result changed).
- `src/lib/engine/home.ts` (new) — answers `home.cards` with each card's
  type, size, title and a render-ready payload: live cards from the same
  sources as phase 01, fetched cards from `last_result`, judged and pinned
  cards from the latest run's `result_json` / step output.
- `src/lib/engine/dispatch.ts` — route `home.cards`.
- `src/lib/stores/homeCards.svelte.ts` and `src/lib/home/fetchedCards.svelte.ts`
  — emit `home-card` on change.
- `src/web/store.svelte.ts` also refetches live cards on the events it already
  follows (`job-run`, `job-run-live`, `job-queue`, session events and
  `prompts.list` changes), so live cards need no new event.
- `src-tauri/src/owner/clients.rs` — `home.cards` in `required_scope()` as
  Read.
- `src-tauri/src/engine/mod.rs` — not in `FANOUT_OPS`; the main window
  answers (cards are app-wide in SQLite).
- `src/web/store.svelte.ts` — `tab` gains `'home'`; load and reduce cards.
- `src/web/App.svelte`, `src/web/SessionList.svelte` — Home entry and view.
- `src/web/home/HomeView.svelte` (new) — lists the cards and picks each
  one's renderer with a `{#if card.type === …}` chain; an unknown type shows
  its title only.
- `src/web/home/*Card.svelte` (new) — read-only renderers per card type; they
  render the payload, not the desktop components.
- `docs/guide/remote-control.md`, `docs/guide/remote-control-api.md`,
  `docs/guide/home.md`.

## Steps
1. Define the payload per card type in `engine/home.ts` so the web side never
   calls Tauri commands: Jobs (current run line, queue depth, five recent
   runs), Code sessions (rows with status), Pinned job (name, status, output
   markdown clamped to 4 KB), Important emails (from, subject, date, why),
   Meetings (events with joinUrl), Weather (current and daily), News
   (headline, link, source, summary).
2. Emit `home-card` events with the card id when a stored card changes
   (added, removed, moved, resized, a new fetched result, a new judged or
   pinned run). The web store refetches `home.cards` on `home-card`, on
   resync, and, for the Jobs and Code sessions cards, on the existing job,
   session and prompt events it already receives.
3. Web UI: Home is the first entry in the web client's list; cards render in
   one column. Code session rows link to that session's view; Join and news
   links open in the phone's browser; nothing else is clickable.
4. Docs: `remote-control.md` (Home is read-only from the phone),
   `remote-control-api.md` (the `home.cards` op and `home-card` event),
   `home.md` (one line).

## Build gate
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `npm run build:web`
- `cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test`
- `node scripts/guide-check.mjs` passes

## Test plan
- Unit: `engine/home.ts` payloads for each card type, including a deleted
  pinned job and a failed judged run.
- Rust: `home.cards` needs Read scope; an unknown op is still rejected.
- Hand: pair a phone; Home shows the desktop's cards in order; a code session
  that asks a question shows Needs attention on the phone; tapping it opens
  that session in the web client.

## Commit
`feat(remote): read-only Home in the web client`

## Rollback
Revert the commit. The web client loses the Home entry; the desktop is
unaffected.
