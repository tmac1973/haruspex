# Phase 02 — The Per-Phase Stats Card

One component, rendered at the bottom of a live run and of any finished run in
the history view. Depends on phase 01 for the numbers.

## Steps

### 1. One component, both callers

`JobRunStats.svelte` takes a list of `{ label, stats: StepThinkingStats | null }`
plus the run's context size, and renders a table. Phase 01's read-back mapper
is what lets the history view hand it the same shape a live run does; if the
two ever need different components, something upstream has diverged and should
be fixed there instead.

Columns, per phase:

| Phase | In | Out | Thinking | Calls | Model time | Peak ctx |
|---|---|---|---|---|---|---|
| Overview | 41.2k | 3.1k | ~1.9k (61%) | 7 | 4m 12s | 12.4k (38%) |
| Planning | 186k | 22.8k | ~14.1k (62%) | 31 | 28m 03s | 31.7k (97%) |
| Approval | — | — | — | — | — | — |
| **Run total** | **312k** | **41.6k** | **~26k (63%)** | **58** | **1h 04m** | **31.7k (97%)** |

- **In** is `tokens_prompt`, summed across every call in the phase.
- **Out** is `tokens_completion`; **Thinking** is the reasoning share of it,
  with the percentage that makes the number readable at a glance.
- **Peak ctx** is `peak_prompt_tokens` with its share of the context window —
  the high-water mark across the phase's independent contexts.
- A phase with no model calls renders `—` throughout, never zeros.

### 2. Say what the numbers mean, once

Two things will be misread otherwise, so the card states them rather than
leaving a footnote nobody reads:

- **In is tokens processed, not context size and not necessarily cost.** Every
  call re-sends its prompt, so this sums re-sends. Locally llama.cpp reuses the
  KV cache for shared prefixes, so a re-sent prompt isn't recomputed; on a
  metered backend the same number is real spend.
- **Thinking is an estimate unless the backend reports the split.** Marked with
  `~` per phase, driven by phase 01's `reasoningExact` flag rather than by a
  blanket assumption — a run that mixed backends will honestly show some rows
  marked and some not. The existing `thinkingSummary` (`JobRunView.svelte:77`)
  already uses `~`; keep the two consistent.

Peak context deserves a line too, because it is the answer to the question
that started this: the live gauge resets between the independent turns inside
a phase, so it can only ever show the current one.

### 3. Wire it into both views

- `JobRunView.svelte`: below the steps list. The existing `runThinking`
  roll-up (`:87`) is superseded by the card's totals row — remove it rather
  than shipping two run-level summaries that can disagree.
- `JobRunHistory.svelte`: inside the expanded run, fed from the persisted
  rows. Runs from before phase 01 have no stats and render the empty state.

### 4. Empty and partial states

- **A pre-phase-01 run:** "Not recorded for this run" rather than a table of
  dashes, so an old run doesn't read as a run that spent nothing.
- **A run killed mid-step:** finished phases show figures, the interrupted one
  shows `—`. The totals row sums what exists and says so ("2 of 5 phases
  recorded") rather than silently under-reporting.

### 5. Tests

- Formatting: thousands are `k`, a null `stats` renders `—`, and percentages
  round sanely at the edges (0 calls, 0 total ms).
- Totals: the run row is the sum of the phase rows, and skips nulls rather
  than treating them as zero.
- The estimate mark appears iff at least one contributing phase estimated.

## Verification

- Compare the card's Planning row against the six phase-file writes visible in
  the run: calls should be at least six, and `In` should dwarf any single
  call's prompt.
- Check a finished run in history matches what the live card showed while it
  ran — the same numbers from two sources is the whole point of phase 01's
  shared shape.
- Confirm an old run renders the "not recorded" state rather than zeros.
