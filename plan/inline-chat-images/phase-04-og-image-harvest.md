# Phase 04 — Harvest `og:image` during research

**Depends on:** nothing · **Enables:** the resolution pass having a topical
image for pages the answer actually cites — the one source guaranteed to match
what was researched.

## Goal

Every research turn already fetches 2–4 pages. Their HTML is already parsed.
Capture each page's hero image while it is in hand and surface the URL to the
model alongside the `[Source: <url>]` header it already receives, so an image
can be chosen from a page that was genuinely read. This runs whether or not the
Include images toggle is on, because the parse is free and it keeps explicit
"show me a picture" requests working with the toggle off.

## Files touched

- `src-tauri/src/proxy/extract.rs` — extract `og:image` (falling back to
  `twitter:image`, then `link rel="image_src"`) while the page is being parsed
  for text, and return it on the existing fetch result struct.
- `src-tauri/src/proxy/images/mod.rs` — reuse the existing absolute-URL
  resolution from `extract_page_images` rather than writing a second copy.
- `src/lib/agent/tools/web.ts` — `fetch_url` and `research_url` render the
  harvested URL into their result text.
- `src/lib/ipc/gen/` — regenerated for the widened fetch result struct.

## Steps

1. **Extract.** In the existing page parse, read in order: `og:image`,
   `twitter:image`, `link rel="image_src"`. First hit wins. Resolve relative
   values against the response's final URL after redirects, exactly as
   `proxy_fetch_url_images` already does at `proxy/images.rs:56`.

2. **Filter the obvious junk** before returning anything: drop `data:` URLs,
   drop URLs whose path suggests a sprite, logo, icon, avatar or placeholder,
   and drop anything that does not parse as an absolute HTTP(S) URL after
   resolution. Nothing here fetches the image — that is Phase 01's job, and it
   only happens if the model actually cites it.

3. **Surface to the model.** Where a fetch result currently opens with:

   ```
   [Source: https://example.com/article]
   ```

   it becomes:

   ```
   [Source: https://example.com/article]
   [Image: https://example.com/hero.jpg]
   ```

   The `[Image: …]` line is omitted entirely when no hero image was found, so
   the model never sees an empty field to fill in. One line, same shape as the
   header the model already handles — this is deliberately the smallest
   possible change to a prompt surface a 9B is already coping with.

4. **Provenance convention.** This phase writes nothing to the database and
   fetches no image — it only surfaces a URL. The convention it establishes is
   that anything arriving via an `[Image: …]` line is tagged `source =
'page_og'` when it is later handed to `image_resolve`, which by Phase 01's
   rules forces `license = 'unknown'` and `embeddable = 0` regardless of
   anything the page claims. That tagging happens in Phase 05, where the
   eligibility set is built. Recording it this way is what keeps the future
   document-embedding PR safe by construction: it filters on `embeddable`, and
   a scraped image can never set it.

5. **No new tool.** `fetch_url_images` still exists, unchanged, for the
   explicit "find images on this page" case. This phase adds no schema surface.

## Build gate

```bash
cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test
./scripts/export-ipc-types.sh   # must produce no uncommitted diff
cd .. && npm run check && npm run lint && npm run test
```

## Test plan

- **Rust unit:** extraction precedence over HTML fixtures — `og:image` wins
  over `twitter:image` wins over `link rel="image_src"`; a page with none
  yields `None`.
- **Rust unit:** a relative `og:image` resolves against the post-redirect URL,
  not the requested one.
- **Rust unit:** the junk filter drops `data:` URLs and paths containing
  `sprite`, `logo`, `icon`, `avatar`, `placeholder`.
- **TS unit** in `web.test.ts`: the `[Image: …]` line appears when a hero image
  is present and the line is absent — not empty — when it is not.
- **Manual:** run a normal research question and inspect the tool-step results
  in the log viewer to confirm the header line appears on real pages.
- **Manual:** confirm no image is fetched by this phase — the network shows
  only the page fetches that were already happening.

## Commit

```
feat(images): surface each researched page's hero image to the model
```

## Rollback

Revert the commit. Fetch results return to a `[Source: …]` header alone. No
schema, no cache and no rendering is involved, so this is safe to back out on
its own at any point.
