# Phase 12 — context measurements

**Status: not measured yet.** Step 3 of phase 12 is a person's job: run one
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

## Audit — 5 samples on a mid-sized repo

Run id: — · repo: — · context window: — · date: —

| Phase | Peak % | Trims | Worst | Calls | Model time | Crosses? |
|---|---|---|---|---|---|---|
| | | | | | | |

## Autonomous coding — a 3-phase plan

Run id: — · plan: — · context window: — · date: —

| Phase | Peak % | Trims | Worst | Calls | Model time | Crosses? |
|---|---|---|---|---|---|---|
| | | | | | | |

## Fixes applied

None yet. For each pattern that crossed, record the fix from phase 12 step 4
and the re-measured numbers here. If nothing crossed, say so, and there is no
`perf` commit.
