# Phase 01 — Verdict Parsing: Strip Reasoning From Final Text

**Depends on:** nothing · **Enables:** no later phase technically requires it, but
it removes most of the exposure the others harden against by ending the
manufactured revise turns — and independently fixes `plan/futures.md` #3's
verification-time complaint

## Goal

`isPlanClean` (`pipeline.ts:329`) matches `startsWith('PLAN OK')` against
`finalText`, but `finalText` retains the model's `<think>…</think>` block, so the
check can never be true for a reasoning model. Every guided-planning run
therefore burns all three `MAX_VERIFY_ROUNDS`, firing a revise turn each round
against files that are already correct. This phase makes `finalText` contain
visible text only, so a clean verdict is recognised and verification ends in one
round. It is the highest-value change in this project and the lowest risk: one
shared helper plus one call site.

## Files touched

- `src/lib/markdown.ts` — add an exported `stripThinkBlocks`, and call it from
  `finalizeStreamText` (line 599-604) before `stripToolCallArtifacts`.
- `src/lib/agent/think-stream.ts` — replace the inline regex pair inside
  `hasStreamingAnswer` (lines 61-63) with the shared helper.
- `src/lib/agent/tools/_helpers.ts` — delete the private `stripThinkBlocks`
  (lines 132-137) and import the shared one; keep `runHelperTurn`'s behaviour at
  line 127 identical.
- `src/lib/agent/runTurn.ts` — add `rawText` to the turn result alongside
  `finalText` (lines 30, 53).
- `src/lib/agent/runEphemeralTurn.ts` — pass the unstripped buffer through as
  `rawText` (line 113 area).
- `src/lib/stores/shell.svelte.ts` — use `rawText` for the stored assistant
  message (line 525) so the shell tab keeps its reasoning display.
- `src/lib/markdown.test.ts` — new cases for `stripThinkBlocks` and for
  `finalizeStreamText` stripping reasoning.
- `src/lib/agent/jobs/types/guided-planning/pipeline.test.ts` — new cases for
  `isPlanClean` against reasoning-prefixed verdicts.
- `src/lib/agent/jobs/types/guided-planning/pipeline.ts` — export `isPlanClean`
  (currently module-private at line 328) so it can be unit tested.

## Steps

1. In `src/lib/markdown.ts`, immediately above `stripToolCallArtifacts` (line
   263), add:
   ```ts
   /** Remove `<think>…</think>` reasoning blocks (closed, or trailing-open). */
   export function stripThinkBlocks(text: string | null | undefined): string {
   	return (text ?? '')
   		.replace(/<think>[\s\S]*?<\/think>/g, '') // closed blocks
   		.replace(/<think>[\s\S]*$/, ''); // a still-open block at the end
   }
   ```
   Both replacements are required: `appendStreamDelta` closes the block once real
   content arrives, but a turn that produces only reasoning leaves it open.
2. Change `finalizeStreamText` (line 599-604) to strip reasoning first:
   ```ts
   return processCitations(stripToolCallArtifacts(stripThinkBlocks(raw)).trim(), fetchedUrls);
   ```
   Order matters — strip reasoning before tool-call artifacts, so a `<tool_call>`
   emitted *inside* a reasoning block is removed with the block rather than
   leaving a stray fragment behind.
3. In `think-stream.ts`, rewrite `hasStreamingAnswer` (line 60-65) to
   `return stripThinkBlocks(buf).trim().length > 0;`, importing from
   `$lib/markdown`. Behaviour is identical — it is the same regex pair.
4. In `tools/_helpers.ts`, delete the private `stripThinkBlocks` (lines 132-137)
   and import the shared export. Line 127's
   `stripThinkBlocks(response.content).trim()` is unchanged apart from the import
   source. The shared helper's signature in Step 1 is already widened to
   `string | null | undefined` for exactly this caller, so no coercion is needed
   at the call site.
5. In `pipeline.ts`, change `function isPlanClean` (line 328) to
   `export function isPlanClean` so it is directly testable. No logic change —
   with `finalText` now stripped, the existing `startsWith` is correct.
