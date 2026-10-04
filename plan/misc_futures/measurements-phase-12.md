# Phase 12 — context measurements

**Status: audit measured (run 93); research and autonomous coding to do.** Step 3 of phase 12 is a person's job: run one
real job of each type on the job model (Qwen3.8-Flash on vLLM, compute:3000)
with the build that records context pressure, and fill in the tables below
from each run's Tokens card (Export JSON has every figure).

A step **crosses the line** when its peak is at least 85% of the window, or
its worst cut is `forced`. Only a crossing earns a fix (phase 12, step 4).

Where the figures come from:

- **Peak %** — the Tokens card's Peak ctx column, or `peak_prompt_tokens /
  context_size` in the export.
- **Trims** — "trimmed N×" in the same cell, or `trim_events`.
- **Worst** — the cell's tooltip, or `pressure_max` (`trim` < `fit` <
  `forced`).
- **Iterations and wall time** — the step's model calls and model time.

## Research — 4 steps, deep research on steps 2 and 3

Run id: — · context window: — · date: —

| Step | Peak % | Trims | Worst | Calls | Model time | Crosses? |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 (deep) | | | | | | |
| 3 (deep) | | | | | | |
| 4 | | | | | | |

## Audit — 3 samples (run 93)

Run id: 93 · Qwen3.8-Flash-Next (MXFP4-FP8) on vLLM, compute:3000 · context
window: 262,144 · date: 2026-10-04

Three samples rather than five: five took about two hours. One sample's peak
is what the crossing test reads, and the three fall in the same range.

| Phase | Peak | Peak % | Trims | Worst | Calls | Model time | Crosses? |
|---|---|---|---|---|---|---|---|
| Sample 1 | 123,635 | 47.2% | 0 | — | 78 | 14 min | no |
| Sample 2 | 130,386 | 49.7% | 0 | — | 74 | 17 min | no |
| Sample 3 | 86,595 | 33.0% | 0 | — | 72 | 9 min | no |
| Synthesis (verify) | 38,858 | 14.8% | 0 | — | 196 | 25 min | no |

Nothing crosses: the worst sample peaks at half the window and nothing was
ever trimmed. The audit's long sample turns (step 4's "write findings and
continue fresh" fix) aren't needed on this model and window. A smaller window
would change that: at 32K, sample 2's peak is four times the window.

Run 91, the same job with five samples, recorded no token figures: it ran in
a dev session hot-reloaded underneath it. Not used.

## Autonomous coding — a 3-phase plan

Run id: — · plan: — · context window: — · date: —

| Phase | Peak % | Trims | Worst | Calls | Model time | Crosses? |
|---|---|---|---|---|---|---|
| | | | | | | |

## Fixes applied

None yet. For each pattern that crossed, record the fix from phase 12 step 4
and the re-measured numbers here. If nothing crossed, say so, and there is no
`perf` commit.
