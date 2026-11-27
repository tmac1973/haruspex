# Phase 11 — Another computer's chats in Chat

**Depends on:** 07, 10 · **Enables:** 12, 13

## Goal

Chat's conversation list gains an **On <name>** section per trusted peer.
Opening one shows it in the normal Chat view, badged "Runs on <name>", with
send (and steer while it answers), stop, continue, retry, rename, delete and
memory on/off, as the web page has them. Offline peers show last-known
titles greyed.

## Files touched

- `src/lib/peers/remoteChat.svelte.ts` — new: `remoteChatSource(peer, id):
  ChatSource`.
- `src/lib/stores/activeChatSource.svelte.ts` — new: which source Chat shows
  (local, or a peer's chat); cleared when that peer goes away.
- `src/lib/components/ConversationSidebar.svelte` — peer sections (same rules
  as phase 09's Code sidebar).
- `src/lib/components/ChatView.svelte` — "Runs on <name>" badge from
  `source.peer`.
- `src/routes/+page.svelte` — passes the active source.
- Tests beside new files.

## Steps

1. `remoteChatSource(peer, id)`: follows the chat (`peer.client.followChat`),
   getters from the `ChatMirror` state (`messages`, `busy` →
   `isGenerating`, `waitingForSlot`, `compacting`, `streamingContent`,
   `searchSteps`, `error`, `lastTurnFailed`, `memoryEnabled` →
   `remembered`). `isRemote: false`: in `ChatView` that flag means a guest
   thread and would lock the memory toggle. Fixed values for the rest:
   `errorTurnId: null`, `sourceUrls: []`, `contextNotice: null`,
   `activeRun: null`, `queuedForStartup: false`, `exhaustiveResearch:
   false`. Actions: `sendMessage` → `chat.send`
   (each image first sent through `peer.client.upload` from phase 07, ≤ 8,
   then by hash); `cancelGeneration` →
   `chat.stop`; `continueTurn` → `chat.continue`; `retryLastTurn` →
   `chat.retry`; `setMemoryEnabled` → `chat.memory`; rename and delete →
   `chat.rename` / `chat.delete` from the sidebar. `createConversation` on a
   peer → `chat.new`, then open it.
2. Capabilities: `deepResearch: false`, `workingFolder: false`, `incognito: true` (the incognito toggle is the memory toggle and sends `chat.memory`), `localServer: false`, `openInShell: false`, `mic: true` (speech is
   transcribed on this computer and sent as text), `screenCapture: true` (the
   capture is this computer's screen, uploaded as a picture).
3. `addLocalNote`, `hasDraft`/`takeDraft`: notes and drafts kept in the
   source object, per remote chat, in memory.
4. Sidebar: rows from `listedChats(peer)`; each marked Writing / Waiting /
   New as the web page marks them (from the list item's fields). Offline
   rows greyed; clicking one toasts "<name> is offline."
5. Opening a peer chat sets `activeChatSource`; picking a local chat sets it
   back to `localChatSource`. The local store's active conversation is left
   as it was, so switching back resumes it.

## Build gate

- `npm run check && npm run lint && npm run test`
- `npm run format:check`

## Test plan

- `remoteChat.svelte.test.ts` with a fake `EngineClient`: getters follow
  snapshot and patches; each action sends the right op; images upload then
  send hashes; capabilities as listed.
- `ConversationSidebar` test: peer section present, offline rows greyed,
  removing the peer resets the active source to local.
- `ChatView` test with the remote source: badge shown, folder and deep
  research controls hidden.

## Commit

`feat(peers): show and carry on another computer's chats in Chat`

## Rollback

Revert; the active source falls back to local.

## As built

- A `/name` in another computer's chat is sent as typed (`ChatView` skips
  `runSlash` and this computer's skill menu for a source with `peer`), and
  a built-in's note shows after its messages, as in phase 09.
- While that computer is offline, the view's error says "<name> is offline."
- The source shown leaves the Chat view (back to this computer's) when its
  chat is deleted there, or the computer is removed, rebuilt or the feature
  turned off (`onPeerGone`).
- `ListedChat` gained `waiting`, so a row marks Waiting as the web page does.
