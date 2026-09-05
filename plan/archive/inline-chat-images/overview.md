# Inline Chat Images — Project Overview

Locked 2026-08-30.

## Problem

Haruspex can already find images and can already render them. `image_search`
(Wikimedia Commons) and `fetch_url_images` have shipped for months, the CSP
allows `img-src … https: http:`, DOMPurify permits `<img>`, and
`markdown.ts:375` deliberately preserves `![alt](url)` whenever the source is
`http(s):` or `data:`. Nothing is blocking display.

Images still almost never appear. Four reasons, all fixable:

1. **The system prompt never mentions images.** `system-prompt.ts` has sections
   for search, citations, filesystem, email and the Python sandbox. It says
   nothing about `image_search`. The model has the tool and no reason to reach
   for it.
2. **The tool description points away from chat.** It ends with _"safe to embed
   in documents or presentations"_ — which is exactly where the capability does
   get used today, and exactly where it was not needed.
3. **Wikimedia Commons is a narrow corpus.** Strong on landmarks, animals and
   historical subjects; nearly empty for consumer products, current events, and
   most people. That is most of what gets researched.
4. **Image results are invisible.** `image_search` returns raw JSON to the
   model and never sets `thumbDataUrl`, so the step renders a 🖼️ label with no
   preview (`SearchStep.svelte:239`). The user cannot see what was found.

There is also a privacy gap that is currently masked by how rarely images
appear. An inline `<img src="https://…">` is fetched **by the webview,
directly**. The proxy the user configured lives in `build_fetch_client` on the
Rust side; WebKitGTK and WebView2 know nothing about it. So a user who set up
an HTTP proxy to anonymise their research gets their searches proxied and their
images not. Make images common and that becomes the app's largest un-proxied
egress path, inside the feature whose entire premise is privacy.

## Goals

- An **Include images** toggle in Settings → General, off by default, that
  nudges the model to include topical images in chat answers.
- Widen sourcing beyond Commons to **Wikipedia lead images**, **Openverse**,
  and **`og:image` harvested from pages already being fetched during research**
  — all of which work with no API key, on the free search path.
- **Route every image fetch through Rust**, so image traffic honours the user's
  proxy settings and the existing `validate_url` SSRF guard, exactly like every
  other network egress in the app.
- **Cache image bytes on disk** so reopening an old conversation neither
  re-pings third-party hosts nor shows broken images after link rot.
- **Record provenance** (source, licence, attribution, description URL) for
  every cached image, and render an attribution caption where the licence
  requires one.
- **Future-proof** for a later PR that puts properly-licensed images into
  presentations and documents, by recording enough licence detail now to decide
  later — without building any of that here.

## Non-goals

- **No document or presentation embedding.** No changes to `fs_write_pptx`,
  `fs_write_docx`, `fs_write_pdf` or any other write tool. This work only makes
  the future PR possible; it does not start it.
- **No images for remote web-chat guests.** The LAN chat server stays
  text-only. Cached bytes are never served over the unencrypted guest
  connection.
- **No images in jobs or the Shell tab.** Chat only.
- **No paid or self-hosted-only sources.** Brave's image API and SearXNG's
  `categories=images` are both deliberately excluded: the key-based and
  self-hosted paths serve a small minority of users, and anything built here
  has to work on the free default rotation.
- **No gating.** The toggle changes the prompt and nothing else. With it off,
  "show me a picture of X" still works, and the model may still offer images on
  its own — both behave exactly as they do today.
- **No thumbnail previews in the tool-step UI.** `image_search` steps keep
  their current label-only rendering; the images that matter now land in the
  reply itself.
- **No image generation.** Sourcing only.

## Users & primary flow

A non-technical user on the default free search path, running the default local
model (Qwen 3.5 9B), who wants research answers that look like a page rather
than a wall of text.

1. User turns on **Settings → General → Include images**.
2. User asks a topical question — _"What is a red panda?"_, _"Compare the
   ThinkPad X1 and the MacBook Air"_.
3. The turn runs as it does today: `web_search`, then `fetch_url` /
   `research_url` on the best results. Each fetch result now carries the page's
   `og:image` URL alongside its existing `[Source: <url>]` header.
4. Where the answer would benefit, the model calls `image_search`. One tool,
   unchanged name and signature; behind it Rust queries Openverse, Commons and
   Wikipedia and returns merged results tagged with source and licence.
5. The model writes 1–3 inline `![alt](url)` refs into its reply.
6. At render time the frontend asks the backend for each image. Rust fetches it
   through the user's proxy, validates it, caches the bytes, records
   provenance, and returns a local source. The webview never touches the
   third-party host.
7. Each image renders inline with a small muted caption — creator, licence,
   linked to the source page — generated from stored provenance, not from
   anything the model wrote.
8. Images the backend cannot fetch are dropped silently; the prose is
   unaffected.
9. Reopening the conversation later renders from cache. No new network
   requests, no broken images.
10. Deleting the conversation deletes the image bytes it alone referenced.

