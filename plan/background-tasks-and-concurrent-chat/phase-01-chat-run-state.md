# Phase 01 — Per-conversation run state in Chat

**Depends on:** nothing · **Enables:** steering and sidebar marks (02), the
web client (03), notice turns into conversations that aren't open (02, 04)

## Goal

Move Chat's turn state from module-level singletons into a `ChatRun` per
conversation, so two conversations can each have a turn running at once with
their own streaming text, Stop, error banner and context gauge. Inference
admission is unchanged: with one local slot the second turn queues and shows
"waiting for the model"; with more slots it runs alongside. Sending in a busy
conversation is still refused in this phase (steering is phase 02).

## Files touched

- `src/lib/stores/chatRun.svelte.ts` (new) — the `ChatRun` class.
- `src/lib/stores/chatRun.test.ts` (new) — unit tests for `ChatRun`.
- `src/lib/stores/chat.svelte.ts` — replace the module-level run state with
  `ChatRun`s; getters take a conversation id or read the active one.
- `src/lib/components/ChatView.svelte` — read the active conversation's run.
- `src/lib/sandbox/sandbox.ts` — take the conversation id as an argument.
- `src/lib/sandbox/worker-manager.ts`, `src/lib/sandbox/worker-pool.ts` — the
  workdir comes from the run's conversation; never evict a worker mid-run.
- `src/lib/agent/tools/sandbox.ts`, `src/lib/agent/tools/memoryWrite.ts`,
  `src/lib/engine/prompts.svelte.ts` — use `ctx.conversationId` (or an
  explicit id), not `getActiveConversationId()`.
- `src/lib/stores/context.svelte.ts` — the gauge shows the active
  conversation's usage.
- `src/lib/engine/chat.svelte.ts` — keep compiling against the new getters,
  with behaviour unchanged (per-chat reporting is phase 03).
- `src/lib/stores/chat.test.ts`, `chat.recovery.test.ts`,
  `chat.compaction.test.ts`, `engine/chatFake.svelte.ts` — follow the new
  shape; add concurrency tests.
- `docs/guide/chat.md` — say that conversations run at the same time and
  queue when the model has one stream.

## Steps

1. Create `ChatRun` in `src/lib/stores/chatRun.svelte.ts`, modelled on
   `CodeSession`'s run fields (`src/lib/stores/code.svelte.ts:113-330`). Its
   `$state` fields:
   - `status: 'idle' | 'queued' | 'running' | 'starting'`, where `starting`
     means waiting for llama-server, replacing `queuedConversation`
   - `compacting`
   - `live: LiveTurn`, reusing `src/lib/code/liveTurn.svelte.ts` for
     `streamingContent`
   - `errorMessage`, `errorTurnId`, `lastTurnFailed`, `contextNotice`
   - `ticket: InferenceTicket | null`

   Its plain fields are `abortController` and `currentTurnId`. A `busy`
   getter is `status !== 'idle' || compacting`.
2. Keep `exhaustiveResearch` module-level: it's the composer toggle, and it
   applies to the next send from the open conversation.
3. In `chat.svelte.ts`, add `const runs = new Map<string, ChatRun>()` (a
   `SvelteMap`) and `runFor(id)`, which creates a run on demand. Delete a
   conversation's run when the conversation is deleted, and cancel the run
   first if it's busy. `clearAllConversations` cancels every busy run.
4. Rewrite `resetTurnState`, `runCurrentTurn`, `buildAgentLoopCallbacks`,
   the startup-queue watcher (l.1346-1376), `cancelGeneration`, `retryLastTurn`,
   `continueTurn` and compaction to take the conversation's `ChatRun` and write
   only to it. `runCurrentTurn`'s finally clears state only if the run still
   owns its `abortController`, as today.
5. Startup queue: several conversations may be `starting`. The watcher
   dispatches every `starting` run when llama-server is ready, and fails all
   of them on a startup error.
6. Getters: `getIsGenerating`, `getIsWaitingForSlot`, `getStreamingContent`,
   `getErrorMessage`, `getErrorTurnId`, `getLastTurnFailed`,
   `getQueuedForStartup`, `getIsCompacting` and `getContextNotice` read the
   active conversation's run, so ChatView keeps its call sites. Add
   `getRun(id)` for the sidebar and the engine.
7. `ensureSendableConversation` refuses only when *this* conversation's run
   is busy. `cancelGeneration(id?)` cancels the given conversation's run, or
   the active one.
8. `setActiveConversation` / `createConversation` no longer clear the error.
   The error belongs to its run and shows whenever that conversation is open.
9. Each `ChatRun` tracks its own context usage and writes to
   `conv.contextUsage` as today. `context.svelte.ts` shows the active
   conversation's usage: `setActiveConversation` already calls
   `restoreContextUsageFor`; a run updates the gauge only while its
   conversation is active.
10. Remove active-conversation reads from turn code:
    - `sandbox.ts`: `runPython(chatId, …)`, `installPackage(chatId, …)`,
      `listSandboxGlobals(chatId)`, `resetSandbox(chatId)` and
      `cancelRun(chatId)`, called with `ctx.conversationId`.
    - `worker-manager.ts`: take the workdir from the owning conversation's
      `workingDir` (the pool passes it in), falling back to `getWorkingDir()`
      only when the conversation has none.
    - `worker-pool.ts`: its LRU (cap 3) skips workers with a run in flight. It
      may go over 3 while more than 3 conversations are running Python.
    - `memoryWrite.ts:140` and `engine/prompts.svelte.ts:82,94`: use the
      conversation id the caller passes.
11. Each turn captures its working directory when it starts (l.1494 already
    reads it). It's stored on the conversation, so changing the folder in
    another conversation doesn't affect a running turn.
12. Video notice flush (`flushVideoNotices`) keeps its current behaviour, open
    conversation only, but checks that conversation's run instead of the
    global flag.
13. `engine/chat.svelte.ts`: map its reads onto the active run so the web
    client behaves exactly as before.
14. Update the guide: `docs/guide/chat.md` gets a short section, "Run several
    conversations at once".

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`

## Test plan

- Unit (`chatRun.test.ts`, `chat.test.ts`):
  - Start a turn in A; switch to B; send in B. Both runs are busy, and each
    run's `streamingContent` receives only its own stream.
  - Stop in B leaves A running.
  - An error in A shows only when A is open.
- Unit: with a fake one-slot lane, B's run is `queued` until A releases.
- Unit: `starting` for two conversations both dispatch when the server is
  ready.
- Unit: the sandbox pool never evicts a worker that has a run in flight.
- Unit: deleting a busy conversation aborts its run.
- Manual (`GDK_BACKEND=x11 npm run tauri dev`):
  - With the local model at one stream, send in A, then in B; B shows waiting,
    then streams.
  - With a remote backend that has parallel slots, both stream at once.

## Commit

`feat(chat): run conversations concurrently`

## Rollback

Revert the commit. It touches only frontend files (no schema or IPC
changes), so reverting restores the singleton store cleanly. Don't leave it
partly applied: the getters and `runCurrentTurn` have to change together.
