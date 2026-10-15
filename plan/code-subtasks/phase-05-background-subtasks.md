# Phase 05 — Background subtasks and notification turns

**Depends on:** 01, 02, 03, 04 · **Enables:** phase 06 (live test)

## Goal

`delegate` takes `background: true`. The tool returns at once, and the child
keeps running after the parent's turn ends: it takes its own inference slot and
is owned by the session, not the turn. When it finishes (with a write child's
changes applied as in phase 04), the session gets a notification turn carrying
its report. Notifications are queued while a turn runs, the same way watched
commands' are, and delivered together once the session is idle. Stop on the
session's turn leaves background children running. Each card's stop button
stops its child, and closing or deleting the session stops them all.

## Files touched

- `src/lib/agent/tools/delegate.ts` — `background` parameter; hands the child
  to the session instead of running it.
- `src/lib/agent/tools/types.ts` — `ToolContext` gains
  `startBackgroundSubtask?: (spec: SubtaskSpec) => string`.
- `src/lib/agent/loop.ts`, `src/lib/agent/loop/context.ts`,
  `src/lib/agent/loop/toolCalls.ts` — carry `startBackgroundSubtask`.
- `src/lib/code/runCodeTurn.ts` — `CodeTurnOptions.startBackgroundSubtask`.
- `src/lib/code/backgroundSubtasks.svelte.ts` (new) — the per-session runner:
  queue, slots, completion list, notification text.
- `src/lib/code/backgroundSubtasks.test.ts` (new).
- `src/lib/code/subtask.ts` — `SubtaskState.background?: boolean` (absent
  means false, as in states saved by phases 02 and 04); `SubtaskStops` records
  whether each child is background;
  `SubtaskSpec` type; a delegate tool that runs a spec, shared by blocking and
  background calls.
- `src/lib/stores/code.svelte.ts` — owns a `BackgroundSubtasks`; updates cards
  in live or saved steps; generalises the idle flush to deliver subtask
  notifications; `busy`-for-hand-off includes running background children;
  `dispose` stops them.
- `src/lib/components/code/CodeTranscript.svelte` — subtask notifications
  render as a collapsed `<details>` like watch notifications.
- `src/lib/code/system-prompt.ts` — parent section mentions background.
- `docs/guide/code-subtasks.md` — background subtasks.

## Steps

1. Factor the body of phase 04's `delegate` flow (worktree, `runSubtask`,
   diff, apply, report text) into `runSubtaskSpec(spec, env)` in
   `subtask.ts`. Blocking calls and background calls both use it. `SubtaskSpec`
   is `{ id, label, task, mode }`. `env` carries what the run needs from the
   session (root, sessionId, wslDistro, backend, effort, requester, write
   guard, slot runner, signal, onState).
2. Schema: `background` (boolean, default false), documented as "return at
   once; you'll get a notification turn with the report when it finishes".
   It is offered whenever `delegate` is.
3. With `background: true`, `delegate` checks the per-turn cap of 8 (shared
   with blocking calls), then calls `ctx.startBackgroundSubtask(spec)`. It
   returns: "Started subtask "<label>" in the background (id <id>). You'll get
   a notification turn when it finishes — do NOT wait or poll for it; carry on
   or finish your answer." The step's `subtask` state is published with
   `background: true` and status `queued`.
4. `BackgroundSubtasks` (one per Code session):
   - Holds running and queued specs, at most 4 running per session; the rest
     wait in FIFO order.
   - Each child has an `AbortController` registered in the session's
     `SubtaskStops` and not linked to any turn's signal.
   - Each child runs inside `withInferenceSlot({ consumer: 'subagent',
     backend })`, its own ticket and never the lender, because it outlives
     the parent's slot. On a capacity-1 lane it waits behind the parent's
     turn and runs once that turn ends, with no deadlock, since the parent
     never waits on it.
   - Applies go through phase 04's per-session apply mutex, so background and
     blocking children of one session never apply at once. The write guard
     is the session's folder lease (`code/folders.ts`), which is per session:
     if a turn of this session holds it, the apply proceeds under that hold
     and leaves it for the turn to release; otherwise the apply acquires it
     and releases it straight after. The retry rule is phase 04's: 2 s while
     another session holds the folder, until it is free or the child is
     stopped (then `kept`, as in phase 04).
   - On finish, appends `{ spec, state, resultText }` to a completed list and
     calls the session's `onBackgroundSubtaskDone`.
