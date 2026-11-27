# Phase 08 — Home in the Remote control web client

**Depends on:** 01, 02, 03, 04, 05, 06 · **Enables:** 09 (its payload and web renderer)

## Goal
Show Home in the Remote control web client, read-only. A phone sees the same
cards in the same order with the same data. Code session rows open that
session in the web client; join and news links open in the phone's browser. No card actions, no adding or
arranging.

## Files touched
- `src/lib/engine/types.ts` — `EngineOp` variant `{ type: 'home.cards' }`;
  a `HomeEvent` group in `EngineEvent` with `home-card` (a card's row or
  result changed), and an `isHomeEvent` guard.
- `src/lib/engine/home.ts` (new) — answers `home.cards` with each card's
  type, size, title and a render-ready payload: the Jobs card from the same
  sources as phase 01; fetched cards from `last_result`; judged and pinned cards
  from the latest run's `result_json` / step output. `home.cards` takes no
  id; if it ever does, it gets the `NEEDS_ID` check `dispatchJobs` uses.
- `src/lib/engine/dispatch.ts` — route `home.cards`.
- `src/lib/stores/homeCards.svelte.ts` and `src/lib/home/fetchedCards.svelte.ts`
  — emit `home-card` on change.
- `src/web/store.svelte.ts` drops job and task events today (`if
  (isJobEvent(e) || isTaskEvent(e)) return;`), and treats any other
  non-session event as a prompt event. Step 2 changes both.
- `src-tauri/src/owner/clients.rs` — `home.cards` in `required_scope()` as
  Read.
- `src-tauri/src/engine/mod.rs` — not in `FANOUT_OPS`; the main window
  answers (cards are app-wide in SQLite).
- `src/web/store.svelte.ts` — `tab` gains `'home'`; load and reduce cards;
  `refreshMode()` forces `'chat'` in lean mode, so Home is hidden there as on
  the desktop.
- `src/web/App.svelte`, `src/web/components/SessionList.svelte` — Home entry
  and view.
- `src/web/components/home/HomeView.svelte` (new) — lists the cards and picks
  each one's renderer with a `{#if card.type === …}` chain; an unknown type
  shows its title only.
- `src/web/components/home/*Card.svelte` (new) — read-only renderers per card
  type; they render the payload, not the desktop components.
- `docs/guide/remote-control.md`, `docs/guide/remote-control-api.md`,
  `docs/guide/home.md`.

## Steps
1. Define the payload per card type in `engine/home.ts` so the web side never
   calls Tauri commands: Jobs (current run line, queue depth, five recent
   runs), Code sessions (no payload: the web renderer builds its rows from the
   web store's own `sessions` and `prompts`, which come from the fan-out
   `sessions.list` and `prompts.list`, so the phone also sees detached
   windows' sessions and their Needs attention), Pinned job (name, status, output
   markdown clamped to 4 KB), Important emails (from, subject, date, why),
   Meetings (events with joinUrl), Weather (current and daily), News
   (headline, link, source, summary).
2. Emit `home-card` events with the card id when a stored card changes
   (added, removed, moved, resized, a new fetched result). A new judged or
   pinned run emits no `home-card`; the web store's job-event refetch below
   covers it. In `src/web/store.svelte.ts`:
   - an `isHomeEvent` branch, checked before the prompt branch, refetches
     `home.cards`;
   - the job-event branch, which returns early today, first refetches
     `home.cards` when Home is showing (task events still return as now);
   - session and prompt events also refetch it when Home is showing;
   - resync refetches it.
3. Web UI: Home is the first entry in the web client's list; cards render in
   one column. Code session rows link to that session's view; Join and news
   links open in the phone's browser; nothing else is clickable.
4. Docs: `remote-control.md` (Home is read-only from the phone, not in lean
   mode), `remote-control-api.md` (the `home.cards` op and `home-card`
   event; the page is 11 bytes under the 6 KB limit, so trim it by as much
   as this adds), `home.md` (one line).

## Build gate
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `npm run build:web`
- `cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test`
- `node scripts/guide-check.mjs` passes

## Test plan
- Unit: `engine/home.ts` payloads for each card type, including a deleted
  pinned job and a failed judged run.
- Rust: `home.cards` needs Read scope; an unknown op is still rejected.
- Unit (`src/web`): a `home-card` event refetches cards and leaves
  `prompts` alone; a `job-run` event refetches while Home shows; lean mode
  hides Home.
- Hand: pair a phone; Home shows the desktop's cards in order; a code session
  that asks a question shows Needs attention on the phone; tapping it opens
  that session in the web client.

## Commit
`feat(remote): read-only Home in the web client`

## Rollback
Revert the commit. The web client loses the Home entry; the desktop is
unaffected.
