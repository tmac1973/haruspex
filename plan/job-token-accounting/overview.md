# Per-Phase Token Accounting and a Thinking Panel That Stays Put

Locked 2026-08-17.

## Problem

Watching a guided-planning run, the context gauge on the live phase visibly
reset more than once, and it wasn't clear what the number meant once the run
finished. It also wasn't clear whether any of it was being recorded. Reading
the code: the gauge means less than it looks like, nothing is recorded at all,
and the reasoning panel actively fights being watched.

**1. The gauge is the last call's prompt size, not the phase's anything.**
`onUsageUpdate` overwrites `step.usage` with each call's
`{prompt_tokens, completion_tokens}` (`runner.svelte.ts:434-437`), and
`JobRunView.svelte:143-147` feeds that into `ContextGauge`. It is a live
"how full is the window right now" instrument. When the run ends it holds
whatever the final model call happened to be — for the Planning stage, the
last phase file written.

**2. Context genuinely resets many times inside one phase, by design.** A
guided-planning phase is one *display* step but many independent turns, each
starting from a fresh message list:

- Planning writes one phase file per turn — `for (const phase of outline)`
  (`guided-planning/pipeline.ts:766`). Six phase files, six fresh contexts.
- Each write can retry up to `MAX_WRITE_ATTEMPTS` through `ensureWritten`, and
  every retry is another fresh turn.
- Verification loops up to `MAX_VERIFY_ROUNDS`, described in its own comment
  as an "independent fresh-context review" (`pipeline.ts:796`).

So the resets are the design working. What's missing is that nothing adds the
turns up, and the one number on screen is the one least able to.

**3. Half the accounting already exists; the other half was never built.**
`addCallStats` (`runner.svelte.ts:176`) already folds every call into
`{reasoningMs, totalMs, reasoningTokens, totalTokens, calls}` per step, and
`runThinking` (`JobRunView.svelte:87`) already rolls that up across steps. But
prompt tokens are never accumulated — only the latest survives — and there is
no peak.

**4. Nothing is persisted.** `job_run_steps` holds `prompt_authored`,
`prompt_rendered`, `status`, `output`, timestamps and `error`
(`db/mod.rs:420`). No token columns anywhere. Every number above dies with the
run view, so "what did last night cost" is unanswerable the morning after.

**5. The thinking panel collapses on every update.** Three independent causes:

- `ChatMessage.svelte:34` re-derives the entire HTML string and line 59
  injects it with `{@html}`. The `<details class="thinking-block">` that
  `markdown.ts:394` emits carries no `open` attribute, so every delta destroys
  and recreates it collapsed.
- `convertThinkingBlocks` (`markdown.ts:382`) only matches *closed*
  `<think>…</think>` pairs, and `stripThinkBlocks` erases an unclosed one — so
  in-progress reasoning renders as nothing at all.
- The job view's own panel has a *derived* open state
  (`JobRunView.svelte:200`), so every flip of that expression overrides
  whatever the user clicked.

## What was verified, and the constraint it exposed

**Only the final synthesis streams.** `chatCompletionStream` is called in one
place (`iteration.ts:602`); every tool-driven iteration goes through the
non-streaming completion (`iteration.ts:645`). Guided planning is tool-driven
end to end — the interview stages answer through `ask_user_question`, the
Planning stage writes through `fs_write_text` — so **no call in a
guided-planning phase streams**. Its reasoning arrives one whole model call at
a time because that is when the response arrives.

No UI change can stream what the transport delivers in one lump. Making those
calls stream means assembling tool calls from `delta.tool_calls` fragments;
the type exists (`api.ts:217`) but nothing assembles them today, and it would
be new logic in the code path chat, shell and every job type share. That is
explicitly out of scope here (see non-goals).

