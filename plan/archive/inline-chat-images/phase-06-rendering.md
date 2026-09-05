# Phase 06 — Rendering: substitution, attribution captions, hide-until-resolved

**Depends on:** 05 · **Enables:** the toggle in Phase 07 having something worth
switching on.

## Goal

Make images actually appear. `renderMarkdown` learns to swap a resolved image
URL for its `haruspex-img://` source, attach a licence caption built from
stored provenance, and render nothing at all for anything unresolved. After
this phase the feature works end to end for anyone who asks for images
explicitly; Phase 07 only adds the nudge.

## Files touched

- `src/lib/markdown.ts` — `renderMarkdown` takes an optional resolved-image
  map; `sanitizeForRender` (line 361) drops unresolved image refs.
- `src/lib/images/caption.ts` — **new.** Provenance → caption HTML.
- `src/lib/components/ChatMessage.svelte` — pass the map into `renderMarkdown`
  at line 57.
- `src/lib/sanitize.ts` — allow the `figure`, `figcaption` and `haruspex-img:`
  URI shape through DOMPurify.
- `src-tauri/tauri.conf.json` — drop `https:` and `http:` from `img-src`.
- `src/routes/+layout.svelte` — styles for the figure and caption.

## Steps

1. **Signature.** `renderMarkdown(text, resolved?: ReadonlyMap<string,
ResolvedImage>)`. The parameter is optional and defaults to empty, so every
   existing caller — the shell assistant, job run views, the guided-planning
   pipeline — keeps working untouched and simply renders no images. The
   function stays **synchronous and pure**, which is what lets it keep being
   called from a `$derived` on every streaming chunk.

2. **Substitution.** Extend the existing image handling in `sanitizeForRender`
   at line 371. Today it keeps `http(s):`/`data:` refs and drops the rest. It
   becomes:
   - URL present in `resolved` → rewrite to a `<figure>` with the
     `haruspex-img://<hash>` source and a `<figcaption>`.
   - URL absent → **drop the ref entirely**, exactly as relative paths are
     dropped today. This single rule covers three cases with one behaviour:
     still resolving, failed to fetch, and never eligible. All three render as
     nothing, so a failure is indistinguishable from a slow load and neither
     produces a broken icon.
   - A bare remote `http(s):` image URL is no longer passed through. That is
     the change that guarantees no image request originates from the webview.

3. **Caption.** Built by `caption.ts` from the stored row, never from anything
   the model wrote:
   - `pd` → no caption. Public domain requires none.
   - `cc-by-*` → `<creator> · <licence>`, the licence text linking to
     `description_url`.
   - `unknown` (every `page_og` image) → the page's hostname, linked to
     `description_url`. Honest about the source without claiming a licence the
     app has not verified.
   - Missing creator → source name alone. Never render an empty caption or the
     word "unknown" to the user.

4. **Sanitiser.** `figure` and `figcaption` are not in DOMPurify's forbidden
   list, but confirm they survive and that `haruspex-img:` is not stripped from
   `src` — DOMPurify allows unknown schemes only if configured to, so add it to
   `ALLOWED_URI_REGEXP` explicitly rather than assuming. The existing
   `FORBID_TAGS` list is unchanged.

5. **Styling.** Constrain to `max-width: 100%`, cap the height so a tall image
   cannot dominate a reply, round the corners to match existing message
   surfaces, and set the caption in the muted secondary text colour at a
   smaller size. Give the figure explicit margins so text does not crowd it
   when images land after commit.

6. **Tighten the CSP.** Remove `https:` and `http:` from the `img-src`
   directive in `tauri.conf.json:24`, leaving:

   ```
   img-src 'self' data: blob: haruspex-img: http://haruspex-img.localhost;
   ```

   Audited on 2026-08-30: every `<img>` in the app already uses `data:` or
   `blob:` — chat attachments via `readAsDataURL` (`utils/image.ts:17`),
   sandbox artifacts converted to data URLs (`sandbox/worker-manager.ts:90`),
   and search-step thumbnails via `thumbDataUrl`. Nothing loads a remote image,
   so nothing breaks. This turns "no image request originates from the webview"
   from a property of the renderer's logic into one the browser enforces: even
   a future bug that lets a remote URL through cannot produce a request.

7. **Reflow.** Images appear after the message commits, so content below them
   shifts once. Accept the single shift rather than reserving space:
   dimensions are known only after the fetch, and a reserved box that never
   fills is the broken-placeholder look already ruled out.

## Build gate

```bash
npm run check && npm run lint && npm run test
```

## Test plan

- **Unit:** a resolved URL renders a `figure` with a `haruspex-img://` source.
- **Unit:** an unresolved URL renders nothing — no `img`, no placeholder, no
  alt text — and the surrounding prose is intact.
- **Unit:** a bare remote `https://…` image URL not in the map renders nothing.
  This is the assertion that enforces the no-webview-fetch guarantee.
- **Unit:** caption text for each licence class, including the no-caption
  public-domain case and the missing-creator fallback.
- **Unit:** `renderMarkdown(text)` with no second argument behaves exactly as
  before for every existing caller — run the existing `markdown.test.ts` suite
  unchanged as the regression proof.
- **Unit:** the sanitiser preserves `haruspex-img:` in `src` and still strips
  `javascript:`.
- **Manual:** ask for images explicitly with the toggle still absent, and
  confirm they render with correct captions in both light and dark themes.
- **Manual:** confirm with devtools that the only image requests are custom
  scheme loads.
- **Manual, CSP regression:** after tightening `img-src`, re-check the three
  existing image surfaces still render — a dropped chat attachment, a
  matplotlib plot from the Python sandbox, and an `fs_read_image` thumbnail in
  a tool step. These are the paths the CSP change could break.
- **Manual:** paste `<img src="https://example.com/x.png">` into a reply via a
  crafted tool result and confirm the browser blocks it with a CSP violation in
  the console — proof the guarantee is enforced below the renderer.

## Commit

```
feat(images): render cached images inline with licence attribution
```

## Rollback

Revert the commit, **including the `tauri.conf.json` CSP line** — leaving the
tightened `img-src` in place without the renderer change is harmless today, but
reverting both together keeps the config matching the code. `renderMarkdown`
returns to its single-argument form and images stop rendering; the cache,
protocol and resolution map are all unaffected and inert. Because the second
parameter is optional, a partial revert that leaves callers passing a map still
compiles — but revert the whole commit rather than relying on that.
