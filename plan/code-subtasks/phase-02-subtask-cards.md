# Phase 02 — Subtask cards: live steps, stop, saved transcript, web client

**Depends on:** 01 · **Enables:** phase 04 (write-mode cards show diffs and
apply results), phase 05 (background cards)

## Goal

Each `delegate` call shows as a card in the Code transcript: its label and task,
a status (queued, running, done, stopped, failed), the child's own steps live as
it works, and a stop button that stops only that child. The card's data lives on
the delegate call's `SearchStep`, so it is saved in `messageSteps` with no
migration, survives reload, and reaches the Remote control web client through
the engine, where it shows collapsed (task, status, report) with no live steps.

## Files touched

- `src/lib/agent/loop.ts` — `SearchStep` gains optional
  `subtask?: SubtaskState`.
- `src/lib/code/subtask.ts` (new) — `SubtaskState` type and pure helpers
  (`newSubtaskState`, `withChildStep`, `finishSubtask`).
- `src/lib/code/subtask.test.ts` (new).
- `src/lib/agent/tools/types.ts` — `ToolContext` gains
  `toolCallId?: string` (the id of the call being executed),
  `onSubtask?: (state: SubtaskState) => void` and
  `subtaskStops?: SubtaskStops`.
- `src/lib/agent/loop/toolCalls.ts` — set `toolCallId: call.id` on the inline
  `ToolContext`; wire `ctx.onSubtask` to a new
  `options.onSubtaskUpdate(call, state)`.
- `src/lib/agent/loop.ts`, `src/lib/agent/loop/context.ts` — carry
  `onSubtaskUpdate` and `subtaskStops`.
- `src/lib/code/runSubtask.ts` — new options `onStep(steps)` and
  `onAdmitted()`; the `signal` it is given is now the per-child signal.
- `src/lib/agent/inferenceQueue.svelte.ts` — the function `createSlotLender`
  returns takes an optional second argument `{ onAdmitted?: () => void }`,
  called at once when borrowing and on admission otherwise; `ToolContext.runInSlot`'s
  type in `types.ts` widens to match.
- `src/lib/agent/inferenceQueue.test.ts` — `onAdmitted` fires in both paths.
- `src/lib/agent/tools/delegate.ts` — build and publish `SubtaskState`; create
  a per-child `AbortController` linked to the parent signal and register it in
  `ctx.subtaskStops`.
- `src/lib/code/runCodeTurn.ts` — pass `onSubtaskUpdate` and `subtaskStops`
  through `CodeTurnOptions`.
- `src/lib/stores/code.svelte.ts` — own a `SubtaskStops` per session; in
  `onSubtaskUpdate` set `step.subtask` on the matching live step; expose
  `stopSubtask(stepId)`.
- `src/lib/components/code/SubtaskCard.svelte` (new) — the card.
- `src/lib/components/code/SubtaskCard.test.ts` (new).
- `src/lib/components/code/CodeSteps.svelte` — a new block kind for steps with
  `subtask`, rendering `SubtaskCard`; accept a `compact` prop.
- `src/lib/engine/state.ts` — `withDiff` leaves `subtask` untouched;
  `stepsState` strips `subtask.steps` (the web shows no live child steps).
- `src/lib/engine/state.test.ts` — the strip is covered.
- `src/web/components/Transcript.svelte` — pass `compact` to `CodeSteps`.
- `docs/guide/code-subtasks.md` — describe the card and its stop button.

## Steps

1. Define in `src/lib/code/subtask.ts`:
   `SubtaskState = { id: string; label: string; task: string; mode: 'read';
   status: 'queued' | 'running' | 'done' | 'stopped' | 'failed';
   steps: SearchStep[]; report: string | null; error: string | null;
   startedAt: number | null; endedAt: number | null }`, plus pure helpers that
   return new objects (plain JSON — never `$state` proxies, so the snapshot
   and `structuredClone` stay safe). `id` is the delegate tool call's id,
   read from `ctx.toolCallId`.
   Phase 04 widens `mode` and adds apply fields; phase 05 adds `background`.
