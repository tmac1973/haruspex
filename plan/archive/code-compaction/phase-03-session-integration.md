# Phase 3 — Compact before a turn

**Depends on:** 2 · **Guide:** `code-sessions`, `models`

## Goal

`CodeSession` compacts automatically and sends the model the compacted view.

## As built

Two changes from the first draft:

- Compaction runs **inside `runCodeTurn`**, in the inference slot the turn
  already holds, and not in the store before the turn. The turn knows the
  system prompt there, and a separate queue entry would let another consumer
  in between the summary and the turn it makes room for.
- The UI reads a **`compacting` flag** on the session, not a new
  `CodeSessionStatus`. The status stays `'running'`, so the tab strip, the
  remote web client and `windows.ts` keep their exhaustive switches.

## Changes

### `src/lib/code/runCodeTurn.ts`

- `CodeTurnOptions` gains:
  - `compaction`;
  - `lastUsage` (the session's last `{ promptTokens, contextSize }`);
  - `onCompacting(active)`;
  - `onCompacted(compaction)`.
- `prepareMessages` is split into `prepareSystem` and `assemble(system,
  thread, notice)`. The prompt is `assemble(system, modelThread(…), notice)`.
- In the slot, before `runAgentLoop`:
  `compactionDue(prompt, contextSize, lastPromptTokens)`. That is the
  calibrated estimate, or what the server last counted when the window hasn't
  changed, which also covers the tool schemas. If due, it calls
  `compactCodeThread`; on success the prompt is rebuilt.
- A failure is logged (`logDebug('code', 'compaction failed')`) and the turn
  runs on the whole thread. A stop during summarising ends the turn as
  `'aborted'`, like a stop just after admission. The typed text stays in the
  thread with "Stopped."

### `src/lib/stores/code.svelte.ts`

- `compaction` (`$state.raw`) is restored by the constructor and written by
  `snapshot()`, so `persist()` saves it.
- `compacting` is set through `onCompacting`.
- `onCompacted` sets `compaction` and clears `usage` and `contextNotice`.
- `this.messages` is never cut.

### Guide

- `code-sessions`: a "When a session gets long" section.
- `models`: the summarising line names chats and Code sessions. The page is at
  5,997 of 6,000 bytes.

## Tests (`stores/code.test.ts`)

- A thread over 75% (small `contextSize`, mocked descriptor):
  - the summary call happens before `runAgentLoop`;
  - the loop's messages are system + summary + `messages.slice(at)`;
  - the transcript (`session.messages`) is unchanged;
  - `compaction` is saved.
- The next turn under the threshold does not compact again, and it sends the
  same prefix: the system message is equal between the two turns.
- The summary call fails: the turn runs with the full thread and `lastError`
  stays null.
- Stop while compacting: no compaction saved, and the typed text is given back.
- Reopen (decode) restores `compaction`. A fork before the cut has none.
