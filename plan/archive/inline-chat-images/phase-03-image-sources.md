# Phase 03 — Openverse, Wikipedia and the merged `image_search`

**Depends on:** 01 (licence normalisation and the provenance shape) ·
**Enables:** the resolution pass having properly-licensed candidates to work
with.

## Goal

Widen sourcing from Commons alone to Openverse, Commons and Wikipedia lead
images, queried in parallel behind the **existing** `image_search` tool. The
tool's name, parameters and description shape stay as they are, so the model's
schema does not grow — the change is entirely behind `proxy_image_search`.

## Files touched

- `src-tauri/src/proxy/images/openverse.rs` — **new.** Openverse client.
- `src-tauri/src/proxy/images/wikipedia.rs` — **new.** Lead-image client.
- `src-tauri/src/proxy/images/commons.rs` — the existing Commons search, moved
  out of `proxy/images.rs` unchanged in behaviour.
- `src-tauri/src/proxy/images/mod.rs` — the merge, and the existing
  `proxy_fetch_url_images` / `extract_page_images`, which do not change.
- `src/lib/agent/tools/web.ts` — update only the `image_search` **description**
  (lines 183–186): drop "Wikimedia Commons" for "freely-licensed images", and
  drop the trailing "safe to embed in documents or presentations" clause, which
  is what steers the model away from chat today. Parameters unchanged.
- `src/lib/ipc/gen/ImageSearchResult.ts` — regenerated with the new fields.

## Steps

1. **Openverse client.** `GET https://api.openverse.org/v1/images/?q=<query>&page_size=<n>`.
   Verified working anonymously on 2026-08-30 (HTTP 200, 240 results for
   "red panda"). Map: `url` → image URL, `thumbnail` → thumb,
   `license` + `license_version` → the licence string, `creator` →
   attribution, `foreign_landing_url` → description URL, `width`/`height`.
   - **Rate limiting.** Anonymous callers are limited. On HTTP 429, back off
     and return **no results from this source** — never an error for the whole
     search. One rate-limited source must not fail a three-source query.
   - Send the app's existing `USER_AGENT` from `proxy::extract`.

2. **Wikipedia client.**
   `GET https://en.wikipedia.org/api/rest_v1/page/summary/<title>`, taking
   `originalimage.source`. Verified 2026-08-30: `Red_panda`, `Tesla_Model_3`,
   `Ada_Lovelace`, `Kyoto` and `ThinkPad` all return strong representative
   photographs.
   - **Accept only `upload.wikimedia.org/wikipedia/commons/` URLs. Discard
     anything under `/wikipedia/en/`.** `Eiffel_Tower` returns a logo from
     the en-wiki-local namespace, and local en-wiki uploads are frequently
     non-free fair-use files that must not be redistributed. This filter is
     the phase's most important correctness rule.
   - Because accepted files are Commons-hosted, resolve their licence and
     attribution through the **existing** Commons `imageinfo` path rather than
     inventing a second metadata route.
   - The query is used as the page title after normalisation (spaces to
     underscores). A 404 means no such page: return no results, not an error.

3. **Commons.** Move as-is. The two-call `list=search` →
   `imageinfo` flow at `proxy/images.rs:240–287` is unchanged.

4. **Merge.** Query all three concurrently. Interleave results round-robin —
   Openverse, Commons, Wikipedia, Openverse, … — up to the caller's
   `max_results`, so the model sees variety rather than 20 results from
   whichever source is fastest. Deduplicate by image URL. A source that errors,
   times out or rate-limits contributes zero results and is otherwise ignored.
   If **all three** fail, return the existing empty-results note so the model
   gets the same "try a different query" hint it does today.

5. **Result shape.** Extend `ImageSearchResult` with `source`
   (`'openverse' | 'commons' | 'wikipedia'`), the normalised `license` code and
   `embeddable` from Phase 01's `license.rs`. Keep every existing field so the
   presentation-building path that already consumes this tool keeps working
   unchanged.

6. **Tool description.** Reword to describe images for answers as well as
   documents, and state that results carry attribution. Do not add parameters
   and do not add tools — the small-model tool budget is a stated constraint.

7. Run `./scripts/export-ipc-types.sh` and commit the regenerated types.

## Build gate

```bash
cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test
./scripts/export-ipc-types.sh   # must produce no uncommitted diff
cd .. && npm run check && npm run lint && npm run test
```

## Test plan

- **Rust unit, offline:** parser tests against recorded JSON fixtures captured
  from all three APIs, so the suite does not depend on the network.
- **Rust unit:** the Wikipedia filter — a fixture whose `originalimage.source`
  is under `/wikipedia/en/` yields **no** result; one under
  `/wikipedia/commons/` yields one.
- **Rust unit:** merge interleaving with three sources of differing lengths,
  and with one, two, then all three returning nothing.
- **Rust unit:** an Openverse 429 contributes no results and does not fail the
  merged search.
- **Manual:** in the app, ask "search for images of a red panda" and confirm
  results arrive from more than one source, each carrying licence and
  attribution.
- **Manual regression:** the existing research → presentation flow that used
  `image_search` still produces a deck, proving the shape change is
  backward-compatible.

## Commit

```
feat(images): query Openverse, Commons and Wikipedia behind image_search
```

## Rollback

Revert the commit. `image_search` returns to Commons-only with its original
description. Phases 01 and 02 are unaffected. No schema or cache change is
involved, so there is nothing to migrate back.
