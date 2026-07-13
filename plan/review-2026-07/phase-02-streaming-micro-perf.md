# Phase 02 — Streaming & compaction micro-perf

**Commit scope:** `perf(agent)` / `perf(chat)` · **Language:** TS · **Depends on:** nothing

Three small O(n²)-removal fixes. The big streaming costs are already solved
(markdown re-parse is throttled to 150 ms in `ChatView.svelte:192-238` — do
not touch that block's behavior).

---

## 1. Latch `hasStreamingAnswer` instead of re-scanning per token

`ChatView.svelte:372` evaluates `hasStreamingAnswer(streamingContent)` in the
template against the **raw** (unthrottled) buffer, so the two full-buffer
regex passes in `think-stream.ts:33-38` re-run on every token — O(n²) over a
long answer. The predicate is monotonic: once an answer exists it never
un-exists within a turn.

**Fix (in `ChatView.svelte`):**

- Add `let streamingAnswerStarted = $state(false);`
- Inside the existing 150 ms throttle effect (:192-238), after updating the
  rendered content: `if (!streamingAnswerStarted && hasStreamingAnswer(buffer)) streamingAnswerStarted = true;`
  Skip the call entirely once true.
- Reset to `false` wherever the throttle effect resets for a new turn
  (the same place `streamingContent` handling starts fresh / `isGenerating`
  turns on).
- Template `:372` uses `streamingAnswerStarted` instead of calling the
  function.

Net effect: at most one regex pass per 150 ms until the answer starts, zero
after.

## 2. Stop rescanning the buffer for `<think>` tags per delta

`think-stream.ts:15-19` (`appendStreamDelta`): the `</think>`-absent case
runs `buf.includes(...)` over the whole accumulated buffer on every content
delta during the reasoning phase.

**Fix:** add two booleans to the stream-state object that `appendStreamDelta`
already threads through (`sawThinkOpen`, `sawThinkClose`). Once a tag has
been found, never `includes()`-scan for it again; while unfound, scan only
the tail window `previousLength - tagLength + delta.length` instead of the
whole buffer. Output must be byte-identical to today — this is pure
memoization.

## 3. Running subtotal in `dropOldestTurns`

`context-budget.ts:273-284` calls
`estimateMessagesTokens(messages.filter(...))` inside its drop loop —
re-`TextEncoder.encode`-ing every surviving message per iteration (O(n²) on
the rare over-budget path).

**Fix:** compute the total estimate once before the loop, then subtract each
dropped message's individual estimate as it's removed. `estimateMessagesTokens`
must remain the single source of the per-message math — expose/reuse its
per-message helper rather than duplicating the byte heuristic.

---

## Tests & acceptance

- `think-stream.test.ts`: add cases asserting identical segmentation output
  for multi-delta streams vs. the pre-change implementation (fixtures:
  `<think>` split across deltas, no-think stream, think-only stream).
- `context-budget.test.ts`: fixture conversation where `dropOldestTurns`
  produces the same kept-set as before; plus one asserting the subtotal path
  handles the "drops everything but system + last turn" boundary.
- No component/UI behavior change — `npm run test` and a manual long
  deep-research turn (streaming stays smooth, answer section appears at the
  same moment it does today).
