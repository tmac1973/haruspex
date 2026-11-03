# Phase 09 — Embedding rerun and decision

**Depends on:** 05, 06, 08 · **Enables:** nothing in this plan; it closes it

## Goal

Measure whether the embedding index earns its place, with the same ten tasks
and harness as phase 06, and record the decision. The index stays if it
improves accuracy or cuts median turns or prompt tokens against the phase 06
rerank arm; otherwise the embedding option is removed: its settings block,
its code in `search_code`, the guide paragraph, and phase 07's Rust index
(nothing else uses it).

## Files touched

- `scripts/model-eval.mjs` — `--search` gains `embed` and `embed-rerank`.
- `plan/search-code/phase-09-results.md` — new: numbers, reading, decision.
- On a "remove" decision: `src/lib/helpers/search/SearchSettings.svelte`,
  `src/lib/helpers/search/config.ts`, `src/lib/agent/tools/search-code.ts`
  and `docs/guide/helpers.md` lose the embedding parts;
  `src-tauri/src/code_index/` and its `lib.rs` lines are deleted, and the IPC
  types regenerated.

## Steps

1. `--search embed` turns Search on with `embed: { url:
   'http://compute2:3000', keyId: null, model:
   'Qwen-Qwen3-Embedding-0.6B.Q8_0' }` and `rerank: null`; `--search
   embed-rerank` sets both, the reranker as in phase 06.
2. Before the runs, build the clone's index once: with `--search embed`'s
   settings in place, start one Code session on the clone, ask a search question, and
   repeat the question every minute until `search_code`'s last line contains
   `keyword + embeddings`. No run then measures a half-built or failed index;
   if the line shows `(no embeddings: …)`, fix the server and start again.
3. Run Qwen 3.8 on compute:3000, two runs per task per arm (40 runs).
4. Write `phase-09-results.md` with the phase 06 arms and the two new ones in
   one table, the per-task notes (especially `subtasks` and `autosize`, the
   two where keywords did worst), the first-build time and the index size.
5. Decide by the rule in the Goal, write it at the top of the results file and
   on #951. On "keep", tick the plan done. On "remove", make the removals listed
   above in one PR with the results.

## Build gate

`npm run lint`, `npm run format:check`, `npm run test`; on "remove", also
`npm run check` and `node scripts/guide-check.mjs`.

## Test plan

The phase is itself a test. One run per new arm on `subtasks` first proves the
settings and the ready index.

## Commit

`docs(plan): Search helper embedding rerun and decision`, plus, on
"remove", `refactor(helpers): drop the Search helper's embedding option`.

## Rollback

Revert the commits. The results file is documentation; a "remove" commit
reverts cleanly to phase 08's state.
