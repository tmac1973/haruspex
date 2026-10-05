# Phase 12 — context measurements

**Status: complete. Research (run 95), audit (run 93) and autonomous coding (run 96) measured; nothing crosses the line, so there is no `perf` commit.** Step 3 of phase 12 is a person's job: run one
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

## Autonomous coding — a 3-phase plan (run 96)

Run id: 96 · Qwen3.8-Flash-Next (MXFP4-FP8) on vLLM, compute:3000 · context
window: 262,144 · reasoning effort medium · date: 2026-10-04 · 96 min

The plan: `~/Projects/bronze-liver`, a text adventure in three phases of
seven steps each (engine; temple with light, locks and containers; the
augury, endings, score, save and load). Standard library Python, verified by
`python3 -m unittest discover -s tests -t . -v`. The run built all three
phases, one commit each, with 148 tests passing; the game plays to the good
ending (110 of 110) from the terminal.

The three plan phases all run inside the one "Coding loop" step.

| Step | Peak | Peak % | Trims | Worst | Calls | Model time | Crosses? |
|---|---|---|---|---|---|---|---|
| Preflight | 18,423 | 7.0% | 0 | — | 15 | 8 min | no |
| Coding loop (3 phases) | 67,744 | 25.8% | 0 | — | 179 | 83 min | no |
| Finalize | 10,852 | 4.1% | 0 | — | 8 | 1 min | no |
| Document | 18,034 | 6.9% | 0 | — | 22 | 2 min | no |

Nothing crosses: the longest-running turn peaks at a quarter of the window.
The coding fix (end a phase turn at 70% and continue from the TODO) isn't
needed on this model and window.

Worth knowing, though not a context matter: reasoning was 233K of the coding
loop's 310K output tokens (75%), at medium effort. If coding runs need to be
faster, the effort setting is the lever, not context.

## Fixes applied

None. No step of any job type came near 85% of the window or needed a forced
fit, so phase 12 step 4 applies no fix and there is no `perf` commit.

The one failure the measuring found was output, not context: run 94's
research step was cut off at the 8K response cap. That was fixed separately
in #277 (the forced final answer without reasoning, a cut-off research answer
kept, and a job's response cap scaled with its window).

**Caveat:** this is one model with a 256K window. On a small local model the
same runs would cross. The audit's 130K peak is four times a 32K window. The
telemetry from the first commit (trims and worst cut per step, on the Tokens
card) is what will show it, and the step 4 fixes remain the plan for when it
does.
