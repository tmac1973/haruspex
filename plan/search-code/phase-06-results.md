# Phase 06 — Live rerun results

**Decision: the bar is not met, so the plan stops here.** The Search helper
ships as it is (off by default, keyword ranking with an optional reranker),
and phases 07–09 (the embedding index) are not started. With a reranker set
it came out slightly ahead of baseline; with keyword ranking alone it came out
behind. Neither margin is larger than the run-to-run noise.

## Setup

- App: Tim's dev build (main at #964, then #967), driven over the Remote
  control API with `npm run model-eval -- run --prompts search`.
- Model: Qwen 3.8 Flash (`tcclaviger/Qwen3.8-Flash-Next-MXFP4-FP8-GPTQ`) on
  compute:3000 (vLLM), context 524 288, Code max steps 20.
- Project: a clone of Haruspex at `92e53127`, the commit the answers come
  from. The ten tasks are the #951 spike's, word for word.
- Arms: **off** (Search off), **keyword** (Search on, no reranker),
  **rerank** (Search on, compute2's `ggml-org-Qwen3-Reranker-0.6B-Q8_0.Q8_0`).
  Two runs per task per arm, the arms taking turns so server drift hits each
  alike. Raw records: `/tmp/haruspex-model-eval/p06.jsonl` on Tim's machine.
- "Requests" is model calls in the turn; "prompt tokens" is their sum, as
  vLLM reported it. Medians over 20 runs.

## First run: the tool went unused

| Arm | Right file | Median requests | Median prompt tokens | `search_code` used |
|---|---|---|---|---|
| off | 20/20 | 6.5 | 52.3k | – |
| keyword | 20/20 | 7.5 | 85.4k | 1/20 |
| rerank | 20/20 | 7.0 | 65.3k | 0/20 |

The model called `search_code` once in 40 runs. The Code prompt's TOOLS
list led with `code_grep`, and HOW TO WORK said "grep/glob to locate code";
the spike's harness had neither, which is why it saw the tool used 14 times in
20. So the two Search arms measured baseline plus an unused tool, and the
spread between them (52k to 85k with nothing different in what ran) shows how
noisy one arm of 20 runs is.

## The change (step 7)

PR #967: with Search on, the prompt's TOOLS list opens with a `search_code`
line saying to use it first when the model doesn't know the exact name to
grep for, HOW TO WORK names `search_code` before grep/glob, and the tool's
description opens with "Call this before code_grep or reading files when you
don't know the identifier." With Search off the prompt is unchanged.

## Second run, with the change

| Arm | Right file | Median requests | Median prompt tokens | Mean prompt tokens | `search_code` used |
|---|---|---|---|---|---|
| off (first run) | 20/20 | 6.5 | 52.3k | 63.2k | – |
| keyword | 20/20 | 7.0 | 72.8k | 86.5k | 17/20 |
| rerank | 20/20 | **5.5** | **47.9k** | **56.0k** | 16/20 |

Per task (requests, then prompt tokens, for the two runs):

| Task | off | keyword | rerank |
|---|---|---|---|
| proxy | 8, 6 · 132k, 53k | 5, 7 · 50k, 61k | 7, 6 · 69k, 69k |
| memory | 5, 8 · 57k, 52k | 7, 5 · 79k, 47k | 3, 3 · 19k, 20k |
| mcp | 10, 10 · 89k, 174k | 8, 8 · 95k, 111k | 7, 12 · 75k, 127k |
| grepcap | 8, 7 · 55k, 48k | 8, 5 · 83k, 43k | 4, 9 · 31k, 71k |
| anim | 5, 5 · 41k, 41k | 4, 9 · 31k, 79k | 4, 3 · 32k, 19k |
| subtasks | 6, 5 · 47k, 28k | 7, 5 · 104k, 38k | 4, 5 · 32k, 37k |
| node | 6, 6 · 62k, 76k | 5, 6 · 51k, 58k | 6, 4 · 67k, 32k |
| github | 7, 7 · 72k, 50k | 8, 8 · 98k, 64k | 8, 11 · 80k, 118k |
| addcard | 4, 7 · 29k, 48k | 6, 8 · 99k, 124k | 5, 6 · 35k, 59k |
| autosize | 5, 8 · 35k, 74k | 22, 7 · 348k, 67k | 10, 4 · 108k, 19k |

## Reading

- **Accuracy didn't move.** All 100 runs named the right file. As in the
  spike, the agent finds these files with grep alone; the question was only
  ever cost.
- **The app's baseline is much stronger than the spike's.** The spike's
  harness needed 11.5 requests and 98.5k tokens a task; the real Code tab,
  with its own prompt and `code_grep`, needs 6.5 and 52k. That left far less
  to save than the spike suggested.
- **Reranked search is a small win; keyword search is a loss.** With a
  reranker, the median run took one fewer request and about 8% fewer tokens
  (11% by the mean), and the best cases (`memory`, `anim`) took three
  requests. Keyword ranking's six snippets often weren't the right ones, so
  the agent grepped as well and paid for both: about 40% more tokens.
  Neither margin beats the noise the first run showed.
- **Snippets cost context.** Six 30-line snippets add a few thousand tokens
  that every later request in the turn carries again. That cost only pays off
  when the snippets save a grep-and-read round, which the reranker does more
  often.
- The bar was both Search arms matching baseline accuracy with fewer median
  requests and tokens. The reranked arm meets it; the keyword arm doesn't. By
  step 7, that ends the plan here.

## What this leaves

- The helper stays: off by default, and worth turning on only with a
  reranker. The guide's `helpers` page already says a reranker gives better
  results; it now has a measured reason.
- The embedding index (phases 07–09) is not started. Its case rested on
  keyword candidates missing the right code, but the reranker already found
  it in 10/10 tasks offline, and the remaining cost is the snippets, which
  an index wouldn't shrink.
- If the helper is revisited: fewer or shorter snippets (three, or 15
  lines), and a run on a repo the model hasn't seen, would say more than
  another ten tasks on Haruspex.
