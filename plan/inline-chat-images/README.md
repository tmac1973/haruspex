# Inline Chat Images — Implementation Plan

Phased, dependency-ordered plan for putting topical images into chat answers:
an **Include images** toggle in Settings → General, three new image sources
alongside Wikimedia Commons, and every image fetched by Rust through the user's
proxy into an on-disk cache rather than by the webview. See
[`overview.md`](./overview.md) for the problem statement, the verified API
findings, and the Decisions appendix.

## Build status

Locked 2026-08-30. All seven phases implemented 2026-08-30, pending manual
verification on Linux, Windows and macOS. `make check` passes.

Four things the plan did not anticipate, each recorded in its phase's commit:

- **AVIF is rejected at the header** (phase 01). The `image` crate already in
  the tree pulls in `ravif`, an _encoder_; decoding needs `avif-native` and
  libdav1d on all three platforms. Accepting the type would mean downloading up
  to 5 MB and always failing the decode gate.
- **The hash goes in the URL path, not the host** (phase 02). A DNS label caps
  at 63 characters and a sha256 digest is 64, so a hash-as-host URL is
  malformed before it reaches the handler. Tauri's own `asset://localhost/`
  uses the same host-plus-path shape.
- **`$state(new Map())` is not reactive** (phase 05). Svelte 5 does not make a
  Map's contents reactive, so resolved images would have landed in the map and
  never reached the screen. It is a `SvelteMap`, matching `stores/toasts`.
- **`lookup_only` is enforced in Rust** (phase 05), not merely by the frontend
  declining to ask. A frontend mistake therefore cannot turn a stored message
  into a network request.

No new dependencies were needed: `sha2`, `futures-util` and `image` were
already present, and the Rust tests use the `std::env::temp_dir` idiom from
`code_tools.rs` rather than adding `tempfile`.

## Phases

| Phase                                 | Deliverable                                                                                  | Depends on     | Rust | TS/Svelte |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | -------------- | ---- | --------- |
| [01](./phase-01-image-cache-core.md)  | `images` / `conversation_images` schema, cache dir, proxied fetch, licence mapping, eviction | —              | ●●●  | ○         |
| [02](./phase-02-image-protocol.md)    | `haruspex-img://` URI scheme, CSP entry, `imageSrc()` helper                                 | 01             | ●●   | ○         |
| [03](./phase-03-image-sources.md)     | Openverse + Wikipedia + Commons merged behind the existing `image_search`                    | 01             | ●●●  | ○         |
| [04](./phase-04-og-image-harvest.md)  | `[Image: …]` line on `fetch_url` / `research_url` results                                    | —              | ●●   | ●         |
| [05](./phase-05-resolution-pass.md)   | Eligibility allowlist, post-commit resolution, reactive map                                  | 01, 02, 03, 04 | ○    | ●●●       |
| [06](./phase-06-rendering.md)         | Figure + caption rendering, hide-until-resolved, CSP tightened                               | 05             | ○    | ●●●       |
| [07](./phase-07-toggle-and-prompt.md) | Settings toggle and the IMAGES prompt block                                                  | 06             | ○    | ●●        |

Phases 01 and 04 depend on nothing and can be built in either order.

## The two decisions worth knowing before reading

**Images are fetched by Rust, never by the webview.** The user's HTTP proxy is
applied in `build_fetch_client`; WebKitGTK and WebView2 know nothing about it,
so a direct `<img src="https://…">` silently bypasses the privacy setting the
user configured. Phase 06 removes `https:` and `http:` from `img-src`
altogether, which makes that guarantee browser-enforced rather than a property
of the renderer's logic.

**A URL is only fetched if this conversation's own tool results produced it.**
A prompt-injecting page can get arbitrary markdown echoed into a reply,
including an `![](attacker-url)` beacon. Phase 05 intersects the reply's image
refs with an allowlist built from `image_search` results and `[Image: …]`
headers, so an injected or hallucinated URL is never requested.

## Future work this plan deliberately enables

Every cached image records `source`, `license`, `attribution`,
`description_url` and an `embeddable` flag derived from the specific licence
code — not from which source it came from, because a 20-result Openverse sample
on 2026-08-30 was over a third NonCommercial or NoDerivatives. Nothing in this
plan reads `embeddable`. It exists so a later PR can put properly-licensed
images into `fs_write_pptx` / `fs_write_docx` / `fs_write_pdf` output by
filtering on it, without re-fetching or re-classifying anything. Scraped
`og:image` results can never set it, so that future feature is safe by
construction.
