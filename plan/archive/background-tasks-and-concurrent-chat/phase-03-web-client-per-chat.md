# Phase 03 — Per-chat busy state in the owner web client

**Depends on:** 01, 02 · **Enables:** nothing later depends on it; it brings
the web client up to the desktop

## Goal

The owner web client (Settings → Remote control's page) reports each chat's
busy state separately, and can send to, steer and stop any chat without
opening it on the desktop. Today it assumes at most one busy chat.

## Files touched

- `src/lib/engine/chat.svelte.ts` — per-chat `busy` / `waiting` / `unread`;
  remove `mustBeFree`; `chat.send` and `chat.stop` take a chat id and don't
  switch the desktop; `watchChats` emits patches for every busy chat.
- `src/lib/engine/types.ts` — `ChatListItem` gains `state: 'idle' | 'queued' |
  'running' | 'starting'` and `unread`; `ChatState` is per chat.
- `src/lib/engine/chatFake.svelte.ts` — the fake follows the new shape.
- `src/web/store.svelte.ts` — replace `busyChat` with a per-chat state map.
- `src/web/components/ChatList.svelte`, `src/web/components/ChatView.svelte`
  — per-chat marks; composer steering while busy.
- The engine tests next to these files — per-chat cases.
- `docs/guide/remote-control.md` — the web page runs conversations at once.

## Steps

1. Engine:
   - `listChats` reports each conversation's run state from `getRun(id)` and
     `unread`.
   - `liveFields(id)` reads that conversation's `ChatRun` (`streamingContent`,
     error, `lastTurnFailed`, `compacting`), not the active one.
2. Remove `mustBeFree`. `chat.send(id, content, images)` calls
   `sendMessageTo(id, …)` (phase 02), which steers when that chat is busy.
   It no longer calls `setActiveConversation`.
3. `chat.stop(id)` calls `cancelGeneration(id)`.
4. `watchChats` subscribes to every run and emits a patch whenever any chat's
   state or stream changes. Streaming text is sent only for the chat the web
   client has open (it says which with the existing open-chat message), so a
   background chat doesn't flood the socket; the others send state changes
   only.
5. Web store: `chatStates: Record<id, ChatListItem['state']>` replaces
   `busyChat`. `ChatList` shows the same three marks as the desktop sidebar.
   `ChatView`'s composer stays enabled and shows queued steering.
6. Unread with the web client:
   - Add `markConversationRead(id)` to `chat.svelte.ts`. It clears
     `conv.unread` in memory and calls `dbSetUnread(id, false)`.
     `setActiveConversation` uses it too, so the desktop sidebar and the DB
     never disagree.
   - Opening a chat on the web calls `markConversationRead(id)`.
   - Phase 02's rule "set unread when a turn commits in a conversation that
     isn't active" becomes "…that isn't being viewed". A conversation counts
     as viewed when it's active on the desktop, or open on a connected web
     client (the engine's open-chat message, held as `webOpenChatId` in
     `engine/chat.svelte.ts` and read through `isConversationViewed(id)`).
7. Guide: one line in `docs/guide/remote-control.md` under the chat section.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `npm run build:web`

## Test plan

- Unit:
  - Two busy runs make `listChats` report both as running.
  - `chat.send` to a busy chat steers it.
  - `chat.stop(B)` leaves A running.
  - `watchChats` streams text only for the open chat.
- Manual:
  - Open the remote page on a phone, start turns in two chats from it, and
    see both marked running.
  - Stop one and the other carries on.
  - The desktop doesn't switch conversations.

## Commit

`feat(remote): per-chat busy state on the web client`

## Rollback

Revert the commit. Frontend and web-client only; no schema or IPC change.
