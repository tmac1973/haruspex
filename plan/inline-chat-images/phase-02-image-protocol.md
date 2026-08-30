# Phase 02 — `haruspex-img://` protocol and CSP

**Depends on:** 01 · **Enables:** the renderer having a `src` it can point an
`<img>` at without the webview touching a third-party host.

## Goal

Give the webview a way to display cached bytes. Rust registers a custom URI
scheme that serves one image by hash, straight from the cache directory, and
the CSP is widened to allow exactly that scheme. Memory stays flat regardless
of conversation length, because the webview streams from disk rather than
holding base64 in a JS string.

## Files touched

- `src-tauri/src/image_cache/protocol.rs` — **new.** The URI scheme handler.
- `src-tauri/src/lib.rs` — `.register_uri_scheme_protocol("haruspex-img", …)`
  on the builder at line 52, before `.invoke_handler(…)`.
- `src-tauri/tauri.conf.json` — add the scheme to the `img-src` directive in
  the `csp` string at line 24.
- `src/lib/images/url.ts` — **new.** One exported helper,
  `imageSrc(hash: string): string`, so the scheme name lives in exactly one
  place on the frontend.

## Steps

1. **Register the scheme.** `haruspex-img://<hash>`. The handler:
   - Extracts the hash from the URI host/path and rejects anything that is not
     exactly 64 lowercase hex characters. This is the path-traversal guard —
     because the hash is validated by shape before it is ever joined to the
     cache directory, `../` and absolute paths cannot be expressed.
   - Looks the hash up in the `images` table. A miss is a 404.
   - Reads `<cache>/<hash>` and responds with the row's stored `mime` as
     `Content-Type`.
   - Sets `Cache-Control: max-age=31536000, immutable`. Content-addressed bytes
     never change, so the webview should never re-request one it has.
   - Bumps `last_used_at` for the row, so the LRU eviction in Phase 01 reflects
     actual display rather than only fetch time.

2. **CSP.** The current directive at `tauri.conf.json:24` is:

   ```
   img-src 'self' data: blob: https: http:;
   ```

   Add the scheme:

   ```
   img-src 'self' data: blob: haruspex-img: https: http:;
   ```

   `https:` and `http:` stay **in this phase only**. Phase 06 removes them once
   the renderer no longer emits remote image URLs; doing it here would break
   nothing, but it would mean shipping a phase where an image the renderer
   still passes through silently fails to load.

3. **Platform check.** Custom schemes resolve differently across the three
   webviews: on Windows the scheme arrives as
   `http://haruspex-img.localhost/<hash>`, on Linux and macOS as
   `haruspex-img://<hash>`. Parse the hash from both shapes rather than
   assuming one, and add `http://haruspex-img.localhost` to the CSP alongside
   the scheme so Windows is not silently broken.

4. **Frontend helper.** `imageSrc(hash)` returns the correct string for the
   current platform. Implement it with a single `navigator.userAgent`-free
   check — read the platform once from Tauri's `platform()` at module load and
   branch on Windows — so the Windows/Unix difference is expressed in exactly
   one place and every caller stays platform-agnostic.

## Build gate

```bash
cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test
cd .. && npm run check && npm run lint
```

## Test plan

- **Rust unit:** hash-shape validation rejects `../../etc/passwd`,
  `ABCDEF…` (uppercase), a 63-character string, and an empty string; accepts a
  real 64-hex hash.
- **Rust unit:** a hash that validates but has no row returns 404 rather than
  attempting a file read.
- **Manual, per platform:** seed the cache with one image via Phase 01's
  command, then set an `<img src>` to its `haruspex-img://` URL from the
  devtools console and confirm it renders on Linux, Windows and macOS. This is
  the step that catches the Windows scheme difference — it cannot be caught by
  unit tests.
- **Manual:** confirm `last_used_at` advances when an image is displayed, not
  only when it is fetched.
- **Manual:** with devtools' network tab open, confirm the image load shows as
  the custom scheme and produces no outbound request.

## Commit

```
feat(images): serve cached images over a haruspex-img:// protocol
```

## Rollback

Revert the commit, including the `tauri.conf.json` CSP line. The cache from
Phase 01 is untouched and still valid. Nothing renders images yet, so there is
no user-visible regression from backing this out on its own.
