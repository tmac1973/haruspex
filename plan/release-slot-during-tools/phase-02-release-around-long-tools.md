# Phase 02 — Give the slot back while a long tool runs

**Depends on:** phase 01 (`HeldSlot`, `front` admission, `onRequeue`) ·
**Enables:** phase 03 (releasing at once when a tool waits on the user)

## Goal

Every agent loop that holds a slot gives it back once a tool batch has run
for 5 seconds, and takes it back, at the front of its lane's queue, before it
next needs the model. Tools that call the model themselves keep the slot.
Chat, Code, Shell, jobs, remote guests and Code's background subtasks all pass
their `HeldSlot` into the loop, and the ones with a "queued" state show it
again while a returning turn waits. This is the phase users notice: a long
command, a blocking picture or a slow MCP call no longer stops other
conversations.

## Files touched

- `src/lib/agent/tools/types.ts`: `usesModel?: true` on `ToolRegistration`;
  the `SlotLender` callback takes an optional `HeldSlot`.
- `src/lib/agent/tools/delegate.ts`, `src/lib/agent/tools/web.ts`
  (`research_url`), `src/lib/agent/tools/email.ts`
  (`email_summarize_message`): set `usesModel: true`.
- `src/lib/agent/tools/registry.ts`: `toolUsesModel(name)`, re-exported from
  `src/lib/agent/tools/index.ts`.
- `src/lib/agent/tools/usesModel.test.ts` (new): the guard below.
- `src/lib/agent/loop/slotRelease.ts` (new) and `slotRelease.test.ts` (new):
  the per-batch timer.
- `src/lib/agent/loop.ts`: `slot?: HeldSlot` on `AgentLoopOptions`.
- `src/lib/agent/loop/context.ts`: `slot?: HeldSlot` on `LoopContext`, copied
  from the options in `buildLoopContext`.
- `src/lib/agent/loop/toolCalls.ts`: run each batch under the timer; take the
  slot back before a model-using batch and before returning.
- `src/lib/agent/runEphemeralTurn.ts`: `slot?: HeldSlot` on
  `EphemeralTurnOptions`, passed to `runTurnCore`.
- `src/lib/agent/inferenceQueue.svelte.ts`: `createSlotLender`'s inline
  return type and body take `fn: (slot?: HeldSlot) => Promise<T>`, and the
  queued borrower's `HeldSlot` is passed to `fn`.
- `src/lib/stores/chat.svelte.ts`: pass the slot to `runAgentLoop`, map
  `onRequeue` to `run.waitingForSlot`.
- `src/lib/code/runCodeTurn.ts`, `src/lib/stores/code.svelte.ts`: pass the
  slot; `onRequeue` sets `ticket` / `status` as `onTicket` / `onAdmitted` do.
- `src/lib/shell/runShellTurn.ts`, `src/lib/stores/shell.svelte.ts`: the same,
  with `this.ticket`.
- `src/lib/agent/jobs/runner.svelte.ts`: pass the slot in both
  `withInferenceSlot` calls (the job turn and the tool-feedback turn); the job
  turn's `onRequeue` sets `current.waitingForSlot`.
- `src/lib/remote/driver.ts`: pass the slot; no `onRequeue`.
- `src/lib/code/runSubtask.ts`, `src/lib/code/backgroundSubtasks.ts`: a
  background subtask (its own slot) passes its `HeldSlot` into its loop.
- `docs/guide/chat-conversations.md`: one sentence.
- `docs/guide/code.md`: the session-dot sentence, with two trims to stay
  under 6,000 bytes.
- `src/lib/agent/jobs/runner.fixtures.ts` and the test files that
  `vi.mock` `withInferenceSlot`: the stand-in hands `fn` a fake `HeldSlot`.
- Tests beside each changed source, listed under Test plan.

## Steps

1. **Mark the model-using tools.** Add to `ToolRegistration`:
   `/** Calls the model while it runs, in the turn's slot; the turn keeps its
   slot for it. */ usesModel?: true;`. Set it on `delegate`, `research_url`
   and `email_summarize_message`. Add
   `toolUsesModel(name: string): boolean` to `agent/tools/registry.ts`, beside
   `registerTool`, reading the `tools` map, and re-export it from
   `agent/tools/index.ts`. An unknown name (an MCP tool) is false.
