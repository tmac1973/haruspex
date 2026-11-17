# Phase 06 — Extract the client store core from the web client

**Depends on:** nothing (refactor) · **Enables:** 07 (peer store reuses it)

## Goal

`src/web/store.svelte.ts` (`WebStore`) both keeps mirrors of the desktop's
sessions, chats and prompts from events and drives the page's UI (tab,
selection, viewer). Split the first part into a shared, transport-agnostic
`EngineClient` in `src/lib/engine/`, so the desktop can keep the same
mirrors of another computer without copying the reducer logic. The web
client behaves exactly as before.

## Files touched

- `src/lib/engine/client.svelte.ts` — new: `EngineClient` class.
- `src/lib/engine/transport.ts` — new: a plain `Transport` interface (not
  `typeof` the `src/web/api.ts` functions), plus `ApiError`, `Connection`
  and `StreamEvent` moved from `src/web/api.ts`. `src/lib` can't import
  `src/web` (no alias, and lint bans relative imports in `src/lib`).
- `src/web/api.ts` — imports and re-exports those from
  `#lib/engine/transport.ts`.
- `src/web/store.svelte.ts` — `WebStore` composes an `EngineClient`; keeps
  only page state (`tab`, `selected`, `selectedChat`, `viewer`, `note`,
  `error`, `homeCards`) and page actions.
- `src/web/components/*.svelte` — read mirrors through `store.client.*`
  where they read them directly today.
- `src/lib/engine/client.test.ts` (no runes in the test, so not `.svelte.test.ts`) — moved/derived from
  `src/web/web.test.ts` cases that test mirror keeping.
- `src/web/web.test.ts` — keeps page-level cases.

## Steps

1. Move into `EngineClient`: `connection`, `lean`, `homeOff`, `chats`,
   `chatMirrors`, `sessions`, `mirrors`, `prompts`; the stream start/stop;
   the list refresh debounce (`LIST_REFRESH_MS`); resync bookkeeping; `op`
   passthrough; `upload`. Constructor takes a `Transport` (`op`, `events`,
   `upload`). Add these, which don't exist today (`WebStore` has
   `select(id)` and `selectChat(id)`, which also set page state):
   - `follow(id)`: what `select(id)` does, minus setting `selected`. It
     still sends `session.open`, which opens the session in a window on the
     computer that owns it, as the web page does today.
   - `unfollow(id)`: deletes the mirror and its resync entry.
   - `followChat(id)` / `unfollowChat(id)`: the same for chats.
   - On `ready`: resync every followed session and chat, not only the
     selected one, and re-read the lists. The `tab === 'home'` reaction
     stays in `WebStore` through `client.onReady(cb)`.
   `WebStore.select(id)` becomes `client.follow(id)` plus `selected = id`.
2. `EngineClient` exposes `onPrompt(cb)` / `onPromptGone(cb)` hooks
   (called when `prompts` gains or loses an entry) for phase 12; the web
   client doesn't use them.
3. `WebStore` creates `new EngineClient(webTransport)` with today's
   `src/web/api.ts` functions and forwards what its components need.
4. No behaviour change: same ops, same events, same timings.
5. `#lib/...` imports with extensions (CLAUDE.md).

## Build gate

- `npm run check && npm run lint && npm run test`
- `npm run build:web`

## Test plan

- All existing `src/web/*.test.ts` pass unchanged in intent (assertions may
  move to the new file).
- New `client.test.ts` with a fake `Transport`: snapshot then patches
  rebuild a session; a seq gap triggers `session.resync`; `ready` resyncs
  followed sessions; list events debounce into one `sessions.list`.
- Hand: `npm run drive -- start --api`, open `web-url`, follow a session and
  send a message.

## Commit

`refactor(web): move the event-mirror core into #lib/engine/client.svelte.ts`

## Rollback

Revert; the web client returns to one class. Nothing else depends on it until
phase 07.
