# Phase 05 — A reranker on the Search row

**Depends on:** 02, 03, 04 · **Enables:** the live rerun's rerank arm (phase
06), the embedding merge (phase 08)

## Goal

The Search row gets an optional reranker: a server URL, an API key and a model.
When one is set, `search_code` sends its top 100 keyword candidates to it and
returns the six it ranks best. When it's unset, slow or failing, keyword
ranking stands and the result says why. This is the arm that matched baseline
accuracy with the fewest turns in the spike.

## Files touched

- `src/lib/helpers/search/config.ts` — new: `SearchConfig`, `parseSearchConfig`.
- `src/lib/helpers/search/config.test.ts` — new.
- `src/lib/helpers/search/SearchSettings.svelte` — new: the row's editor.
- `src/lib/helpers/search/helper.ts` — add `settings` to the registration.
- `src/lib/agent/tools/search-code.ts` — rerank with fallback.
- `src/lib/agent/tools/search-code.test.ts` — the rerank paths.
- `docs/guide/helpers.md` — the reranker paragraph.

## Steps

1. `config.ts`:
   ```ts
   export interface SearchConfig {
   	rerank: RerankEndpoint | null; // from #lib/rerank.ts
   }
   ```
   `parseSearchConfig(raw)` returns `{ rerank: null }` unless `raw.rerank` has
   a non-empty string `url` and `model`; `keyId` becomes `null` unless it is a
   string. (Phase 08 adds `embed`.)
2. `SearchSettings.svelte`, shown under the switch while Search is on:
   - one help line: "Optional: rerank results with a server you run." with a
     `title` naming llama-toolchest and llama-server `--reranking`;
   - a URL field, an API key select (the named keys from Settings → Inference
     → API Keys, plus None), a **Fetch** button that calls
     `listServerModels` (phase 02), and a model select. The select lists
     models whose `capabilities` include `rerank`; when no model reports
     capabilities (not toolchest), it lists every model;
   - a **Clear** button that sets `rerank: null`;
   - saves through `setCodeHelperConfig('search', …)` on change.
3. Register `settings: { parse: parseSearchConfig, component: () =>
   import('./SearchSettings.svelte') }` on the helper.
4. In `search_code`, after the candidates: if
   `helperConfig<SearchConfig>('search')?.rerank` is set, call
   `rerankDocuments` with the query and each chunk as `path\n` + its text,
   timeout 15 s. On success, order the chunks by the result and take six. On
   any error, keep the keyword order.
5. The result's last line names what ranked it: `(reranked by <model>)`, or
   `(keyword ranking: the reranker didn't answer — <short error>)`, or
   `(keyword ranking)` when none is set. Log a failure with `console.warn`,
   the URL through `urlForReport`.
6. Guide: one paragraph in the Search section: set a reranker on the Search
   row (Settings → Code → Helpers → Search) for better results on vaguely
   worded questions; any server with `/v1/rerank` works; it adds a couple of
   seconds a search; if it's down, the helper uses keyword ranking.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`,
`node scripts/guide-check.mjs`.

## Test plan

- `config.test.ts`: absent, partial and valid configs.
- `search-code.test.ts`: rerank order applied; rerank error keeps keyword
  order and names the error; no config never calls rerank.
- Component test for `SearchSettings`: the model select filters to rerank
  models when capabilities are reported, and lists all when not.
- Manual in the dev app: set compute2's toolchest and
  `ggml-org-Qwen3-Reranker-0.6B-Q8_0.Q8_0`; ask the autosize question; the
  result ends "(reranked by …)". Point the URL at a dead port; the result
  ends with the keyword fallback note and the search still returns.

## Commit

`feat(helpers): optional reranker for the Search helper`

## Rollback

Revert the commit. A stored `codeHelperConfig.search` is then ignored;
`search_code` goes back to keyword ranking.
