# Phase 04 — The Search helper with keyword ranking

**Depends on:** 01 · **Enables:** the reranker (phase 05), the live rerun
(phase 06), the embedding merge (phase 08)

## Goal

A **Search** helper in Settings → Code → Helpers, off by default, owning
`search_code`. With it on, the Code tab's agent can ask a plain-words question
and get the six best code snippets, ranked by keyword score (phase 01). No
endpoint settings yet. This is the version every user can run with no server.

## Files touched

- `src/lib/helpers/search/helper.ts` — new: `registerHelper` for id `search`.
- `src/lib/helpers/index.ts` — import it.
- `src/lib/agent/tools/search-code.ts` — new: the `search_code` tool.
- `src/lib/agent/tools/search-code.test.ts` — new.
- `src/lib/agent/tools/index.ts` — import the tool module.
- `src/lib/components/searchStepLabels.ts` — `search_code: 'Searching code'`
  in `QUOTED_LABEL_PREFIX`, so a step reads `Searching code: "<query>"`.
- `src/lib/agent/tools/registry.helpers.test.ts` — new: the tool filter offers
  a helper's tools only in the Code tab, only while it's on, and drops a
  writing helper's tools in a read-only session.
- `docs/guide/helpers.md` — a "The Search helper" section.

## Steps

1. Register the helper:
   ```ts
   registerHelper({
   	id: 'search',
   	label: 'Search',
   	summary: 'Finds code from a question in plain words.',
   	tooltip:
   		"Scores the project's files by the words in the question and shows the agent the six best snippets with their paths and lines. Optionally reranks them with a server you run.",
   	tools: ['search_code'],
   	writes: false
   });
   ```
   It's registered after 3D, so the card lists 3D first.
2. The tool, registered with `category: 'fs'` like `code_grep`:
   - name `search_code`; parameters `query` (string, required) and `path`
     (string, optional subdirectory);
   - description: "Find the code that answers a question in plain words
     ("where is X handled", "what decides Y"). Returns the best few snippets
     with paths and line numbers. Use this first when you don't know the
     exact identifier; use code_grep when you do."
3. `execute`: resolve the root with `ctxCwd` (error "No working directory
   set." when none) and call `code_search_candidates` with `limit: 100` and
   the WSL arg (`ctxWslDistroArg`). Take the top 6 chunks; when two of them are
   in the same file and their ranges touch or overlap, merge them into one
   snippet (so six can be fewer).
4. Format each snippet as `== path:start-end` followed by its lines,
   numbered as `fs_read_text` numbers them, joined by a blank line. When there
   are no chunks: `No matches for: <terms>. Try other words, or code_grep for an
   identifier.` End with one line naming the ranking:
   `(keyword ranking)`. Pass the text through `withLocalScopeNote` as
   `code_grep` does.
5. Because `writes: false`, the tool works in read-only Code sessions, and
   `isCodeWriteTool` stays false for it.
6. Guide: a "The Search helper" section in `docs/guide/helpers.md`: what to
   turn on, what the agent gets back, that it searches the session folder's
   text files (gitignored files skipped, tests ranked lower), that it works in
   read-only sessions, and that it doesn't understand code structure (it
   matches words). Change "Helpers work in the Code tab only, not in a
   read-only session" to say the 3D helper is the one that needs a session that
   can write. Keep the page under 6 KB.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`,
`node scripts/guide-check.mjs` (the Guide check).

## Test plan

- `search-code.test.ts` (with `invoke` mocked): formatting; merging touching
  snippets in one file; the no-match message; the "No working directory set."
  error; the WSL arg passed through.
- The helper registry test sees `search` own `search_code` with
  `writes: false`.
- `registry.helpers.test.ts`: `search_code` is offered only in the Code tab
  with Search on, and stays offered in a read-only session; `check_3d` is
  dropped in a read-only session.
- Manual in the dev app: turn Search on, ask a Code session "where does the
  message box grow as I type?" in the Haruspex checkout; the agent calls
  `search_code` and `src/lib/utils/autosize.ts` is in the result.

## Commit

`feat(helpers): Search helper, keyword-ranked code snippets from a plain-words question`

## Rollback

Revert the commit. The helper's switch stays in users' `codeHelpers` as an
unknown id, which the card ignores.
