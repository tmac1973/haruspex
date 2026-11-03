# Search helper (`search_code`) — Project Overview

## Problem

The Code tab's agent finds code with `code_grep`, `code_glob` and
`fs_read_text`. That works, but it's slow and expensive when the user asks in
plain words ("where does the message box grow as I type?"): the agent has to
guess identifiers, grep, read, guess again. `code_grep` returns up to 50
matching lines in file order, with no ranking, so the agent reads files to find
out which hit mattered.

The #951 spike measured this on Haruspex itself, with ten "where is X" and
"change Y" tasks and Qwen 3.8. Grep and read alone found the right file 20/20
times, at a median of 11.5 turns and 98.5k prompt tokens a task. A ranked
search tool that returned six snippets cut that to 9.0 turns and 64.6k tokens
with keyword ranking alone, and to 7.5 turns and 60.4k tokens with
Qwen3-Reranker-0.6B on top. Accuracy didn't change. The reranker mattered most
on vague questions: it put the right file in the top six for 10/10 tasks,
keyword ranking for 6/10. A rerank of 100 chunks took about 2 s.

## Goals

- A **Search** helper in Settings → Code → Helpers, off by default, owning
  one tool: `search_code(query, path?)`.
- `search_code` turns a plain-words query into a ranked list of code chunks and
  returns the best few as snippets with paths and line numbers.
- **Keyword ranking** with no setup: query words scored over chunks of the
  session folder's files on each call, so results are always fresh.
- **An optional reranker**: an endpoint set on the Search row (URL, an API key
  from Settings → Inference → API Keys, and a model picked from the server's
  rerank models). When one is set, keyword candidates are reranked by it; when
  it's empty or fails, keyword ranking stands and the result says so.
- **An optional embedding index**, in a later phase: an embedding endpoint on
  the same row. When set, the helper keeps a per-project index of chunk
  embeddings, refreshed incrementally before each search (only changed files
  are re-embedded), and merges vector-search candidates with keyword ones before
  ranking. Whether it stays is decided by a measured rerun.
- The first per-helper settings in the helper registry, so a helper can carry
  configuration as well as a switch.
- A Search section on the user guide's `helpers` page (3.1 KB today, so it
  stays under 6 KB), describing the helper, the two optional endpoints and
  what it does not do.

## Non-goals

- No other uses of reranking in this plan: `load_tools` shortlisting, memory
  recall and `haruspex_docs` lookup stay separate items on #951.
- No global "reranker server" in Settings → Inference; the endpoint belongs to
  the helper.
- No system-prompt line telling the agent to search first; the tool's
  description carries that, unless the live rerun shows it's needed.
- No change to `code_grep`, `code_glob` or `fs_read_text`.
- Not in Chat, the Shell, Shell Code mode, jobs or subtasks: Code tab only, like
  every helper.
- No bundled reranker or embedding model, and no sidecar for one. The user
  points the helper at a server they run (llama-toolchest, llama-server with
  `--reranking` / `--embedding`, or anything with `/v1/rerank` and
  `/v1/embeddings`).
- No symbol index, call graph or language server.

## Users & primary flow

The user is a Haruspex owner working in a Code session on a project of any
size; the agent is whatever model the session runs.

1. The user turns on **Search** in Settings → Code → Helpers. Optionally they
   set a reranker on the same row: a server URL, a key if it needs one, and a
   model from its rerank models.
2. In a Code session they ask: "where's the code that decides which cards are
   greyed out in Add card?"
3. The agent calls `search_code` with the question in plain words.
4. The helper scores chunks of the project's files by the query's words, takes
   the top 100, reranks them if a reranker is set, and returns the top six
   snippets with paths and line ranges.
5. The agent reads around the best snippet with `fs_read_text`, or greps for an
   identifier the snippet showed it, and answers or edits.
6. Later, with an embedding endpoint set, the first search in a project starts
   building the index in the background; until it's ready, searches are keyword
   (plus reranker) only, and the result says the index is still building.

## Constraints

- Tauri 2 + SvelteKit 5 (runes). File walking and chunk scoring run in Rust
  beside `code_grep` (`src-tauri/src/code_tools/search.rs`), gitignore-aware and
  WSL-aware like it. Calls to rerank and embedding servers go through Rust too,
  since webview fetches to toolchest lack CORS on some routes.
- The helper registry (`src/lib/helpers/registry.ts`) and the Helpers card
  (`HelpersSection.svelte`) exist; today a helper has only an on/off switch
  (`codeHelpers` in `stores/settings.ts`). Settings stay plain JSON.
- Endpoint fields follow `SpecialistEntry`'s shape (URL, `keyId`, model).
  Models are listed from the server's `GET /v1/models`, not the inference
  probe, because toolchest's probe lists only chat models.
- A reranker call must not stall the agent: a timeout falls back to keyword
  ranking.
- Tool output stays small: about six snippets of up to 30 lines.
- New Tauri commands or `#[ts(export)]` structs mean
  `./scripts/export-ipc-types.sh`. UI copy is one short sentence per section,
  with detail in `title` tooltips.
- A user-visible change updates `docs/guide/` in the same PR; pages stay under
  6 KB.

## Success criteria

- Settings → Code → Helpers shows **Search**, off by default; turning it on
  offers `search_code` to the next Code turn, turning it off removes it.
- With no endpoint set, `search_code` returns keyword-ranked snippets; with a
  reranker set, reranked ones; with a reranker that's down, keyword-ranked ones
  and a note.
- Unit tests cover chunking, scoring, the fallback, and loading and saving
  the helper's settings.
- Live rerun: the spike's ten tasks in the real app over the Remote control
  API, Qwen 3.8 on compute:3000, two repeats per arm (baseline, Search without a
  reranker, Search with Qwen3-Reranker-0.6B). Both Search arms match baseline
  accuracy and have fewer median turns and prompt tokens than baseline. If
  they don't, even after one stronger tool description, the helper ships as
  it is (off by default) and the embedding phases are not started.
- For the embedding phase: the same rerun with an embedding endpoint added, and
  the result written up; the index refreshes after a file edit without a full
  rebuild.

## Decisions

- **Default state** → off, like every helper.
- **Where the reranker endpoint lives** → on the Search row in Settings → Code
  → Helpers (URL, API key, model filtered to rerank models). Empty means keyword
  ranking.
- **How candidates are found** → keyword scoring on each call, no index, in
  the first version.
- **Embedding index** → optional, added in a later phase; candidates from
  keyword and vector search are merged when an embedding endpoint is set.
  Updated incrementally by file hash; keyword-only until the first build ends.
- **Pushing the agent to search first** → the tool description only.
- **Done and good** → the live rerun of the spike's ten tasks beats baseline on
  turns and tokens with the same accuracy, with and without the reranker.
- **Rust and TypeScript** → Rust finds and keyword-scores candidates
  (`code_search_candidates`) and has a generic rerank client
  (`rerank_documents`, reusable for memory recall); the TS tool orchestrates,
  falls back and formats.
- **Helper settings** → a generic per-helper blob (`codeHelperConfig`), parsed
  by the helper, with a settings component the card shows under the switch.
- **Chunking** → fixed 30-line half-overlapping windows, as in the spike.
- **Which files** → every gitignore-aware text file under 1 MB, binaries and
  lockfiles skipped; tests and generated files kept but scored at half.
- **Embedding source** → an endpoint only; not the on-device BGE-small memory
  embedder.
- **Index store** → one SQLite file per project and model in the app's data
  folder (`code_index/`), pruned after 30 days unused.