**The reasoning/answer split is an estimate.** No server reports it, so
`reportCall` (`iteration.ts:289-304`) apportions `completion_tokens` by the
*character* ratio between the `<think>` block and the answer. Our `Usage`
type (`api.ts:205`) parses only `prompt_tokens` / `completion_tokens` /
`total_tokens`, and OpenAI-shaped backends (OpenRouter included) report
`completion_tokens_details.reasoning_tokens` that we currently drop.

## Goals

- Every phase reports what it actually spent: tokens in, tokens out split
  thinking vs answer, model calls, model time, and the peak context it
  reached — summed across all the fresh contexts inside it.
- The run reports the same totals, so "what did last night cost" has one
  number.
- Those figures survive the run: written to the database, and shown for
  finished runs in the history view, not just while watching.
- Estimated figures are marked as estimates, and stop being estimates on
  backends that report the real split.
- The reasoning panel stays open because the user opened it, shows
  in-progress thinking as it arrives, and never collapses itself.

## Non-goals

- **Streaming the tool-calling iterations.** Decided: the assembly of
  `delta.tool_calls` fragments is new logic in the loop that chat, shell and
  every job type share, and it deserves its own plan and its own testing
  rather than riding along with an accounting change. The consequence is
  accepted: on guided planning the panel updates once per model call.
- **Persisting reasoning *traces*.** Unchanged from the job-observability
  plan — an overnight run's traces are large and their value decays fast.
  This plan persists *counts*, not text.
- **Cost in currency.** Tokens only. Per-model pricing is a different feature
  with a catalog dependency, and OpenRouter already reports spend of its own.
- **Changing what the live gauge shows.** It stays a live window-fullness
  instrument. The card is what answers the cumulative question; conflating
  the two is what caused the confusion in the first place.

## Shape

Three phases, three PRs, plumbing first.

| Phase | Theme | Touches |
|---|---|---|
| [01](phase-01-token-accounting.md) | Accumulate prompt tokens + peak, exact reasoning when reported, persist to `job_run_steps`, read back | `iteration.ts`, `api.ts`, `runner.svelte.ts`, `db/mod.rs`, `db/runs.rs`, `jobRuns.svelte.ts` |
| [02](phase-02-stats-card.md) | The per-phase stats card, live run and history | New `JobRunStats.svelte`, `JobRunView`, `JobRunHistory` |
| [03](phase-03-thinking-panel.md) | Panel that keeps its own open state and renders live reasoning | New `ThinkingPanel.svelte`, `ChatMessage`, `markdown.ts`, `think-stream.ts`, `JobRunView` |

Phase 02 depends on 01 for the numbers. Phase 03 is independent of both and
could land first.

## Decisions taken

- **Real columns on `job_run_steps`, not a JSON blob.** The `model_advanced` /
  `type_config` precedent is right for frontend-owned config, but these are
  figures we will want to aggregate — tokens per job over time, which phase
  costs most — and that shouldn't mean parsing every row in JS.
- **Run totals are derived from steps, not stored.** One place to be wrong
  instead of two. If the history list later needs totals without loading
  steps, add a view or a denormalized column then, with the sum as the
  authority.
- **Tokens in are summed across calls, and labelled as tokens *processed*.**
  It is the honest measure of work, but it is not context size and not quite
  cost either: llama.cpp reuses the KV cache for shared prefixes, so a re-sent
  prompt isn't recomputed. On a metered backend the same number is real spend.
  The card says which it is rather than leaving the reader to assume.
- **Peak context is per phase.** For the Planning stage that's the high-water
  mark across its independent writes — the number the live gauge could never
  show, because it resets between them.
- **Exact reasoning tokens when the server reports them, estimate otherwise,
  and always say which.** A card full of confident numbers that are secretly
  character-ratio apportionment would be worse than the current absence.
- **Stats are written when a step finishes.** One write per step rather than
  per model call. A run killed mid-step loses that step's figures; the
  alternative is a database write on every callback, which is a lot of churn
  for a number nobody reads until the end.
