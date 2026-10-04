# Phase 12 — context measurements

**Status: audit (run 93) and research (run 95) measured; autonomous coding to do.** Step 3 of phase 12 is a person's job: run one
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

## Research — 4 steps (plus a PDF step), deep research on steps 2 and 3 (run 95)

Run id: 95 · Qwen3.8-Flash-Next (MXFP4-FP8) on vLLM, compute:3000 · context
window: 262,144 · reasoning effort medium · date: 2026-10-04 · 20 min

The job "local inference landscape": list the engines, research their
backends and features (deep), research AMD reports (deep), write a one-page
report. A fifth step turned the report into a PDF.

| Step | Peak | Peak % | Trims | Worst | Calls | Model time | Crosses? |
|---|---|---|---|---|---|---|---|
| 1 List engines | 22,813 | 8.7% | 0 | — | 8 | 2 min | no |
| 2 Backends and features (deep) | 45,432 | 17.3% | 0 | — | 28 | 9 min | no |
| 3 AMD reports (deep) | 51,001 | 19.5% | 0 | — | 14 | 6 min | no |
| 4 Write the report | 19,485 | 7.4% | 0 | — | 2 | <1 min | no |
| 5 Make the PDF | 18,976 | 7.2% | 0 | — | 4 | 1 min | no |

Nothing crosses: the deep steps peak under a fifth of the window, and the
step that prepends their output (step 4) peaks at 7%. The "cap what is
prepended" fix for research isn't needed on this model and window.

What did go wrong was output, not context. Run 94, the same job before #277,
failed on step 3: the iteration cap forced a final answer, reasoning used
14K of its 22K output tokens, and the answer was cut off at the 8,192-token
response cap. #277 writes that answer with reasoning off, keeps a cut-off
research answer instead of failing, and gives a big-window job a response
cap to match. Run 95, with #277, finished every step without a cut-off.

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
