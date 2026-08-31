# Inline Chat Images — Implementation Plan

Phased, dependency-ordered plan for putting topical images into chat answers:
an **Include images** toggle in Settings → General, three new image sources
alongside Wikimedia Commons, and every image fetched by Rust through the user's
proxy into an on-disk cache rather than by the webview. See
[`overview.md`](./overview.md) for the problem statement, the verified API
findings, and the Decisions appendix.

## Build status

Locked 2026-08-30. All seven phases implemented 2026-08-30, plus the amendments
below. `make check` passes.

Verified on Linux against both Qwen 3.6 35B and the default Qwen 3.5 9B — the
9B works well, which was the phase 07 success criterion and the one that
mattered, since every model-behaviour problem found during implementation was
worse on smaller models. **Windows and macOS still need a manual pass**; the
custom URI scheme resolves differently on Windows and no unit test can cover
that.

## Amended during implementation

Testing against a real model changed two things the plan did not anticipate,
and both are load-bearing.

**A fallback strip (`ChatImageStrip`).** The plan assumed the model would embed
the images it found. Across five runs on a 35B it searched and then failed to
write the markdown three times. Prompt wording was tried twice and a
`[Haruspex hint]` beside the tool result once; each reduced it, none settled
it, because the last step of a turn is simply not reliable at temperature 1.

So running `image_search` is now treated as the statement of intent it is —
the model chose the query and made the call, and it never sees the pictures,
only their titles. When an answer embeds nothing, the images it searched for
appear beneath it. Inline placement is still preferred and the strip stands
down whenever the answer embedded anything, so the good case is untouched.

Chosen over a second model call to pick images, which was the other option
considered: the failure being fixed is a model forgetting a step, so adding a
model step to fix it would have reintroduced the same class of bug. The strip
costs no inference at all. It is also _safer_ than the inline path — the
eligibility allowlist exists to stop URLs the model wrote, and the strip reads
only our own tool results, so that surface is absent rather than guarded.

**Two loop nudges.** `image_search` as a turn's only tool call now sends the
model back to research first, guarded by `looksLikeImageOnlyRequest` so
"show me a picture of X" is not nudged into researching something nobody asked
about. Writing image markdown without ever calling `image_search` — the model
inventing plausible `upload.wikimedia.org/...440px-....jpg` URLs, which the
allowlist correctly refused — sends it back to find real ones.

Also added: click any chat image to open it full size, which reuses the
existing `ImageViewerModal`. The plan simply missed it.

## Bugs found in testing

Each is a commit on the branch with the reasoning; recorded here because three
of them share a shape worth remembering — data crossing a boundary wired to the
wrong side of it.

1. **Steps read after they were cleared.** `commitMessage` archives
   `searchSteps` and empties the live array; image resolution runs after the
   commit by design and read the emptied one, so the allowlist was always empty
   and the model's own URLs were refused.
2. **Wikimedia tracking parameters.** The imageinfo API appends
   `?utm_source=…&utm_campaign=imageinfo`; the model tidied them off when
   copying the URL, exact-string matching failed, and the inline path silently
   never rendered. Stripped at the source so one spelling exists everywhere.
3. **Rehydration hung off the wrong function.** `initChatStore` restores the
   first conversation by calling `loadConversationMessages` directly, so the
   conversation you land on after a restart was the only one that never
   rehydrated.
4. **Hint text broke the tool-result parse.** The `[Haruspex hint]` block is
   appended after the JSON, and a whole-string `JSON.parse` threw — emptying
   the allowlist again.
5. **Commons returns non-images.** Its `File:` namespace holds PDFs and DjVu
   and its full-text search matches words _inside_ them, so "baboon Old World
   monkey portrait" returned three scanned books. Filtered to types the cache
   can display.

The recurring lesson is that every one of these failed **silently** — an image
that does not render looks identical whether it was never requested, refused,
or failed to fetch. Both resolution paths now log their counts unconditionally,
including the zero case, because silence was indistinguishable from success.

## Known model behaviour, not a bug in this work

The model sometimes answers a general-knowledge question from training data
with no research at all. Confirmed with **Include images off**, where the
system prompt is byte-identical to before this feature: 1 run in 3 skipped
research. The cause is the system prompt's own header, which says to search for
"products, current events, pricing, or recommendations" while the line below
says to search "before answering factual questions". Those contradict, and
"tell me about monkeys" is none of the former. Worth fixing, but it affects
every chat rather than image ones, so it belongs in its own change.

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
