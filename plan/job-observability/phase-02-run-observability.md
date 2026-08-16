# Phase 02 — Reasoning and Context Visible During a Run

Makes a running job legible: what the model is thinking about right now, and
how much of its context that is consuming. Closes open item #1 in
`plan/futures.md`.

## Steps

### 1. Extract reasoning instead of only stripping it

`markdown.ts` has `stripThinkBlocks` (`:275`) and `convertThinkingBlocks`
(`:328`); nothing returns the reasoning on its own. Add beside them:

```ts
/** The reasoning text from `<think>` blocks, including a still-open trailing
 *  block — the live case, where the closing tag hasn't arrived yet. */
export function extractThinkBlocks(text: string | null | undefined): string
```

The still-open case is the whole point. `stripThinkBlocks:278` deletes
`/<think>[\s\S]*$/` precisely because an unclosed block is not answer text —
which is why piping the live buffer through `ChatMessage` renders nothing and
`JobRunView` falls back to bouncing dots. `extractThinkBlocks` is the inverse
and must keep the unclosed tail.

Leave `convertThinkingBlocks`' "thinking-only message" promotion (`:329-339`)
alone — that heuristic exists for finished chat messages where the reasoning
*is* the answer, and it is not this.

### 2. Carry the raw buffer to the finished step

`runEphemeralTurn` already returns `rawText` — "the unstripped buffer,
`<think>` blocks intact, for UI that renders them" (`runEphemeralTurn.ts:82`).
Nothing in the job path consumes it: the runner stores `finalText` in
`step.output` and drops the rest.

`RunStepState` (`runner.svelte.ts:121`) gains:

```ts
/** Reasoning for this step, session-only — never persisted to job_runs. */
reasoning: string;
usage: { promptTokens: number; completionTokens: number } | null;
```

`reasoning` is written from `extractThinkBlocks(streaming)` as the step streams,
then replaced from the turn's `rawText` when it finishes, so a step's reasoning
survives the switch from live buffer to final output. Both fields are display
state and belong with the existing `checklist`/`sizeWarning` fields that
`RunStepState:130` already documents as not persisted.

### 3. Report usage from job turns

`EphemeralTurnOptions` gains `onUsageUpdate?: (usage: Usage) => void`, passed
into `runTurnCore` — the loop already fires it at `iteration.ts:547` (streaming)
and `:598` (non-streaming), and `runShellTurn.ts:104` is the pattern to copy.

The runner wires it per-step into `step.usage` rather than into the global
`context.svelte` store. The global store is single-valued and chat-shaped
(`resetContextUsage` on conversation switch, `setContextUsage` on tab restore);
a job with several concurrent-ish steps writing into it would fight the chat
tab for the same slot.

Note for phase mode: in `context_mode: 'phase'` one step's context grows across
the whole phase, so the per-step number is exactly the interesting one — it is
the growth this makes visible.

### 4. Thinking vs answering stats

"The run was slow and it seemed to be thinking a lot" should be answerable with
a number. The discrimination this needs already exists in exactly one place:
`appendStreamDelta` (`think-stream.ts:25`) branches on
`delta.reasoning_content ?? delta.reasoning` versus `delta.content`, and
already carries a per-turn `ThinkStreamState` memo through every driver. Put
the counters there; do not add a second place that decides what reasoning is.

**Exact, essentially free:**

- Wall clock per channel. Attribute each inter-delta gap to the channel of the
  arriving delta and sum. Correct even when the two interleave, and in the
  ordinary case the reasoning total is just time-to-first-content-token. The
  stream loop already holds `streamStartMs` (`iteration.ts:542`).
- Characters and chunk counts per channel. `iteration.ts:540` already counts
  content chars; this adds the reasoning side.
- Total completion tokens per call, from `usage`.

**Estimated, and must be labeled as such:** the reasoning *token* split.
`Usage` (`api.ts:192`) parses only `prompt_tokens`/`completion_tokens`/
`total_tokens`. Absent a server-reported figure, split `completion_tokens`
proportionally by `estimateTokens` (`context-budget.ts:50`) over each channel's
accumulated text. Good enough for "thinking was 80% of the output", not a
count — the UI should say so rather than implying precision it doesn't have.

**If the server reports it, prefer it.** Add optional
`completion_tokens_details.reasoning_tokens` to `Usage` and use it when
present, falling back to the estimate. Unverified for this llama-toolchest
build — settle it with
`curl -s $TOOLCHEST/v1/chat/completions -d '{…,"max_tokens":16}' | jq .usage`
before building the estimator, because a real field makes the two wrinkles
below mostly moot.

**Wrinkles:**