2. Add `subtask?: SubtaskState` to `SearchStep`. Because steps already save in
   `messageSteps`, cards persist with no snapshot version change and
   `fork_thread` copies them with `messageSteps`.
3. `SubtaskStops` is a class in `subtask.ts`: `register(id, controller)`,
   `stop(id)`, `stopAll()`, `delete(id)`. `delegate.ts` creates an
   `AbortController` per child, aborts it when `ctx.signal` aborts, registers
   it, and passes its signal to `runSubtask`. A child stopped on its own
   returns `outcome: 'stopped'` and its partial report; the parent's batch
   continues.
4. `runSubtask` gains `onStep(steps: SearchStep[])`, called whenever a child
   step starts, progresses or ends, and `onAdmitted()`, passed to
   `runInSlot(fn, { onAdmitted })` or called at once when there is no
   `runInSlot`. `delegate.ts` publishes a fresh
   `SubtaskState` through `ctx.onSubtask` on queued (before the slot is
   granted), running (the lender's `onAdmitted`; immediately when there is no
   lender, since the child then runs in the parent's held slot), every
   `onStep`, and the end.
5. In `toolCalls.ts`, set `onSubtask` on the inline `ToolContext` to
   `(s) => options.onSubtaskUpdate?.(call, s)`. Thread `onSubtaskUpdate` and
   `subtaskStops` through `AgentLoopOptions`, `LoopContext` and
   `CodeTurnOptions`.
6. In `stores/code.svelte.ts`, the session owns `subtaskStops = new
   SubtaskStops()`. `onSubtaskUpdate(call, s)` finds the live `searchSteps`
   entry for `call.id` and replaces it with `{ ...step, subtask: s }`.
   `stopSubtask(id)` calls `subtaskStops.stop(id)`. `dispose` and `stop()`
   call `subtaskStops.stopAll()`.
7. `SubtaskCard.svelte`: header with label, status and elapsed time, plus a
   stop button (title "Stop this subtask") while the subtask hasn't finished
   (queued, running, or any waiting status a later phase adds); the task
   in a `title` tooltip; a collapsible body that renders `CodeSteps` for
   `subtask.steps` (collapsed by default once finished). Done: the report in
   a collapsible section. Stopped: "Stopped" plus whatever partial report
   there is, in the same section. Failed: the `error` text in one line, with
   the steps still expandable. With `compact`, the card shows header and
   report only, without the stop button.
8. In `CodeSteps.svelte`, a step whose `toolName === 'delegate'` and which has
   `subtask` becomes a `subtask` block rendered by `SubtaskCard`. Consecutive
   delegate steps are not grouped into the generic step list.
9. In `engine/state.ts`, `stepsState` maps each step's `subtask` to a copy with
   `steps: []`, so the web client gets status and report only.
10. Update the guide page: subtasks show as cards under the agent's step; stop
    one with its stop button; Stop on the session stops all of them.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
npm run build:web
```

## Test plan

- `subtask.test.ts`: helpers return new plain objects; `SubtaskStops` stops one
  child, all children, and forgets finished ones.
- `delegate.test.ts` (extend): states published in order
  queued → running → done; stopping one child gives `stopped` while a sibling
  finishes `done`; aborting the parent stops both.
- `SubtaskCard.test.ts`: renders each status; the stop button calls
  `stopSubtask` with the id; `compact` hides steps and the button.
- `CodeTranscript.test.ts` (extend): an answer whose `messageSteps` contain a
  delegate step with `subtask` renders a `SubtaskCard` after reload.
- `engine/state.test.ts`: `subtask.steps` is emptied in `stepsState`.
- Manual: in a dev build with Parallel streams at 2 against a parallel-capable
  server, ask for three investigations; watch two run and one queue, stop one,
  reload the window and confirm the cards persist; open the session from
  Settings → Remote control's page and see collapsed cards.

## Commit

`feat(code): show subtasks as cards with live steps and their own stop`

## Rollback

Revert the commit. Saved sessions keep a `subtask` field on some steps; with
the revert, older code ignores the unknown field and renders them as ordinary
steps, so it is safe to leave such data behind.
