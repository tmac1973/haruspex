# Phase 05 — Eligibility registry and the post-commit resolution pass

**Depends on:** 01, 02, 03, 04 · **Enables:** the renderer having a
hash-per-URL map to substitute from.

## Goal

Decide which image URLs in a finished reply are allowed to be fetched, resolve
them through Phase 01's command after the message commits, and expose the
results as reactive state the renderer can read. This is where the
prompt-injection defence lives: a URL is only ever fetched if this
conversation's own tool results produced it.

## Files touched

- `src/lib/images/eligible.svelte.ts` — **new.** Per-conversation set of
  fetchable URLs, built from tool results.
- `src/lib/images/resolve.svelte.ts` — **new.** The post-commit pass and the
  reactive `url → ResolvedImage` map.
- `src/lib/stores/chat.svelte.ts` — record eligible URLs as tool steps
  complete; kick off resolution at the end of `finalizeStreamedTurn`
  (line 1134); rehydrate the map when a conversation is loaded.
- `src/lib/agent/tools/web.ts` — register `image_search` result URLs and
  `[Image: …]` URLs into the eligibility set as each tool returns.

## Steps

1. **Eligibility set.** Keyed by conversation id, holding a `Map<url,
ImageRequest>` — the URL plus whatever provenance the tool already knew
   (`source`, `license`, `attribution`, `description_url`). Populated from
   exactly two places:
   - every result of an `image_search` call, with full provenance;
   - every `[Image: …]` URL from a `fetch_url` / `research_url` result, with
     `source = 'page_og'` and no licence.

   Nothing else may add to this set. A URL the model wrote that is not in it is
   **never fetched**, which is what stops an injected `![](attacker-url)`
   beacon firing and stops a hallucinated image URL producing a request.

2. **Extraction.** After commit, scan the final message text for
   `![alt](url)` refs using the existing `MARKDOWN_LINK_RE` shape from
   `markdown.ts:525` rather than a new regex. Intersect the found URLs with the
   eligibility set. Cap at **3 per message**, taking the first three in
   document order — the prompt asks for 1–3, and this is the enforcement that
   does not rely on the model obeying.

3. **Resolution.** Call `image_resolve(conversationId, requests, proxy)` with
   the intersected requests. It runs **after** `commitMessage`, not before, so
   the message is on screen and marked done while images are still in flight.
   `finalizeStreamedTurn` stays synchronous; the pass is fired and not awaited.

4. **Reactive map.** Results land in a `$state` map keyed by source URL. The
   renderer reads it, so images appear as each resolves. URLs that resolve to
   nothing stay absent from the map forever — that is what "drop silently"
   means in practice, and it needs no error state.

5. **Rehydration.** When an existing conversation is opened, collect the image
   URLs from its stored messages and look them up in the `images` table by
   `source_url`. Hits populate the map immediately with no network request,
   which is what makes reopening a week-old conversation render from cache with
   **zero** outbound requests. Misses are left absent — see below.

   Rehydration is the one path where the eligibility set is not available,
   because the tool steps that built it are long gone. So it is a **lookup
   only, never a fetch**: a cached row proves the URL was eligible when it was
   first fetched, and the table carries that authorisation forward, but a miss
   proves nothing. An image evicted by the LRU therefore stays absent on reopen
   rather than being re-fetched from a URL nothing can now vouch for. It
   renders as nothing, exactly like any other unresolved image — the cost of
   this choice is a picture that quietly disappears from an old conversation,
   and the benefit is that no stored message can ever trigger a fetch the
   eligibility rules did not approve.

6. **Cancellation.** If the conversation is switched or deleted while a
   resolution is in flight, drop the results rather than writing them into the
   map of whatever conversation is now open.

## Build gate

```bash
npm run check && npm run lint && npm run test
```

## Test plan

- **Unit:** a URL in the reply but absent from the eligibility set is not
  passed to `image_resolve`. This is the injection test and it is the most
  important assertion in the phase.
- **Unit:** a reply containing five eligible image refs resolves exactly three.
- **Unit:** `image_search` results and `[Image: …]` headers both populate the
  eligibility set; a bare URL in page _text_ does not.
- **Unit:** a resolve that returns nothing for a URL leaves the map without
  that key and raises no error.
- **Unit:** rehydration is lookup-only — a stored URL with no `images` row
  issues no fetch and stays absent from the map.
- **Unit:** switching conversation mid-flight discards the in-flight results.
- **Manual:** ask a question that yields images, watch the message commit
  immediately, and confirm images arrive shortly after without the "done" state
  being delayed.

## Commit

```
feat(images): resolve reply images against a per-conversation allowlist
```

## Rollback

Revert the commit. The map is in-memory only, so nothing persists that needs
undoing; cached rows from Phase 01 remain and are simply unused. Rendering does
not consume the map until Phase 06, so backing this out alone changes nothing
the user can see.
