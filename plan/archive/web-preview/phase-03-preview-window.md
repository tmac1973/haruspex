# Phase 03 — Preview window

**Depends on:** 01, 02 · **Enables:** the `show_preview` tool (04) and the
Preview buttons (05)

## Goal
A `preview-<sessionId>` window on the `/preview` route: a slim toolbar (file
path, Reload, Phone 390 / Tablet 820 / Full, Open in browser) over an iframe of
the served page, reloading on `preview://changed`. One function,
`openPreview(sessionId, root, relPath)`, opens it or navigates the open one.

## Files touched
- `src-tauri/src/app_windows.rs` — add `"preview-"` to `PREFIXES`; extend the
  test.
- `src-tauri/capabilities/preview.json` — new: `windows: ["preview-*"]`,
  permissions `core:default`, `core:window:allow-close`,
  `core:window:allow-set-title`, `core:window:allow-set-focus`,
  `core:window:allow-unminimize`. No shell, dialog or webview-create.
- `src-tauri/tauri.conf.json` — CSP `frame-src` gains `http://127.0.0.1:*`.
- `src/lib/preview/open.ts` — new: `openPreview`, `PREVIEW_NAVIGATE_EVENT`.
- `src/lib/preview/open.test.ts` — new.
- `src/routes/preview/+page.svelte` — new: the window's page.
- `src/lib/components/preview/PreviewToolbar.svelte` — new.
- `src/lib/components/preview/PreviewToolbar.test.ts` — new.
- `src/lib/windowRoutes.ts` — `isDetachedRoute` also returns true for
  `'/preview'`, so `+layout.svelte` shows only the page (no sidebar, no
  sidecars), like the editor window.
- `src/lib/windowRoutes.test.ts` — case for `/preview`.
- `src/routes/+layout.svelte` — the MCP start-up skip also covers `/preview`.

## Steps
1. `openPreview(sessionId, root, relPath)`:
   - `invoke('preview_serve', { sessionId, root, path: relPath })` → `url`;
     a rejection (outside the folder, missing, not HTML) propagates with
     Rust's message.
   - If `WebviewWindow.getByLabel('preview-' + sessionId)` exists:
     `emitTo(label, 'preview://navigate', { url, relPath })`, then
     `unminimize` and `setFocus`.
   - Else `openAppWindow` (`#lib/appWindow.ts`, which calls `app_window_open`)
     with label `preview-<sessionId>`, route
     `/preview?session=<id>&url=<encoded url>&path=<encoded relPath>`, title
     `Preview — <relPath>`, 1100×800, centred.
   - Returns `url`.
2. `/preview` page (Svelte 5 runes): reads `session`, `url`, `path` from
   `page.url.searchParams`; `<iframe src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" referrerpolicy="no-referrer">`.
   `allow-same-origin` is safe here because the iframe's origin is
   `127.0.0.1:<port>`, never the app's; it lets mockups use `localStorage`.
   Width presets set the iframe's CSS width (390px, 820px, 100%) centred on a
   neutral background; the choice is kept in `localStorage` per window.
3. Listeners: `preview://changed` → reload by re-setting `src` with a
   `?_r=<counter>` cache-buster stripped of any previous one (cross-origin
   frames can't be `location.reload()`ed from the parent);
   `preview://navigate` → replace `url`/`path` and `setTitle`.
4. Open in browser → `openInBrowser(url)` (`#lib/utils/openInBrowser.ts`).
5. Toolbar copy: the path as text with a `title` of the full URL; buttons
   labelled `Reload`, `Phone`, `Tablet`, `Full`, `Open in browser`, each with
   a one-line tooltip. Follow the UI refresh invariants (always-dark toolbar
   surface, teal accent on the active preset with `accent-contrast` text).
6. `isDetachedRoute('/preview')` → true, which skips bootstrap and the main
   chrome (`+layout.svelte` gates by `page.route.id`, which works in packaged
   builds). The MCP start-up `onMount` in `+layout.svelte` tests
   `page.route.id === '/editor' || page.route.id === '/code/[id]'` by name:
   add `|| page.route.id === '/preview'` so a preview window never starts the
   user's MCP servers.

## Build gate
- `npm run check && npm run lint && npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test app_windows`

## Test plan
- `open.test.ts`: mocks `invoke`/`WebviewWindow`; a closed window is opened
  with the right label, route and title; an open one gets `preview://navigate`
  and focus; a path with spaces and `#` is encoded.
- `PreviewToolbar.test.ts`: presets set the width and mark the active one.
- Hand test in `npm run tauri dev`: open a preview from the devtools console
  with `openPreview`, edit the CSS, see it reload; in the iframe's devtools
  `window.__TAURI__` and `window.__TAURI_INTERNALS__` are undefined and `fetch('http://ipc.localhost')`
  fails. Repeat the IPC check once in a packaged build (CSP only applies
  there).

## Commit
`feat(code): preview window for a session's web pages`

## Rollback
Revert the commit: the route, capability and CSP entry go together. The
server and watcher from 01–02 stay unused.
