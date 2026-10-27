# Phase 01 — Front-of-queue admission and a slot a turn can give back

**Depends on:** nothing · **Enables:** phase 02 (the agent loop releases and
takes back its slot around long tools)

## Goal

Give the inference gate the two primitives the rest of the plan needs, with no
behaviour change yet: the Rust queue can admit a ticket ahead of every waiting
ticket in its lane, and `withInferenceSlot` hands its `fn` a `HeldSlot` that
can release the slot and take it back (at the front of the queue) while the
turn goes on. No caller uses the `HeldSlot` in this phase, so every turn still
holds its slot from start to end.

## Files touched

- `src-tauri/src/inference_queue.rs`: `Ticket.front`, front-of-queue insert in
  `enqueue`, a `front: Option<bool>` argument on `inference_acquire`, tests.
- `src/lib/agent/inferenceQueue.svelte.ts`: the `HeldSlot` type, `fn(slot)`,
  `release` / `reacquire`, the `onRequeue` option, heartbeat on the current
  request id.
- `src/lib/agent/inferenceQueue.test.ts`: tests for the new behaviour.
- `src/lib/ipc/gen/*` and the generated command list: whatever
  `./scripts/export-ipc-types.sh` regenerates for the changed command.

## Steps

1. **Rust ticket flag.** Add `front: bool` to `Ticket`. Rename `enqueue` to
   `enqueue_with`, with a new `front: bool` parameter, and keep `enqueue` as a
   wrapper that passes `false`, so the existing tests' `q.enqueue(...)` calls
   don't change. When it is false, push as today. When it is
   true, insert the ticket immediately before the first ticket in `tickets`
   that is `Waiting`, in the same lane, and has `front == false`; if there is
   none, push. Returning turns therefore keep first-come order among
   themselves and all go ahead of ordinary waiters in their lane, and `pump`
   (which walks vec order) needs no change. A front ticket never displaces a
   `Running` ticket: `pump` still admits only while the lane is under
   capacity.
2. **Rust command.** `inference_acquire` gains `front: Option<bool>` and
   passes `front.unwrap_or(false)` to `enqueue_with`. Update the module doc comment's
   "Design" list with one bullet: a ticket acquired with `front` goes ahead of
   the lane's waiting tickets (a turn taking its slot back after a long tool).
3. **Rust tests** (in the existing `tests` module, using `enqueue_local` with a
   new `enqueue_local_front` helper):
   - With A running and B, C waiting, a front ticket D is admitted when A
     releases, before B.
   - A front ticket on a full lane stays `Waiting`; the running ticket is not
     touched.
   - Two front tickets D then E, with B waiting: admission order is D, E, B.
   - A front ticket on lane `remote:x` doesn't move ahead of waiters on
     `local`.
   - On an empty lane with free capacity, a front ticket is admitted at once.
4. **Regenerate IPC.** Run `./scripts/export-ipc-types.sh` and commit what it
   changes.
5. **`HeldSlot` type.** In `inferenceQueue.svelte.ts` export:
   ```ts
   export interface HeldSlot {
   	/** Whether the turn holds its slot right now. */
   	readonly held: boolean;
   	/** Give the slot back. A no-op when it isn't held. */
   	release(): void;
   	/** Take a slot again, ahead of the lane's waiting turns. Resolves at once
   	 *  when held; throws AbortError when the turn's signal fires first. */
   	reacquire(): Promise<void>;
   }
   ```
