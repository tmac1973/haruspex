# Phase 5 — Chat (sketch)

**Depends on:** 4 · **Guide:** `chat` page, `remote-access` page

`stores/chat.svelte.ts` (~1,500 lines) holds one active conversation and one
streaming buffer; the header of `remote/activity.svelte.ts` explains why
remote chat avoided touching it. To watch or drive a conversation from
another screen, turns must be keyed by conversation id, like `CodeSession`.

- Split the per-turn state (streaming content, steps, status, usage) into a
  `ChatSession` keyed by conversation id; the chat tab renders the active one.
  The existing `chat.test.ts` / `chat.recovery.test.ts` must pass unchanged
  in behaviour.
- Add chat ops and events to the phase-2 dispatcher; chat view in the web
  client.
- Decide whether remote chat's guest sessions become ordinary conversations
  run by the same `ChatSession` (likely: it removes `remote/driver.ts`'s
  separate path).
