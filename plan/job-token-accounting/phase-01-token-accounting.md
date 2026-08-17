# Phase 01 — Accumulate and Persist Per-Phase Token Stats

Turns the existing half-built accounting into a complete per-step record that
survives the run. No UI in this phase beyond keeping what's there working.

## Steps

### 1. Read the exact reasoning split when the backend reports it

`Usage` (`api.ts:205`) parses three fields. OpenAI-shaped backends —
OpenRouter included — also send:

```jsonc
"usage": {
  "prompt_tokens": 5123,
  "completion_tokens": 800,
  "completion_tokens_details": { "reasoning_tokens": 612 }
}
```

Add it as optional, and mirror it in the streaming usage path
(`iteration.ts:629`) which reads the same object:

```ts
export interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	/** Present on OpenAI-shaped backends; llama.cpp does not report it. */
	completion_tokens_details?: { reasoning_tokens?: number };
}
```

`reportCall` (`iteration.ts:289`) prefers it over the character-ratio estimate
and says which it used:

```ts
const exact = args.usage.completion_tokens_details?.reasoning_tokens;
ctx.options.onCallStats?.({
	...,
	reasoningTokens: exact ?? Math.round(args.usage.completion_tokens * share),
	reasoningExact: exact !== undefined,
	promptTokens: args.usage.prompt_tokens
});
```

Keep the character-ratio path exactly as it is for the millisecond split —
no server reports that, and it stays an estimate regardless.

### 2. Accumulate what the step actually spent

`CallStats` gains `promptTokens` and `reasoningExact`; `StepThinkingStats`
(`runner.svelte.ts:167`) gains the sums the card needs:

```ts
export interface StepThinkingStats {
	reasoningMs: number;
	totalMs: number;
	reasoningTokens: number;
	totalTokens: number;      // completion tokens, summed
	promptTokens: number;     // NEW — summed across calls: tokens processed
	peakPromptTokens: number; // NEW — high-water mark of a single call
	/** False once any call in the step had to estimate the split. */
	reasoningExact: boolean;  // NEW
	calls: number;
}
```

`addCallStats` (`runner.svelte.ts:176`) folds them: sums for the first two,
`Math.max` for the peak, and `prev.reasoningExact && call.reasoningExact` for
the flag — one estimated call makes the step's figure an estimate, which is
the honest reading.

`step.usage` stays exactly as it is. It drives the live gauge, which is
deliberately still "the current call's prompt size" — see the overview's
non-goals.

**The peak is the number that answers what the gauge couldn't.** For the
Planning stage it is the high-water mark across six independent phase-file
writes; the gauge only ever showed the one in flight.

### 3. Persist on step finish

Eight columns appended to the idempotent migration list (`db/mod.rs:454-472`),
all nullable so existing rows read as "not recorded":

```sql
ALTER TABLE job_run_steps ADD COLUMN tokens_prompt INTEGER
ALTER TABLE job_run_steps ADD COLUMN tokens_completion INTEGER
ALTER TABLE job_run_steps ADD COLUMN tokens_reasoning INTEGER
ALTER TABLE job_run_steps ADD COLUMN tokens_reasoning_exact INTEGER
ALTER TABLE job_run_steps ADD COLUMN peak_prompt_tokens INTEGER
ALTER TABLE job_run_steps ADD COLUMN model_calls INTEGER
ALTER TABLE job_run_steps ADD COLUMN reasoning_ms INTEGER
ALTER TABLE job_run_steps ADD COLUMN total_ms INTEGER
```

`mark_run_step_finished` (`db/runs.rs:118`) takes them as one optional struct
parameter rather than eight positional arguments — that signature is already
six wide, and a call site passing four `Option<i64>`s in the wrong order would
compile:

```rust
/// Token/timing totals for a finished step. `None` when the step ran no model
/// calls at all (a checkpoint stage waiting on the user, say), which reads
/// back as "not recorded" rather than as zero.
pub struct StepStats {
    pub tokens_prompt: i64,
    pub tokens_completion: i64,
    pub tokens_reasoning: i64,
    pub tokens_reasoning_exact: bool,
    pub peak_prompt_tokens: i64,
    pub model_calls: i64,
    pub reasoning_ms: i64,
    pub total_ms: i64,
}
```

Write at step finish, not per call: one row update instead of a database write
on every model callback. The accepted cost is that a run killed mid-step loses
that step's figures — noted in the overview's decisions.

Zero is meaningfully different from unrecorded here. A stage that waits for
user approval makes no model calls and should read as "—", not "0 tokens", so
the runner passes `None` when `calls === 0`.

### 4. Read it back

Extend the steps `SELECT` (`db/runs.rs:197`) and the `JobRunStep` struct with
the same fields, then `JobRunStep` in `jobRuns.svelte.ts:40`.

**Shape the read-back to match the live shape.** `RunStepState.thinking` is
what the card will render for a live run; make the persisted rows resolve to
the same `StepThinkingStats` object so phase 02 writes one component instead
of two that drift. A small mapper in the store — `statsFromRow(row):
StepThinkingStats | null` — is the whole of it.

### 5. Tests

- Rust: a finished step round-trips its stats; a step finished with `None`
  reads back as `None` and not as zeros; the migration is idempotent (the
  existing migration test already covers the pattern).
- `addCallStats`: sums accumulate, the peak is a max and not a sum, and
  `reasoningExact` goes false the moment one call estimates and stays false.
- `reportCall`: prefers `completion_tokens_details.reasoning_tokens` when
  present, falls back to the character ratio when absent, and reports which.
  This is the test that keeps a "~" honest in the UI.

## Verification

- Run a guided-planning job to completion; confirm each phase's row has
  plausible figures and that `tokens_prompt` is much larger than a single
  call's prompt (it should be — it sums every fresh context inside the phase).
- Confirm the Approval stage records `NULL`, not zeros.
- Kill the app mid-run and confirm finished steps kept their stats and the
  interrupted one is `NULL` rather than a partial row.
- Point a job at OpenRouter and confirm `tokens_reasoning_exact` is 1 there
  and 0 against local llama.cpp.
