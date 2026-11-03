# Phase 06 — Live rerun in the app

**Depends on:** 03, 04, 05 · **Enables:** the comparison the embedding phases
are measured against (phase 09)

## Goal

Repeat the #951 spike's ten tasks in the real app, through the Remote control
API, so the result measures the shipped tool and not the spike's Python copy.
Three arms: baseline (Search off), Search with keyword ranking, and Search
with the reranker. The bar is the overview's: both Search arms match
baseline's accuracy and have fewer median turns and fewer median prompt tokens
than baseline.

## Files touched

- `scripts/model-eval/prompts.mjs` — a `search` group with the ten tasks.
- `scripts/model-eval.mjs` — `setup` clones Haruspex at a pinned commit for
  the `search` group; `run` checks a search answer by its named files; a new
  `--search off|keyword|rerank` option.
- `docs/testing.md` — the search group under "Evaluating a model".
- `plan/search-code/phase-06-results.md` — new: the numbers and the reading.

## Steps

1. Add the ten tasks from the #951 comment to `prompts.mjs` as the `search`
   group, each with its question and accepted files (the spike's `TASKS`
   list, word for word). Each prompt ends: "Reply with a short answer whose
   last line is FILES: followed by the relevant paths, most relevant first."
2. `setup` clones the Haruspex repository at commit `92e53127` (the commit the
   answers were taken from) into `<dir>/haruspex-search`, once.
3. `run --prompts search` opens a Code session on that folder per run. A run
   passes when a path on its `FILES:` line (absolute paths made relative to
   the folder, a leading `./` dropped) is in the accepted list. Each record
   keeps turns, prompt tokens, the tools called and whether `search_code` was
   used.
4. A new option, `--search off|keyword|rerank` (default: leave as is), set
   through `settings.patch` the way `withSetting` sets `deferTools`. It is
   separate from `--setting`, which keeps its `deferTools` meaning. Before the
   runs, read `codeHelpers` and `codeHelperConfig` with `settings.get`; after
   them, patch back `codeHelpers.search` to what it was, or `false` if it was
   absent, and `codeHelperConfig.search` to what it was, or `{ rerank: null }`
   if it was absent (phase 03 replaces the entry whole; an absent entry comes
   back as the off state, which behaves the same). The patches per arm:
   - `off`: `{ codeHelpers: { search: false } }`;
   - `keyword`: `{ codeHelpers: { search: true }, codeHelperConfig: { search:
     { rerank: null } } }`;
   - `rerank`: as `keyword`, with `rerank: { url: 'http://compute2:3000',
     keyId: null, model: 'ggml-org-Qwen3-Reranker-0.6B-Q8_0.Q8_0' }`.

   Phase 03 lets `settings.patch` add these keys.
5. Run Qwen 3.8 on compute:3000, two runs per task per arm (60 runs), with
   `--setting keep`. Patch `codeMaxIterations` to 20 (the spike's turn cap)
   for the runs and put it back after. The records already note the context
   size and step limits.
6. Write `phase-06-results.md`: the table (right file, median turns, median
   prompt tokens, `search_code` use), per-task notes, and whether each arm
   meets the bar.
7. If an arm misses the bar, make one change and rerun that arm once: begin
   `search_code`'s description with "Call this before code_grep or reading
   files when you don't know the identifier." If it still misses, record that
   in the results, and stop the plan here: phases 07–09 are not started, and
   the helper ships as it is, off by default.
8. Post the table on #951 and tick its boxes for the helper, the endpoint
   options and the guide page.

## Build gate

`npm run lint`, `npm run format:check`, `npm run test` (the eval's own
tests), and `npm run model-eval -- prompts` lists the search group.

## Test plan

The phase is itself a test. Before the full 60 runs, one run per arm on the
`autosize` task proves the settings patch, the clone and the answer check
work.

## Commit

`test(eval): search group for the Search helper's live rerun` and, separately,
`docs(plan): Search helper live rerun results`

## Rollback

Revert the commits. They touch only the eval script, its prompts, the testing
doc and the plan folder (plus the description line from step 7, if it was
made).
