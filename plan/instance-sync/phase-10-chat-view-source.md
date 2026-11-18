# Phase 10 — A source interface for the Chat view

**Depends on:** nothing (refactor) · **Enables:** 11 (a remote chat
implements it)

## Goal

`ChatView.svelte` reads the active conversation through ~28 module functions
of `#lib/stores/chat.svelte.ts` (`getActiveConversation`, `getIsGenerating`,
`sendMessage`, `cancelGeneration`, …). Gather those into a `ChatSource`
interface, pass the source to `ChatView` as a prop, and give the local store
a `localChatSource` that forwards to today's functions. Local Chat behaves
exactly as before.

## Files touched

- `src/lib/chat/source.ts` — new: `ChatSource`, `ChatCapabilities`.
- `src/lib/stores/chat.svelte.ts` — export `localChatSource` (a plain object
  of getters and functions over the existing module state).
- `src/lib/components/ChatView.svelte` — `let { source = localChatSource }
  = $props()`; every read and action through `source`; controls guarded by
  `source.capabilities`.
- `src/routes/+page.svelte` — passes the active source (local for now).
- `src/lib/components/ChatView.test.ts` — keeps passing; add a fake-source
  case.

## Steps

1. `ChatSource` members, one per function `ChatView` imports today from
   `chat.svelte.ts` (the import block at the top of `ChatView.svelte`):
   getters (`conversation`, `isGenerating`, `isWaitingForSlot`,
   `isCompacting`, `contextNotice`, `streamingContent`, `errorMessage`,
   `errorTurnId`, `searchSteps`, `sourceUrls`, `exhaustiveResearch`,
   `lastTurnFailed`, `queuedForStartup`, `activeRun`, `remembered`,
   `isRemote`) and actions (`renderStreamingHtml`, `setExhaustiveResearch`,
   `createConversation`, `sendMessage`, `continueTurn`, `cancelGeneration`,
   `retryLastTurn`, `setMemoryEnabled`, `addLocalNote`, `dropSteering`,
   `hasDraft`, `takeDraft`).
2. `ChatCapabilities { deepResearch: boolean; workingFolder: boolean;
   incognito: boolean; screenCapture: boolean; mic: boolean; localServer:
   boolean; openInShell: boolean }`. All `true` locally. `localServer` gates
   the start/stop model server prompt that `ChatView` shows from
   `llamaServer.svelte.ts`.
3. Getters stay reactive: `localChatSource` uses `get conversation() {
   return getActiveConversation(); }` style accessors so runes track them.
4. Hidden, not disabled, when a capability is off.

## Build gate

- `npm run check && npm run lint && npm run test`

## Test plan

- Existing `ChatView.test.ts` and `chat*.test.ts` pass.
- New case: a fake source with all capabilities off renders without deep
  research, folder, incognito, screen capture, mic or server controls, and
  `sendMessage` reaches the fake.

## Commit

`refactor(chat): read the Chat view through a ChatSource interface`

## Rollback

Revert; the default prop is the local source, so nothing else changes.

## As built

- `+page.svelte` is unchanged: `ChatView`'s default `source` is the local one, and phase 11 passes another.
- With `localServer` off, the view treats the model as ready: another computer's chat runs on its own model, so this computer's server neither gates the input box nor shows its CPU-fallback banner.