## Constraints

- **Free sources only.** Verified working anonymously on 2026-08-30:
  Openverse (`api.openverse.org/v1/images/`, HTTP 200, 240 results for
  "red panda", returns `license`, `license_version`, `creator`,
  `foreign_landing_url`); Wikipedia REST summary
  (`/api/rest_v1/page/summary/<title>`, returns `originalimage`).
  Openverse rate-limits anonymous callers, so 429 must be handled with backoff
  rather than treated as an error.
- **Wikipedia lead images are usually good, but not always Commons.** Spot
  checked 2026-08-30: `Red_panda`, `Tesla_Model_3`, `Ada_Lovelace`, `Kyoto` and
  `ThinkPad` all returned strong representative photos under
  `upload.wikimedia.org/wikipedia/commons/`. `Eiffel_Tower` returned a **logo**
  under `upload.wikimedia.org/wikipedia/en/` — an en-wiki-local upload. Local
  en-wiki files are frequently non-free fair-use logos that must not be
  redistributed, so **only `/wikipedia/commons/` paths are accepted**; anything
  under `/wikipedia/en/` is discarded.
- **Openverse licences are mixed, and a third are restrictive.** A 20-result
  sample for "iphone" on 2026-08-30 returned `by-nc` ×7, `by-sa` ×6, `by` ×5,
  `by-nc-nd` ×1, `by-nc-sa` ×1. So embeddability cannot be derived from the
  source — it has to be derived from the specific licence code. NC and ND
  images are fine to display and are not safely redistributable in a document.
- **Small-model tool budget.** Every tool added to the schema costs quality on
  a 9B. The three new sources must not add three new tools.
- **Existing patterns to follow.** `getResponseFormatPrompt()`
  (`settings.ts:1212`) is the precedent for a Settings-driven prompt fragment.
  `build_fetch_client` / `validate_url` (`proxy/extract.rs`) are the precedent
  for outbound fetches. `db/mod.rs:409` `migrate()` is the precedent for
  additive schema migration. `fs_download_url` is the precedent for a
  size-capped, format-checked binary fetch.
- **CSP.** Serving cached bytes to the webview needs an addition to the
  `img-src` directive in `tauri.conf.json:24`.
- **Platforms.** Linux, Windows and macOS, all through the same Tauri webview
  abstraction. No platform-specific image handling.

## Success criteria

- With the toggle **on**, a topical research question on **Qwen 3.5 9B**
  produces 1–3 relevant inline images without the user asking for them.
- With the toggle **off**, chat behaviour is byte-for-byte what it is today:
  no image prompt fragment, tools still present, "show me a picture of X" still
  works, and an unprompted offer from the model still works.
- **No image request originates from the webview.** Verifiable by watching
  network traffic during an image-bearing turn: every image byte arrives over
  IPC from the Rust side.
- With an HTTP proxy configured, image fetches go through it — same as search.
- Every displayed image whose licence requires attribution carries a caption
  naming the creator and licence, linked to its source page.
- Reopening a week-old image-bearing conversation renders every image from
  cache with **zero** outbound requests.
- Deleting that conversation removes its image bytes from disk.
- An image whose source host is down renders as prose with no gap, no broken
  icon and no error toast.
- `make check` passes: `cargo clippy`, `cargo fmt --check`, `cargo test`,
  `npm run check`, `npm run lint`, `npm run test`, and the CI drift guards.

## Decisions

- **Remote web-chat guests** → Local Chat tab only. Guests stay text-only; no
  cached bytes cross the unencrypted LAN connection.
- **Fetch failure behaviour** → Remove the image markdown silently, leaving the
  prose intact. Matches how `markdown.ts` already drops relative-path refs.
- **Cache lifetime** → Tied to conversations, plus a global size cap. Deleting
  the last conversation referencing an image deletes its bytes; a size cap
  evicts least-recently-used beyond that.
- **Images per answer** → 1–3, only where they add something. A hard cap in the
  prompt is what stops a 9B pasting an image after every paragraph.
- **Attribution** → Always a small caption line under every image, generated by
  the renderer from stored provenance so it cannot be hallucinated or omitted.
- **`og:image` harvesting** → Always harvest, and surface the URL in the
  `fetch_url` / `research_url` result alongside the existing `[Source: <url>]`
  header, regardless of the toggle. The HTML is already in hand, so it costs
  nothing, and it keeps explicit image requests working with the toggle off.
- **Tool surface** → One `image_search` tool, unchanged name and signature,
  with Openverse, Commons and Wikipedia queried and merged behind it. No new
  tools in the schema.
- **Success bar** → Images must appear unprompted on the default 9B with the
  toggle on. Mechanism-only is not enough.
- **Image loading transport** → Proxied through Rust with an on-disk cache,
  rather than direct webview fetches. Chosen because it is the only option
  consistent with the app's proxy settings, the only one that stops old
  conversations re-pinging hosts, and the only one that leaves the bytes and
  licence metadata on disk for the future document-embedding PR.