6. **`withInferenceSlot` changes.**
   - The signature becomes `fn: (slot: HeldSlot) => Promise<T>`. Existing
     callers pass `() => …`, which still type-checks, so none change in this
     phase.
   - Keep the current request id in a `let currentReqId`. The heartbeat
     interval beats `currentReqId`, and the `finally` releases
     `currentReqId`.
   - `release()`: if held, set held to false, `invoke('inference_release',
     { reqId: currentReqId })`, and `logDebug('inference', 'slot released',
     { consumer })`.
   - `reacquire()`, in this order:
     1. If held, return.
     2. If the turn's signal has fired, or the slot is finished (below),
        throw `DOMException('Aborted', 'AbortError')`: no new id, no acquire.
     3. If a reacquire is already in flight, return that same promise, so two
        callers never queue two tickets.
     4. Set `currentReqId = nextReqId()` and register an abort listener that
        sends `inference_cancel` for that id.
     5. Call `inference_acquire` with the first acquire's `consumer` and
        window label, a lane and `maxParallel` from a fresh
        `laneFor(backend)` (so a Settings change made while the tool ran
        applies, as a fresh turn would see it), and `front: true`.
     6. Start a 250 ms timer that calls `options.onRequeue?.(ticket)` with the
        waiting ticket (`{ id: currentReqId, consumer, state: 'waiting',
        enqueuedAt }`).
     7. On admission, set held to true and `logDebug('inference', 'slot
        back', { consumer, waitedMs })`. When the signal fired between
        grant and return, throw AbortError. On rejection, throw AbortError
        if the turn aborted (`abortInitiated || signal.aborted`) and rethrow
        the Rust error otherwise (a lease reclaim or window cleanup), as the
        first acquire does.
     8. In a `finally`, in every case: clear the timer, call
        `onRequeue?.(null)` if the timer had fired (so a stopped turn never
        stays marked queued), remove the abort listener, and clear the
        in-flight promise.
   - Add `onRequeue?: (ticket: InferenceTicket | null) => void` to
     `WithSlotOptions`, with a doc comment: called with the waiting ticket when
     a turn taking its slot back has waited 250 ms, and with null when it gets
     the slot or stops waiting. It mirrors `onTicket` / `onAdmitted`, which
     consumers already map to their "queued" state.
   - In `withInferenceSlot`'s `finally`, mark the slot finished: `held`
     becomes false, `release()` does nothing and `reacquire()` throws
     AbortError. A tool that `raceWithAbort` left running after a stop can
     then call `release()` without effect.
7. **TS tests** (`inferenceQueue.test.ts`, with the existing `invoke` mock):
   - `fn` receives a slot with `held === true`.
   - `release()` sends `inference_release` with the first id; a second
     `release()` sends nothing.
   - `reacquire()` after a release sends `inference_acquire` with a new id and
     `front: true`, and `held` is true after it resolves.
   - `reacquire()` while held sends nothing.
   - After a reacquire, the heartbeat and the final release use the new id.
   - `onRequeue(ticket)` fires when admission takes over 250 ms (fake
     timers), with the new id and state `waiting`, followed by
     `onRequeue(null)`; neither fires when it's granted at once.
   - An abort during `reacquire()` sends `inference_cancel` for the new id and
     rejects with AbortError; the `finally` still sends a (harmless) release.
   - An abort while released (no reacquire in flight) makes the next
     `reacquire()` throw AbortError without calling `inference_acquire`.
   - An abort after `onRequeue(ticket)` fired calls `onRequeue(null)`.
   - Two concurrent `reacquire()` calls send one `inference_acquire`.
   - After `fn` returns, `release()` sends nothing and `reacquire()` rejects.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy --all-targets && cargo test inference_queue`
- `./scripts/export-ipc-types.sh` leaves no diff after the commit
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`

## Test plan

- The Rust and vitest cases above.
- Run the dev app once (`GDK_BACKEND=x11 npm run tauri dev`), send a Chat
  message and a Code turn, and check they behave as before. Nothing calls
  `release` yet.

## Commit

```
feat(inference): admit a returning turn first, and let a turn give its slot back

Phase 01 of plan/release-slot-during-tools (#696).
```

## Rollback

Revert the commit. Nothing calls `HeldSlot` or `front` yet, so reverting is
safe on its own. If phase 02 has landed, revert it first.
