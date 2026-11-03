# Phase 08 — Embeddings in `search_code`

**Depends on:** 02, 03, 04, 05, 07 · **Enables:** the embedding rerun (phase
09)

## Goal

An optional embedding endpoint on the Search row. When it is set, the first
search in a project starts building the index in the background, and every
search after it is ready merges vector candidates with keyword ones before
ranking. Until the index is ready, searches work as before and say the index
is still building.

## Files touched

- `src/lib/helpers/search/config.ts` — `embed: RerankEndpoint | null` (the
  same URL / key / model shape).
- `src/lib/helpers/search/config.test.ts` — the new field.
- `src/lib/helpers/search/SearchSettings.svelte` — the embedding endpoint
  fields.
- `src/lib/agent/tools/search-code.ts` — refresh, query, merge.
- `src/lib/agent/tools/search-code.test.ts` — the merge and status paths.
- `docs/guide/helpers.md` — the embedding paragraph.

## Steps

1. `parseSearchConfig` gains `embed`, cleaned the same way as `rerank`.
2. `SearchSettings.svelte`: a second block under the reranker, "Optional:
   also search by meaning with an embedding server.", with the same URL, key,
   Fetch (`listServerModels`) and model fields; the model select filters on
   `embedding` in `capabilities` (toolchest's word for it), or lists all when
   none are reported. A `title` says the
   first search in a project builds an index, which takes minutes on a large
   project, and that the index lives in the app's data folder.
3. In `search_code`, when `embed` is set, build the `EmbedEndpoint` (phase
   07) as `{ base_url: embed.url, api_key: getApiKeyValue(embed.keyId) ??
   null, model: embed.model }` after `apiKeysReady()`, and pass the WSL arg to
   both index commands:
   1. call `code_index_refresh` with `wait: false`. If the status is not
      `ready`, skip vector candidates and add a note to the last line,
      checked in this order:
      - `error` set (the last build failed; this call has started another),
        whatever `building` says: `(no embeddings: the index build failed —
        <short error>)`;
      - `total_files` known: `(index building: <files> of <total_files>
        files)`;
      - otherwise: `(index building)`;
   2. if `ready`, call `code_index_refresh` with `wait: true` (cheap when
      nothing changed; it embeds the files edited since the last search),
      then `code_index_query` with `limit: 60`;
   3. take the keyword top 60 and the vector top 60 and merge them by
      reciprocal rank fusion (`Σ 1 / (60 + rank)`), dropping a chunk that
      overlaps a better one in the same file, to at most 100 candidates.
4. Ranking after the merge is unchanged: the reranker when set, otherwise the
   fused order.
5. The last line names what ranked the result. With `embed` set, it is
   exactly one of:
   - `(keyword + embeddings)` — vector candidates merged, no reranker set;
   - `(keyword + embeddings, reranked by <model>)`;
   - `(keyword + embeddings; the reranker didn't answer — <short error>)`;
   - `(index building: <files> of <total_files> files)`, `(index building)`
     or `(no embeddings: the index build failed — <short error>)`, from step
     3.1, each followed by `, reranked by <model>` when the reranker ranked
     the keyword candidates;
   - `(no embeddings: <short error>)` when the refresh or query call fails
     after the index was ready; keyword candidates are used.
   Without `embed`, phase 05's lines are unchanged.
6. Guide: one paragraph: an embedding server on the Search row lets the helper
   find code that shares no words with the question; the first search in a
   project builds an index (minutes on a large project), later searches update
   it only for changed files; indexes unused for 30 days are deleted.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`,
`node scripts/guide-check.mjs`.

## Test plan

- `search-code.test.ts`: index not ready → keyword only plus the building
  note; ready → fused candidates in the expected order; embedding error →
  keyword only and the error named; no `embed` → no index calls.
- `config.test.ts`: `embed` parsed like `rerank`.
- Manual in the dev app on the Haruspex checkout with compute2's
  `Qwen-Qwen3-Embedding-0.6B.Q8_0`: the first search reports the build; when
  it's done, "where is the wording of the Subtasks card in Code settings?"
  (rank 71 for keywords in the spike) returns `CodeSection.svelte`; after
  editing that file, the next search still finds it at the new lines.

## Commit

`feat(helpers): optional embedding index for the Search helper`

## Rollback

Revert the commit. A stored `embed` is then ignored and no new index builds;
existing index files are pruned after 30 days.
