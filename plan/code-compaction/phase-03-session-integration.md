# Phase 3 — Compact before a turn

**Depends on:** 2 · **Guide:** `code-sessions` (one line: long sessions summarise older turns); fix `models` line 44, which says only "a conversation"

## Goal

`CodeSession` compacts automatically and sends the model the compacted view.

## Changes

### `src/lib/stores/code.svelte.ts`

- Add `compaction = $state.raw<CodeCompaction | null>(null)`. The constructor
  restores it from the decoded thread, and `snapshot()` writes it.
- Add `'compacting'` to `CodeSessionStatus`. Check every `switch` and label
  over it: the sidebar dot, the header, `busy`.
- In `turn()`, after the folder check and before `runCodeTurn`:
  1. Build `view = modelThread(this)` with the new opening message.
  2. If `shouldCompactCode(view, contextSize)` is true, set status to
     `'compacting'` and call `compactCodeThread` inside `withInferenceSlot`
     with the turn's `abort.signal`.
  3. On success, set `this.compaction`, `this.usage = null` and
     `this.contextNotice = null`.
  4. On failure or empty output, call `logDebug('code', 'compaction failed', …)`
     and carry on.
  5. An abort counts as a turn that never started: `unsend` gives back the
     text, as it does today.
- Pass `thread: modelThread(this)` to `runCodeTurn` in place of
  `this.messages`. `commit` still appends `result.added` to the full
  `this.messages`.
- Steering typed while compacting queues as it does while queued for the slot.

### `src/lib/code/runCodeTurn.ts`

No change: it already takes `thread` as given. The comment on
`CodeTurnOptions.thread` becomes "what the model is sent (see `modelThread`)".

### Forks (`forkSession` / `forkAndOpen`)

No change in TypeScript. Rust's `fork_thread` carries or drops the cut (phase
2). Check that a fork made after the cut reopens with its compaction.

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
