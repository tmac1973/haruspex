# Phase 04 — Build-module runner

**Depends on:** 03 · **Enables:** `check_3d` on a `.js` module (06)

## Goal

`runBuildModule(source, opts)` runs a model-written build module in the same
sandboxed, off-screen `haruspex-artifact:` iframe the specialist runner uses,
and returns the exported GLB bytes or every error with its line in the
module. The module is `export default function build(THREE, kit) { … }`
returning an `Object3D` or `{ object, animations }`; it imports nothing, and
the page supplies the kit from phase 03.

## Files touched

- `src/lib/helpers/three/runModule.ts` — new: page template, run lifecycle,
  result type.
- `src/lib/helpers/three/runModule.test.ts` — new (page template and
  message handling, with the iframe mocked as `runHtml.test.ts` does).
- `src/lib/specialists/three/runHtml.ts` — extract the iframe/timer/message
  lifecycle (`class Run`) into `src/lib/sandbox/hiddenFrame.ts` so both
  runners share it; `runAssetHtml` keeps its signature and behaviour.
- `src/lib/sandbox/hiddenFrame.ts` — new: `runHiddenFrame(html, { timeoutMs,
  signal, onMessage })` creating the off-screen sandboxed iframe, routing
  `postMessage`s from it, and cleaning up.
- `src/lib/specialists/three/runHtml.test.ts` — still passes unchanged.
- `src/routes/dev/glb-runner/+page.svelte` — a second text box, "Build
  module", with a Run button that calls `runBuildModule` and shows the errors
  or the GLB's byte count (the sheet and report display comes from phase 02
  when both have landed; the two edits touch separate parts of the page).

## Steps

1. Extract the iframe lifecycle from `runHtml.ts` into
   `src/lib/sandbox/hiddenFrame.ts` without changing behaviour; `runHtml.ts`
   becomes a client of it. Its tests must pass untouched.
2. Write the page template in `runModule.ts`. The model's source goes in a
   `Blob` created *inside* the iframe (so the module URL is same-origin to the
   opaque page and the policy's `blob:` allows it):
   ```html
   <!doctype html><html><head>
   <script src="${threeKitUrl()}"></script>
   <script>/* error reporting: window error + unhandledrejection → parent */</script>
   </head><body><script type="module">
   const src = ${JSON.stringify(source)};
   const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
   const { THREE, kit, GLTFExporter } = window.HaruspexThreeKit;
   try {
     const mod = await import(url);
     if (typeof mod.default !== 'function') throw new Error('The module has no default export function build(THREE, kit).');
     const out = await mod.default(THREE, kit);
     const object = out?.isObject3D ? out : out?.object;
     const animations = out?.isObject3D ? [] : (out?.animations ?? []);
     if (!object?.isObject3D) throw new Error('build() must return an Object3D or { object, animations }.');
     const glb = await new GLTFExporter().parseAsync(object, { binary: true, animations });
     parent.postMessage({ t: 'hx-glb', bytes: glb }, '*', [glb]);
   } catch (e) { parent.postMessage({ t: 'hx-err', kind: 'error', message: String(e?.message ?? e), line: lineOf(e) }, '*'); }
   </script></body></html>
   ```
   `lineOf(e)` splits `e.stack` into lines and returns the first match of
   `/blob:\S*?:(\d+):(\d+)\)?\s*$/` as a number from capture 1 (capture 2 is
   the column). That one pattern covers WebKit (`build@blob:null/<uuid>:12:7`)
   and Chromium (`at build (blob:null/<uuid>:12:7)`), and the line is the one
   in the model's own file. A load-time `SyntaxError` from
   `import(url)` reports its line the same way; when no line is found, `line`
   is `null`.
3. A missing kit (`window.HaruspexThreeKit` undefined) reports "The 3D kit did
   not load." so a broken build is told apart from a broken module.
4. `runBuildModule(source, { signal, timeoutMs = 45_000 })` →
   `{ glb: Uint8Array | null, errors: RunError[] }` (reusing `RunError` from
   `runHtml.ts`). It resolves on the first `hx-glb` (after `LATE_MS` for late
   errors) or on an `hx-err`; a timeout adds `Timed out after 45 s waiting for
   build() to return.`
5. No snapshot and no shim: the render sheet comes from phase 01 on the GLB
   bytes, in the main window.

## Build gate

- `npm run build:three-kit`
- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/helpers src/lib/sandbox src/lib/specialists`

## Test plan

- Unit (mocked frame): `hx-glb` resolves with bytes; `hx-err` with a line
  resolves with that error; a timeout resolves with the timeout error; abort
  rejects with `AbortError`; the page template contains the kit URL and the
  JSON-encoded source (a source containing `</script>` is escaped so it can't
  end the tag: replace every `<` in the JSON with the six characters `\u003c`).
- `lineOf` parses WebKit (`build@blob:…:12:7`) and Chromium
  (`at build (blob:…:12:7)`) stack lines.
- Live, in `npm run tauri dev` via `/dev/glb-runner` (extended with a
  "module" box): a box module returns a GLB; a module with a typo on line 5
  reports line 5; a module returning a number reports the return-type error;
  a module that loops forever times out at 45 s; with the network off the
  box module still works.

## Commit

`feat(helpers): run a build module in the sandbox and export its GLB`

## Rollback

Revert the commit. The extraction into `hiddenFrame.ts` reverts with it and
`runHtml.ts` returns to its own lifecycle; its unchanged tests prove the
specialist path is unaffected either way.
