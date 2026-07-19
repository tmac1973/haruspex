# Phase 02 — Reject Truncated and Ambiguous Tool Calls

**Depends on:** nothing (Phase 01 is recommended first because it removes most of
the exposure, but nothing here consumes it) · **Enables:** Phase 03, which
rewrites this phase's hard-fail error message once the settings exist

## Goal

This is the phase that fixes the corruption itself. A generation cut short by
the token ceiling produces truncated JSON in `tool_calls[].function.arguments`;
`resolveToolCalls` silently discards it (`parser.ts:205`) and falls through to
regex salvage over the raw content (`parser.ts:210-212`), where the `<function=`
fallback manufactures a plausible-looking call from a fragment — losing a prefix
to duplicate-key overwrite and a suffix to an unclosed-tag match. This phase
makes a truncated or ambiguous call fail loudly and retryably instead of being
salvaged into a corrupt write, without changing behaviour for models that
legitimately use the loose grammar.

## Files touched

- `src/lib/agent/parser.ts` — gate the content fallbacks on `finish_reason`;
  reject duplicate parameter keys in `extractFunctionStyleToolCalls`; surface a
  reason for rejection.
- `src/lib/agent/loop/nudges.ts` — add a truncation retry counter alongside
  `fileWriteRetries` (line 34 area) with its own `MAX_TRUNCATION_RETRIES`.
- `src/lib/agent/loop/iteration.ts` — handle the rejected-call outcome: nudge and
  retry while under the cap, then fail the turn with an actionable error.
- `src/lib/agent/parser.test.ts` — new rejection cases; all existing cases must
  pass unmodified.
- `src/lib/agent/loop/nudges.test.ts` — counter behaviour (create if absent).

## Steps

1. In `parser.ts`, change `resolveToolCalls` to distinguish "no calls" from
   "calls that were rejected". Return a discriminated result rather than a bare
   array:
   ```ts
   export type ToolCallResolution =
   	| { kind: 'calls'; calls: ResolvedToolCall[] }
   	| { kind: 'rejected'; reason: string }
   	| { kind: 'none' };
   ```
   `resolveToolCalls(response)` already receives `finish_reason`
   (`ChatCompletionResponse`, `api.ts:215`) — no signature change is needed.
2. Structured path (lines 197-212): keep parsing each `tool_calls` entry
   defensively, then branch on `finish_reason`.

   When `response.finish_reason === 'length'`:
   - If **any** entry fails `JSON.parse`, return
     `{ kind: 'rejected', reason: 'truncated tool call arguments' }`. Reject the
     **whole response**, including entries that parsed cleanly. The realistic
     truncation shape is a final entry cut off while earlier ones are intact;
     executing the good prefix and dropping the truncated tail is precisely the
     half-success this project exists to eliminate — the model believes it issued
     N calls and only N-1 ran.
   - If **every** entry parses, execute them normally. Valid JSON means the calls
     themselves are structurally complete; the cut fell after them.

   When `finish_reason` is anything else, fall through exactly as today — a
   malformed-but-complete call is a different failure and the existing recovery
   handles it.
3. Content fallbacks (lines 214+): if `response.finish_reason === 'length'`,
   skip both `extractToolCalls` and `extractFunctionStyleToolCalls` entirely and
   return `{ kind: 'rejected', reason: 'response truncated mid tool call' }`. An
   unclosed tag under a `length` finish means truncation, not style. When
   `finish_reason === 'stop'` **the truncation gate does not apply** and the
   fallbacks parse as they do today — this is what preserves the loose grammar
   that `parser.test.ts:215`, `:228`, `:250` and `:262` encode. This is narrower
   than "the fallbacks are unchanged": Step 4 adds duplicate-key rejection, which
   applies under every `finish_reason`.
4. In `extractFunctionStyleToolCalls`, replace the unconditional assignment at
   line 173 (`args[key] = coerceFunctionStyleValue(raw)`) with a duplicate check.
   If `key` is already present in `args`, this call is ambiguous — chunking,
   restating, and self-correction are indistinguishable — so per the project's
   fail-loudly rule we reject rather than guess. Do **not** concatenate.
   Scope the duplicate check **per function block**, not across the whole
   response: `parser.test.ts:250` encodes a single response carrying two
   `<function=…>` blocks, and a global key set would false-reject two calls that
   each legitimately use the same parameter name.
   Propagate the reason by changing the extractor's return type from
   `ParsedToolCall[]` to
   `{ calls: ParsedToolCall[] } | { rejected: string }`, and have
   `resolveToolCalls` map a `rejected` result straight onto its own
   `{ kind: 'rejected', reason }`. A return-type change is preferred over a
   thrown sentinel so the compiler forces the single call site inside
   `resolveToolCalls` to handle it. Apply the same treatment to
   `extractToolCalls` only if a duplicate-key case exists there — it parses JSON
   objects, where duplicate keys are resolved by `JSON.parse` itself, so no
   change is needed.
5. Update both call sites for the new return type: `iteration.ts:477`
   (`forceFinalTool` extraction — treat `rejected` and `none` alike, since that
   path only filters for a named tool) and `iteration.ts:599` (the main path,
   which needs the full distinction).
