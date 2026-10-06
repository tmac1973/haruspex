# Phase 16 — benchmark results (Part A)

Taken 2026-10-05 on the user's vLLM server (compute:3000, 4× AMD AI PRO R9700),
from the Haruspex database (read-only) and the projects each run left.

## Bronze Liver

Bronze Liver: three phases, 21 steps, Python, standard library only. Every run
started from the same plan commit (e28be52). "Walkthrough" is the seed-7 game
played to the end by hand afterwards.

| Run | Model | Reasoning | Minutes | Output tokens | Reasoning share | Calls | Phases passed first time | Tests | Walkthrough |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 96 | Qwen3.8-Flash-Next | medium | 96.3 | 348,098 | 74% | 224 | 3/3 | 148 | 110/110 |
| 101 | Qwen3.8-Flash-Next | low | 128.6 | 444,547 | 83% | 182 | 3/3 | 110 | 110/110 |
| 102 | Qwen3.8-Flash-Next | off | 182+, cancelled | — | 0% | — | 1/3 | — | — |
| 103 | Thinking Cap (PARO5) | off | 3.9 | 37,853 | 0% | 116 | 3/3 | 77 | 110/110 |
| 104 | Thinking Cap (PARO5) | medium | 8.3 | 77,861 | 47% | 104 | 3/3 | 83 | 110/110 |

- **Low reasoning thinks more than medium on Flash-Next:** 17% fewer calls,
  but about 1.8× the reasoning per call. This matches what reviews of
  Qwen 3.8 report.
- **Flash-Next with reasoning off fails.** It built an elaborate darkness
  model the plan never asked for, wrote tests that contradict each other, and
  phase 02 went through all 5 repair cycles without passing. The repair notes
  named the fix ("edit the tests"), but that advice was cut from the prompt
  tail. #289 fixed that.
- **Thinking Cap at medium is 11× faster than Flash-Next at medium** with the
  same pass record: 4.5× fewer output tokens, a smaller reasoning share, and
  about 160 tok/s against 62 on this server. MTP speculative decoding seems
  to land often on plain code. Flash-Next still wrote the most thorough tests.
- **Thinking Cap with reasoning off is fast but loose.** It left out articles
  in its replies, counted saves and loads as moves, and its preflight wrote
  only that it found no open questions. At medium, its preflight found and
  settled a real gap in the plan.

## Larger plans, Thinking Cap at medium

| Run | Plan | Minutes | Output tokens | Reasoning | Calls | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 99 (Flash-Next, medium) | dark_times_4: Rust + Bevy, 12 phases, 95 steps | 6+ h at step 6, cancelled | — | 75–92% | — | Phase 01 alone took about 3 h. |
| 105 | dark_times_4, same plan | 101.6, cancelled | 708,850 | 71% | 300 | Phase 01 passed in about 20 min. Phase 02's build turn then ended twice without writing code (NO WORK). The user judged the plan at fault. |
| 110 | dark_times_5: Go + Ebitengine, 10 phases, chained from planning | 48.0 | 454,732 | 59% | 454 | All 10 phases passed (2 repair cycles along the way). The game opened to a black window: zero-DPI font, no frame ever checked. That became Part F. |

## What this decided

- **Model choice did more than any reasoning tuning.** Part B (adaptive
  reasoning) drops in priority; staying at medium on a strong coder is the
  default advice.
- **Part C (builds) matters more than planned:** a Bevy plan pays for cargo
  on every phase gate. Go builds in seconds.
- **Part F (a frame smoke test) is needed:** a graphical project can pass
  every phase and show nothing.