2. **Guard test.** `usesModel.test.ts` reads every `src/lib/agent/tools/*.ts`
   that isn't a test (with `import.meta.glob(..., { query: '?raw' })`), and
   for each file that mentions `runSubAgent(`, `runSubtask(`,
   `runSubtaskSpec(`, `runInSlot`, `chatCompletion(`, `runTurnCore(`,
   `runEphemeralTurn(` or `runAgentLoop(`, asserts that it also contains
   `usesModel: true`. The check is per file, not per tool: it catches a
   file that reaches the model with no flag at all (in `web.ts`,
   `research_url`'s flag satisfies it), and the per-tool flags themselves
   are reviewed by hand. `_helpers.ts` (where `runSubAgent` is defined),
   `types.ts` and `index.ts` are skipped by name. A new model-using tool that
   forgets the flag fails CI.
3. **The timer** (`loop/slotRelease.ts`):
   ```ts
   export const SLOT_RELEASE_AFTER_MS = 5_000;
   /** Run one tool batch; give the turn's slot back if it is still running
    *  after SLOT_RELEASE_AFTER_MS. Does not take the slot back. */
   export async function runReleasingSlot<T>(
   	slot: HeldSlot | undefined,
   	run: () => Promise<T>
   ): Promise<T>
   ```
   When `slot` is undefined or not held, it just awaits `run()`. Otherwise it
   starts a `setTimeout(() => slot.release(), SLOT_RELEASE_AFTER_MS)` and
   clears it in `finally`. It never reacquires: the caller decides when the
   model is needed again.
4. **The loop.** In `executeToolCalls` (`toolCalls.ts`), replace the batch loop
   with:
   - For each batch from `planToolBatches(toolCalls)`: if any call in it has
     `toolUsesModel(call.name)`, first `await ctx.slot?.reacquire()`, then
     run the batch as today with no timer. Otherwise run it inside
     `runReleasingSlot(ctx.slot, () => runToolBatch(...))`.
   - After the last batch, `await ctx.slot?.reacquire()`, so the loop always
     holds the slot when `executeToolCalls` returns. That covers every model
     call that follows: the next iteration, in-loop trimming, the forced final
     answer and recovery.
   - The slot stays released between consecutive batches that don't use the
     model, so a run of slow commands releases once and takes it back once.
   - `reacquire()` throws AbortError on a stop, which leaves through the same
     path as a tool aborted by `raceWithAbort`.
   - The end-of-tools reacquire also runs when the iteration then ends with
     no model call (the forced-final branch in `iteration.ts`). That costs a
     turn which is about to finish one wait for the slot; accepted, since it
     keeps one rule: the loop holds its slot whenever `executeToolCalls` has
     returned.
5. **Plumb the slot.** `AgentLoopOptions.slot?: HeldSlot` (doc: "The turn's
   inference slot. The loop gives it back while long tools run; omitted, it
   never does.") is copied into `LoopContext.slot` in `buildLoopContext`
   (`loop/context.ts`). `runTurnCore` already forwards `AgentLoopOptions`
   through `TurnLoopOptions`. Add `slot` to `EphemeralTurnOptions` and pass
   it on.
6. **Consumers.** In each `withInferenceSlot` call that runs an agent loop,
   change `() => …` to `(slot) => …` and pass `slot`:
   - `stores/chat.svelte.ts` (the turn at `runAgentLoop`), with
     `onRequeue: (t) => (run.waitingForSlot = t !== null)`. The compaction
     call at `compactConversation` takes no slot: it is one model call.
   - `code/runCodeTurn.ts`, with `onRequeue: o.onRequeue`; add
     `onRequeue` to its options. `stores/code.svelte.ts`'s turn passes
     `onRequeue: (t) => { this.ticket = t; this.status = t ? 'queued' :
     'running'; }`. The compaction at `withInferenceSlot` near
     `contextSize` (one model call) and `sessionTitle.ts` take no slot.
   - `shell/runShellTurn.ts`: pass `slot` into `drive` and its
     `runTurnCore`; add `onRequeue` to `ShellTurnOptions`.
     `stores/shell.svelte.ts` passes `onRequeue: (t) => (this.ticket = t)`.
   - `agent/jobs/runner.svelte.ts`: the job turn passes `slot` to
     `runEphemeralTurn` and `onRequeue: (t) => { if (current && current.id
     === runId) current = { ...current, waitingForSlot: t !== null }; }`,
     the same guard its `onAdmitted` uses. The tool-feedback turn
     passes `slot` and no `onRequeue`.
   - `remote/driver.ts`: pass `slot`; no `onRequeue`, since the guest's
     waiting signal is only for the start of a turn, and the guest sees the
     tool step still running.
   - Memory (`dedupe.ts`, `extraction.ts`) runs no tools; unchanged.
7. **Subtasks.** Change `SlotLender` to `<T>(fn: (slot?: HeldSlot) =>
   Promise<T>, opts?) => Promise<T>`. In `createSlotLender`, the borrowed
   path calls `fn()` (the parent's slot isn't the child's to give back) and
   the queued path calls `withInferenceSlot(..., (slot) => fn(slot))`.
   `backgroundSubtasks.ts`'s `ownSlot` does the same. In `runSubtask.ts`,
   `run(async (slot) => …)` passes `slot` into `pass`, which passes it to
   `runTurnCore`; the no-lender fallback calls `fn()` with none. A
   foreground child inside its parent's slot therefore never releases (its
   parent is in `delegate`, which keeps the slot), and a background subtask
   with a slot of its own releases like any turn.
8. **Guide.** In `docs/guide/chat-conversations.md`, "Run several
   conversations at once", change "the second waits for the first to finish"
   to say the second waits for the first, except while the first runs a tool
   for more than a few seconds (a command, a picture, a slow server), when
   the second goes ahead. Keep it to one sentence. The page stays under
   6,000 bytes (it is about 3,000).
   In `docs/guide/code.md`, "Steer or stop the agent", replace "waiting for
   another turn (hollow): only one turn uses the model at a time." with
   "waiting for the model (hollow), which one turn uses at a time; a turn
   lets go of it while a tool runs over a few seconds." To stay under 6,000
   bytes (it is 5,996), drop ", even across windows" after "lasts until its
   tab closes", and drop the line "The list on the left holds every session;
   see the `code-sessions` page." (the page already points there under
   "Start a session"). Check with `wc -c`.

## Build gate

- `npm run check`, `npm run lint` (no new warnings), `npm run format:check`,
  `npm run test`
- `node scripts/guide-check.mjs` (or the `Guide` CI check) passes with the
  guide change

## Test plan

- `slotRelease.test.ts` (fake timers): a run shorter than 5 s never calls
  `release`; a longer one calls it once at 5 s; no slot, or one not held,
  runs plainly; the timer is cleared when `run` throws.
- `toolCalls.test.ts` (or a new `toolCalls.slot.test.ts`) with a fake
  `HeldSlot` that records calls:
  - A 6 s tool (fake timers) gives one `release`, then one `reacquire` before
    `executeToolCalls` resolves.
  - A 1 s tool gives neither.
  - Two slow batches in a row: one `release`, one `reacquire`, at the end.
  - A slow batch followed by a `research_url` batch: `reacquire` before
    `research_url` starts, and `research_url` runs with the slot held.
  - A batch with `delegate` never releases, however long it runs.
  - Abort during the tool after release: the loop throws AbortError, and the
    fake's `reacquire` isn't left pending.
- `usesModel.test.ts`, as in step 2.
- `inferenceQueue.test.ts`: a queued borrower's `fn` gets a `HeldSlot`; the
  borrowed one gets none.
- The `withInferenceSlot` stand-ins (`runner.fixtures.ts` and the test files
  that mock it) pass `fn` a fake `HeldSlot`, so consumer tests can assert the
  loop options carry it: Chat, Code, Shell, the job turn and the remote
  driver each pass `slot` through.
- Store tests where they exist (`chat`, `code`, `shell`): `onRequeue` with a
  ticket shows the queued or waiting state, and with null clears it.
- **Live, dev build, local llama-server with Settings → Inference → Parallel
  streams at 1** (Remote control API on 8788 for Chat, by hand for Code):
  - In a Code session, ask it to run `sleep 30`. Once the command has run 5
    seconds, send a message in a Chat conversation. It answers while the
    command runs; the debug log shows `slot released` and then `slot back`
    for the Code turn.
  - Send a second Chat message so it is still answering when `sleep` ends:
    the Code session shows queued, then continues ahead of a third Chat
    message sent in the meantime.
  - In Chat, a blocking picture on toolchest (no `background`): another
    conversation answers while it renders.
  - In Chat, `research_url` on a slow page, with another conversation sent
    meanwhile: no deadlock, and the summary still arrives.
  - Stop the Code turn during `sleep`, and again while it waits to come back:
    it stops at once, and the queue snapshot (`inference_queue_snapshot`) has
    no ticket left for it.

## Commit

```
feat(agent): give the inference slot back while a long tool runs

Phase 02 of plan/release-slot-during-tools (#696).
```

## Rollback

Revert the commit: the loop goes back to holding the slot for the whole
turn, and phase 01's primitives stay unused and harmless. If phase 03 has
landed, revert it first, since it calls the release this phase plumbs.
