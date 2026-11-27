# Phase 1 — A fit that keeps the prefix stable

**Depends on:** — · **Guide:** none (`no-docs`)

## Goal

When the fit has to drop turns, the prompt prefix should change once, not on
every model call. This helps every tab (Chat, Shell, Code, jobs). It matters
most inside one long Code turn, where the fit runs before each of up to
`codeMaxIterations` calls.

## Today

`dropOldestTurns` drops only until the estimate fits the budget exactly. The
next call is over again, so it drops one more message, and so on. Each drop
moves where the kept messages start, and the cache is lost from that point.
The note in the system message (`… N message(s) removed.`) also changes with
every drop, so the cache is lost from the first message on.

## Changes (`src/lib/agent/context-budget.ts`)

- **Headroom.** Once `dropOldestTurns` has to run, it drops down to
  `DROP_TARGET_FRACTION × effectiveBudget` (0.8) rather than to the budget
  itself. The next few calls then fit without dropping anything, and the prefix
  stays as it is. Stubbing tool results and truncating messages keep aiming at
  the budget exactly: they change single messages in place and lose less.
- **A fixed note.** Change it to
  `[Older messages were dropped to fit the context window.]`, without the
  count. It is added only if the leading system message doesn't already
  contain it. The count stays in `ContextManagedInfo.droppedTurns` and in the
  UI notice.

## Tests (`context-budget.test.ts`, `contextEvents.test.ts`)

- After a drop, the estimate is at most 0.8 × the budget.
- Two fits in a row on a growing array, as in a turn adding tool results, drop
  turns only once. The second leaves the system message and the first kept
  message unchanged.
- The note appears once, however many fits run.
- Existing post-condition: the estimate is at most the budget on return.