5. Card updates: the session's `onState(id, state)` replaces the step whose
   `subtask.id === id`. It looks first in live `searchSteps`, then in
   `messageSteps` (the turn that started it may have ended). After a
   `messageSteps` change it saves the session at the child's end, not on every
   step.
6. Notifications: rename `flushWatchNotifications` to `flushNotifications`.
   It gathers completed watches and completed background subtasks into one
   body. Subtasks get a block that opens with the fixed line "A subtask you
   started in the background has finished.", then label, outcome, report and
   apply result per child. Phase 02's guide sentence "Stop on the session
   stops all of them" becomes "Stop on the session stops the subtasks it is
   waiting for; background subtasks keep running." `isSubtaskNotification` recognises that line.
   `consumeSubtasks(ids)` drops delivered entries. The existing triggers stay
   (idle check, `queueMicrotask` after each turn and after `compactNow`), and
   `onBackgroundSubtaskDone` also triggers it.
7. Lifecycle:
   - `stop()` (the session's Stop) aborts the turn and calls
     `subtaskStops.stopAll({ background: false })`, replacing phase 02's
     `stopAll()` there, so blocking children stop and background children keep
     running. `SubtaskStops.stopAll` gains that optional filter.
   - `dispose` calls `subtaskStops.stopAll()` and waits for background
     children to settle, so stopped write children discard their worktrees
     (phase 03's discard, through phase 04's flow).
   - `handOffSession` refuses (returns false) while background children are
     running or queued, as it already does for a busy session. The move menu
     shows the same "busy" state.
   - `closeSession` and `deleteSession` stop them through `dispose`.
8. Transcript: a user message where `isSubtaskNotification` holds renders
   collapsed, titled "Subtask finished", like watch notifications.
9. Prompt and guide: background is for work the parent doesn't need before
   answering. Stop leaves background subtasks running; stop them from their
   cards or by closing the session; their results arrive as a new turn.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
npm run build:web
```

## Test plan

- `backgroundSubtasks.test.ts`:
  - a fifth child queues until one of four ends;
  - each child acquires its own slot with consumer `subagent`;
  - aborting the parent turn's signal leaves children running;
  - `stop()` stops blocking children but not background ones;
  - `stopAll` stops running and queued children;
  - a finished child lands in the completed list once.
- `code.svelte` store tests (extend the existing session tests):
  - a background child finishing while idle starts one notification turn with
    the fixed line;
  - two finishing during a turn are delivered together after it;
  - a watch and a subtask finishing together share one turn;
  - the card in `messageSteps` updates and is saved;
  - `handOffSession` refuses while one runs;
  - `dispose` stops them.
- `delegate.test.ts`: background returns at once with the id and does not call
  `runSubtask` itself; the cap of 8 counts background calls.
- `CodeTranscript.test.ts`: a subtask notification renders collapsed.
- Manual: with Parallel streams at 1, start a background read subtask and end
  the turn; the child runs after the turn and a "Subtask finished" turn
  follows. With a background write subtask, close the session mid-run and
  confirm its worktree is gone.

## Commit

`feat(code): background subtasks that report back in a new turn`

## Rollback

Revert the commit. Saved threads may hold "A subtask you started in the
background has finished." messages and steps with `background: true`. Reverted
code shows them as ordinary user messages and cards, which is safe. Background
children don't outlive the app, so nothing keeps running after a revert.
