# Phase 05 — Headless HTML runner and GLB preview

**Depends on:** nothing in phases 01–04 (it uses only existing app pieces: `artifact_register` and the `haruspex-artifact:` scheme) · **Enables:** 06 (the GLB kind runs HTML and previews GLBs through these two modules).

## Goal
Two self-contained modules the GLB kind needs, built and tested apart from it:

- **Runner:** load model-written Three.js HTML in a sandboxed, off-screen iframe on the existing `haruspex-artifact:` scheme, click its export button, and get back the GLB bytes plus every error with its line number in the original file.
- **Preview:** load GLB bytes with the bundled `three` package, report meshes, triangles, animations and size, flag broken geometry, and render a PNG from a fixed angle.

Nothing user-visible. Labelled `no-docs`.

## Files touched
- `package.json` / `package-lock.json` — add `three` and `@types/three` (exact versions, current at the time of the PR).
- `src/lib/specialists/glb/shim.ts` — new: the injected script as a string constant, and `injectShim(html)`.
- `src/lib/specialists/glb/runHtml.ts` — new: `runAssetHtml(html, { signal, timeoutMs })`.
- `src/lib/specialists/glb/preview.ts` — new: `previewGlb(bytes)`, loaded with a dynamic `import()` so `three` lands in a lazy chunk.
- `src/lib/specialists/glb/extract.ts` — new: `extractHtml(content)`.
- Tests: `shim.test.ts`, `runHtml.test.ts`, `extract.test.ts`, `preview.test.ts`.
- `src/routes/dev/glb-runner/+page.svelte` — new, dev builds only (guarded by `import.meta.env.DEV`; the route renders nothing in release): paste HTML, run, see errors, the stats and the render. Used for the per-OS hand test.

## Steps
1. `extract.ts` — `extractHtml(content)`: strip think blocks; take the longest fenced ```` ```html ```` block; else, when the trimmed content starts with `<!doctype` or `<html` (case-insensitive), the whole content; else `null`.
2. `shim.ts` — the shim is one line of plain JavaScript with no newline characters, so injecting it does not move any line of the original file. `injectShim(html)` inserts `<script>…</script>` straight after the first `<head…>` tag; if there is none, after the first `<html…>` tag; else at the very start. The shim:
   - Records errors and posts each to the parent as `{ t: 'hx-err', kind, message, line, col }`: `window.onerror` (message, `lineno`, `colno`), `unhandledrejection` (reason message, no line), and a `console.error` wrapper (joined args, first 300 chars, no line).
   - Captures downloads: wraps `URL.createObjectURL` to remember `blob URL → Blob`, and patches `HTMLAnchorElement.prototype.click` and `dispatchEvent` so a click on an anchor with a `download` attribute whose `href` is a remembered blob (or a `data:` URL) reads the bytes and posts `{ t: 'hx-glb', bytes }` with the `ArrayBuffer` transferred, instead of navigating.
   - On `load` posts `{ t: 'hx-ready' }`.
   - On a parent message `{ t: 'hx-export' }`, clicks the first `button`, `a` or `[role=button]` whose text or `title` matches `/export|glb|download/i`, else posts `{ t: 'hx-err', kind: 'no-export', message: 'No Export GLB button found.' }`.
3. `runHtml.ts` — `runAssetHtml(html, { signal, timeoutMs = 45000 })` returns `{ glb: Uint8Array | null, errors: RunError[] }` where `RunError = { kind: 'error' | 'rejection' | 'console' | 'no-export' | 'timeout', message: string, line: number | null }`:
   - `const id = await invoke('artifact_register', { html: injectShim(html) })`.
   - The scheme's existing policy (`artifact_csp` in `src-tauri/src/artifact_frame.rs`) already allows `https:` scripts, so the model's CDN `import`s of Three.js load with no Rust change; the phase's hand test confirms it on each OS.
   - Create an `iframe` with `sandbox="allow-scripts"` (no `allow-same-origin`, as `ArtifactFrame.svelte` does), `src = artifactUrl(id)`, styled `position: fixed; left: -10000px; top: 0; width: 1024px; height: 768px; border: 0` (off-screen, never `display: none`, so the page still gets a WebGL context and layout), appended to `document.body`.
   - Accept messages only where `event.source === iframe.contentWindow`. On `hx-ready`, wait 1,500 ms (scene setup that runs in the first frames), then post `hx-export`. Resolve on `hx-glb`, after a further 500 ms to collect late errors. Resolve with a `timeout` error when `timeoutMs` passes with no GLB.
   - Remove the iframe and listeners in every path; an aborted `signal` removes them and rejects with `AbortError`.
4. `preview.ts` — `previewGlb(bytes)` returns `{ ok: boolean, problems: string[], meshes, triangles, animations: { name, tracks }[], size: [x, y, z], png: string }`:
   - Dynamic-import `three` and `GLTFLoader` from `three/examples/jsm/loaders/GLTFLoader.js`; `parse` the bytes. A parse error returns `ok: false` with that message and no PNG.
   - Walk meshes: count them and their triangles (indexed count / 3, else position count / 3). Any `NaN` in a position attribute adds the problem "Mesh '<name>' has NaN vertex positions." (the spike's rocks). Zero meshes adds "The GLB has no meshes."
   - Size from `Box3.setFromObject`; a zero or non-finite size adds a problem.
   - Render on a detached 640×480 canvas with `WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false })`, background `#808080`, a hemisphere light and a directional light, and a 40° camera placed at `centre + (1.2, 0.8, 1.6) × largest dimension` looking at the centre (the spike's framing). `png = canvas.toDataURL('image/png')`. Dispose the renderer, geometries and materials.
   - `ok` is true when `problems` is empty.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`, `npm run build` (confirms `three` lands in a lazy chunk, not the entry chunk).

## Test plan
- `extract.test.ts`: fenced block, several blocks (longest wins), bare document, think block before it, no HTML → `null`.
- `shim.test.ts`: the shim string contains no newline; injection after `<head>`, after `<html>`, at the start; every original line keeps its line number.
- `runHtml.test.ts` (jsdom; `invoke` mocked; messages simulated from a fake `contentWindow`): GLB resolves with errors collected after it; messages from another source ignored; timeout; abort cleans up; the iframe is removed in every path.
- `preview.test.ts`: the loader and renderer mocked; NaN positions, zero meshes and zero size produce the problems; stats computed from a fixture scene.
- Hand test with the dev route on Linux (WebKitGTK), Windows (WebView2, `ssh haruspex-win`) and macOS (WKWebView, `ssh haruspex-mac`): run three of the spike's saved HTML files (`potion`, `chest` repaired, `robot` repaired) and one known-failing one (`lamp.orig.html`). Each good file gives a GLB whose render matches the spike's; the failing one reports "Identifier 'pole' has already been declared". The robot reports its `Walk` animation.

## Commit
`feat(specialists): headless HTML runner and GLB preview`

## Rollback
Revert the commit. Nothing else imports these modules until phase 06; removing `three` from `package.json` is part of the revert.