- **Inline `<think>` in the content channel.** Not every server uses a separate
  reasoning field — that is why `stripThinkBlocks` exists at all, and why the
  `PLAN OK` verdict bug in `futures.md` was possible. The counter must track
  tag state within content deltas too, or a whole reasoning block scores as
  answer tokens. This is the part most likely to be silently wrong.
- **The non-streaming tool-check call** (`runModelCall`, `iteration.ts:570`)
  has no deltas; it can only be split by parsing tags out of the final content.
  Name the gap in the UI's tooltip rather than presenting partial coverage as
  total.
- **Aggregation is the real design work, not the counting.** One coding step is
  a multi-iteration agent loop, so it is many model calls. Roll up per call →
  per step → per run. The per-run total is the one that answers the original
  question; the per-step number is what shows *which* step went wrong.

Delivery: extend the existing `onCallStats` payload (`loop.ts:137`) with the
split rather than adding a parallel hook, and expose `onCallStats` on
`EphemeralTurnOptions` — jobs have never consumed it, which is also why a job
step shows no tok/s while chat and shell do (`chat.svelte.ts:988`,
`shell.svelte.ts:664`). One hook, three consumers.

### 5. Reasoning disclosure in the step card

Replace the three-branch block at `JobRunView.svelte:141-153`:

- **Live, reasoning only** — today's bare `<ThinkingIndicator />`. Becomes an
  auto-expanded disclosure streaming `step.reasoning`, with the indicator in
  its summary row so the "it's alive" signal is kept.
- **Live, answer started** — the disclosure auto-collapses and `ChatMessage`
  renders the answer as it does now. The summary row becomes the home for
  step 4's stats: `Reasoning — 4m 12s · ~3.1k tokens (est.)`, with the
  estimate qualifier dropped when the server reported a real figure.
- **Finished** — the disclosure stays, collapsed, alongside `step.output`.

The run header carries the roll-up — `Thinking 38m of 51m (74%)` — because
that is the number that answers "why was last night slow", and it is only
meaningful summed across every step.

Auto-collapse must not fight the user: once they toggle it by hand, that step's
disclosure stops auto-anything. A per-step `userToggled` flag in the component,
not in `RunStepState` — it is view state, not run state.

The visual language already exists: `.thinking-block` in
`ChatMessage.svelte:209-231`. Reuse those styles rather than inventing a second
reasoning look.

### 6. Context usage in both places

**Step card.** Split `ContextIndicator.svelte` into a presentational core
(props: `promptTokens`, `contextSize`; keeps `formatTokens`, `barColor`, the
bar) and a thin wrapper that reads the global store for its existing mount at
`+layout.svelte:416`. The step card renders the core with `step.usage` and the
job's resolved context size — `ctx.contextSize()` already exists on
`JobRunContext` (`types/types.ts:59`) and accounts for
`model_remote_context_size`.

**Top-right indicator.** While the Jobs tab is showing a live run, the mounted
indicator switches to the live step's usage and the job's context size, and
reverts on chat/shell. `+layout.svelte` owns the mount and already knows the
active tab; the run state is one `getCurrentRun()` call away
(`runner.svelte.ts`). Add a title attribute distinguishing the two sources
("Job: <name> — <model>") so the number is never ambiguous about which model it
describes. That ambiguity is the literal complaint in `futures.md` item #1.

## Verification

- `markdown.test.ts`: `extractThinkBlocks` over closed blocks, an unclosed
  trailing block, multiple blocks, no blocks, null/undefined.
- `think-stream.test.ts`: the channel counters. Reasoning-field deltas and
  inline-`<think>` content deltas both attribute to reasoning; interleaved
  reasoning/content splits the wall clock to the right side; a stream with no
  reasoning at all reports zero rather than NaN or a 0/0 percentage. Feed
  timestamps in rather than reading the clock, so the timing assertions are
  deterministic.
- A rollup test: per-call stats from a multi-iteration step sum to the step
  total, and steps sum to the run total.
- `runner.test.ts`: `onUsageUpdate` lands in `step.usage`; `reasoning` is
  populated from the stream and then from `rawText` at finish; neither field
  reaches the persisted run row.
- A `JobRunView` component test (the repo already mounts components under
  jsdom — see `ChatView.test.ts`): reasoning-only live step renders an expanded
  disclosure with the text, not bare dots; a finished step keeps a collapsed
  one; a hand-toggled disclosure is not re-collapsed by a subsequent delta.
- `ContextIndicator` core renders from props; the global wrapper still renders
  from the store (guards the `+layout.svelte` mount against the split).
- Manual: watch a live coding run in `context_mode: 'phase'` and confirm the
  step's context bar climbs across the phase, then resets on the next phase.