6. Preserve the shell tab's reasoning display by adding a second field rather
   than accepting a regression. `shell.svelte.ts:525` puts `result.finalText`
   into a `ChatMessage`, and the renderer turns `<think>` blocks into the
   collapsible reasoning UI via `convertThinkingBlocks` (`markdown.ts:608`) — so
   stripping `finalText` alone would silently remove reasoning from the shell.
   Add `rawText: string` to the result type in `runTurn.ts` (line 30) carrying
   the unstripped `streamingContent`, return it at line 53, thread it through
   `runEphemeralTurn.ts` (line 113), and change `shell.svelte.ts:525` to store
   `result.rawText`. `finalText` stays the clean, machine-matchable text;
   `rawText` is what the UI renders.
7. Point the other `finalText` consumers at the right field. `pipeline.ts:412`
   and `:597` (`recordNote`, which writes DB step output) and
   `autonomous-coding/pipeline.ts:427`/`:438` (`summaryText`) all keep using
   `finalText` — stored step output becomes readable prose instead of reasoning
   walls, which is the desired outcome. Grep for any consumer that inspects
   these strings for `<think>`; if one exists, switch that specific consumer to
   `rawText` rather than reverting the strip. No such consumer is expected —
   this is a verification step with a defined resolution, not an open question.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
```

## Test plan

Automated:

- `stripThinkBlocks` removes a closed `<think>…</think>` block; removes a
  trailing-open `<think>…` with no closing tag; leaves text with no reasoning
  untouched; removes multiple blocks in one string.
- `finalizeStreamText('<think>reasoning</think>\n\nPLAN OK').content === 'PLAN OK'`.
- `isPlanClean('<think>Let me check…</think>\n\nPLAN OK')` is `true`. This is the
  regression test for the actual bug — it fails against current `main`.
- `isPlanClean('<think>…</think>\n\nORDERING: phase 3 depends on phase 5')` is
  `false`. A verifier that found problems must still be treated as unclean.
- `hasStreamingAnswer` retains its existing behaviour — keep the current cases
  passing unmodified.
- A turn result exposes both fields: `finalText` has reasoning stripped and
  `rawText` retains the original `<think>` block.

Manual:

- Shell tab with a reasoning model still shows the collapsible reasoning UI,
  confirming the `rawText` plumbing works end to end.
- Run a guided-planning job against the local reasoning model on a small idea.
  Verification must complete in **one** round. Confirm via the job's step timing
  (Verification should drop from ~41 min to roughly a third) and by checking the
  DB: `sqlite3 ~/.local/share/com.haruspex.app/haruspex.db "SELECT ordering,
  (finished_at-started_at)/60000 FROM job_run_steps WHERE run_id=<new> ORDER BY
  ordering;"`.
- Confirm the phase files' mtimes all fall inside the Planning step's window and
  none are rewritten during Verification — the discrepancy that exposed this bug
  in run 19.

## Commit

```
fix(agent): strip reasoning blocks from finalText so PLAN OK is recognised

isPlanClean matched startsWith('PLAN OK') against finalText, which retains
the model's <think> block — so for any reasoning model the verifier's clean
verdict could never be recognised. Every guided-planning run burned all
three verify rounds and fired a revise turn each round against files that
were already correct.

finalizeStreamText now strips reasoning before tool-call artifacts. The
regex pair already existed twice (think-stream.ts, tools/_helpers.ts);
consolidate into one exported helper in markdown.ts and use it in all three
places. Turn results gain a rawText field carrying the unstripped buffer, so
the shell tab keeps rendering its collapsible reasoning UI.
```

## Rollback

Revert the commit. The change is additive (one new exported function, one new
result field) plus a one-line edit to `finalizeStreamText` and two call sites
swapped to the shared helper, so reverting restores prior behaviour exactly. Safe
to leave partially applied: if only the helper is added and `finalizeStreamText`
is not changed, nothing behaves differently. Keep `rawText` in the same commit as
the strip regardless: they are two halves of one decision, and splitting them
across commits means a bisect can land on a build where `finalText` is stripped
but the shell tab has not yet been repointed, silently losing its reasoning
display.