6. In `nudges.ts`, add `MAX_TRUNCATION_RETRIES = 2` and a private
   `truncationRetries` counter with `needsTruncationRetry()`,
   `consumeTruncationRetry()` and a `truncationRetryCount` getter, mirroring the
   existing `fileWrite*` members at lines 99-111.
7. In `iteration.ts`, handle `kind === 'rejected'` **before** the
   `toolCalls.length === 0` branch at line 661, since a rejected call is not the
   same as no call. While under the retry cap, push a nudge telling the model its
   call was cut off and to re-emit it complete — and log the branch via
   `logDebug('agent', …)` consistent with the existing recovery branches.
8. When the cap is exhausted, fail the turn with an actionable error naming the
   ceiling and the setting that raises it, e.g. *"Response exceeded the
   file-write token ceiling (32768 tokens). Raise Settings → Inference → Max
   response tokens (file writes)."* Phase 03 introduces those settings; until it
   lands, name the constant (`AGENT_LOOP_MAX_TOKENS`) instead. Word the message so
   Phase 03 only has to substitute the number and the settings path.
9. Confirm ordering against `tryContinueOnLength` (`iteration.ts:732`), which
   nudges `'Continue.'` when `state.usedTools && finish_reason === 'length'`.
   That guard only runs in the zero-tool-calls branch, so it cannot collide with
   the new rejection path — but a truncated call must not reach it, or the model
   would be told to continue a call we already rejected.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
```

## Test plan

Automated — the regression tests are the point of this phase:

- **The real incident.** Feed the observed corrupt payload shape — a
  `<function=fs_write_text><parameter=path>…<parameter=content>` block cut off
  mid-CSS-property with no closing tag — with `finish_reason: 'length'`. Assert
  the result is `rejected` and that **no** tool call is produced. This test fails
  against current `main`, which returns an executable call carrying the fragment.
- A **duplicate-free** unclosed `<function=…>` payload with
  `finish_reason: 'stop'` still parses into a call — proving the gate is
  conditional and the loose grammar survives. Use a distinct fixture here, not
  the incident payload: that payload repeats `<parameter=content>`, so under
  Step 4 it is rejected for the duplicate-key reason regardless of
  `finish_reason`. Asserting it "still parses" would contradict Step 4.
- The incident payload with `finish_reason: 'stop'` is rejected — with the
  *duplicate parameter* reason, not the truncation reason. This pins down which
  guard fires for which defect.
- Duplicate `<parameter=content>` appearing twice under `finish_reason: 'stop'`
  is rejected with a duplicate-parameter reason, and specifically does **not**
  silently return only the last value.
- Truncated JSON in structured `tool_calls` with `finish_reason: 'length'`
  returns `rejected` and does not fall through to content salvage.
- Truncated JSON in structured `tool_calls` with `finish_reason: 'stop'` still
  falls through to the fallbacks (unchanged today's behaviour).
- Partial truncation: a response whose **first** `tool_calls` entry parses and
  whose **second** is truncated JSON, under `finish_reason: 'length'`, is
  rejected whole — assert the good first call is **not** executed.
- A response where every entry parses cleanly under `finish_reason: 'length'`
  still executes normally, proving the reject is keyed on parse failure rather
  than on `length` alone.
- **All existing `parser.test.ts` cases pass with no edits.** Any required edit
  means the gate is not conditional enough — treat it as a failure of this phase,
  not as a test to update. Audited against current `main`: no existing fixture
  repeats a parameter key within one function block (`:215` uses
  `accountId`/`messageId`, `:250` spans two separate functions, `:262` uses
  `flag`/`ratio`/`nested`), so the per-block duplicate check in Step 4 leaves
  them all passing.
- Nudge counter: two truncation retries are allowed, the third is refused.

Manual:

- Run a guided-planning job with the token cap deliberately lowered to force
  truncation. Phase 03's settings control does not exist yet, so lower
  `AGENT_LOOP_MAX_TOKENS` (`iteration.ts:54`) to 512 in source and rebuild for
  this test, then restore it. Confirm no phase file is written, the error names
  the ceiling, and no partial file appears in the plan directory.

## Commit

```
fix(parser): reject truncated tool calls instead of salvaging fragments

A generation cut off by the token ceiling left truncated JSON in
tool_calls[].function.arguments. resolveToolCalls silently dropped it and
fell through to regex salvage over raw content, where the <function=
fallback rebuilt a plausible call from a fragment: duplicate <parameter=>
keys overwrote (losing a prefix) and the unclosed-tag match ran to end of
string (losing a suffix). The result was written to disk and reported as a
successful write.

Gate both content fallbacks on finish_reason: unchanged for 'stop', reject
for 'length'. Reject duplicate parameter keys as ambiguous rather than
guessing at chunking. Bounded retries, then an actionable error.
```

## Rollback

Revert the commit. The return-type change touches two call sites
(`iteration.ts:477`, `:599`), so revert the parser, nudges and iteration changes
together — a partial revert leaves a type error and will fail `npm run check`,
which is the desired loud failure. Reverting restores the salvage path and the
corruption risk with it; prefer raising the token ceiling (Phase 03) over
reverting this phase if truncation proves frequent.
