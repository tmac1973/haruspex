# Phase 03 — Bundled Three.js kit for the sandbox

**Depends on:** nothing · **Enables:** running build modules offline (04)

## Goal

Ship Three.js and the modelling kit as one classic script served from the
app's own origin, so a sandboxed `haruspex-artifact:` page can load it with a
plain `<script src>` (the way plotly ships, which needs no CORS) and find
`window.HaruspexThreeKit = { THREE, kit, GLTFExporter }`. No CDN, no import
map, works offline, and the version is the app's own `three`.

## Files touched

- `src/lib/helpers/three/kitEntry.ts` — new: the bundle's entry; imports
  `three`, `GLTFExporter`, `mergeGeometries` and `mergeVertices` from
  `BufferGeometryUtils`, `RoundedBoxGeometry`, `ConvexGeometry`,
  `ParametricGeometry`, and `createNoise` / `random` from `noise.ts`; assigns
  `globalThis.HaruspexThreeKit`.
- `src/lib/helpers/three/noise.ts` — new: `createNoise(seed)` returning
  `noise2(x, y)` / `noise3(x, y, z)` in [−1, 1] (simplex, seeded, ~80 lines),
  and `random(seed)` (mulberry32).
- `src/lib/helpers/three/noise.test.ts` — new.
- `scripts/build-three-kit.mjs` — new: Vite's `build()` API in library mode,
  `formats: ['iife']`, `name: 'HaruspexThreeKitBundle'`, minified, output
  `static/helpers/three-kit.js`; skips the build when the output is newer than
  `node_modules/three/package.json` and the kit sources.
- `package.json` — `"build:three-kit": "node scripts/build-three-kit.mjs"`;
  `dev` becomes `npm run build:three-kit && vite dev`; `build` becomes
  `npm run build:three-kit && vite build`.
- `.gitignore` — `static/helpers/`.
- `src/lib/helpers/three/kitUrl.ts` — new: `threeKitUrl()`, the absolute app
  URL of `/helpers/three-kit.js` (`location.origin` of the main window +
  path), for the sandbox page to load.

## Steps

1. Write `noise.ts` and its tests (same seed → same values; range within
   [−1, 1]; different seeds differ).
2. Write `kitEntry.ts`:
   ```ts
   globalThis.HaruspexThreeKit = {
   	THREE,
   	GLTFExporter,
   	kit: { mergeGeometries, mergeVertices, RoundedBoxGeometry, ConvexGeometry,
   		ParametricGeometry, createNoise, random }
   };
   ```
3. Write `scripts/build-three-kit.mjs` with `build({ configFile: false,
   build: { lib: { entry, formats: ['iife'], name, fileName: () =>
   'three-kit.js' }, outDir: 'static/helpers', emptyOutDir: false, minify:
   true }, logLevel: 'warn' })`, behind the freshness check.
4. Wire the npm scripts and `.gitignore`. CI's `npm run build` and the e2e
   build (`e2e/app/build.mjs` runs `tauri build`, whose `beforeBuildCommand`
   is `npm run build && npm run build:web`) now produce the file with no
   further change.
5. Confirm the artifact policy already admits it: `script-src` lists `tauri:
   http://tauri.localhost` (and `http://localhost:1420` in debug) in
   `src-tauri/src/artifact_frame.rs`. No Rust change.
6. `threeKitUrl()` returns `new URL('/helpers/three-kit.js',
   location.origin).href`.

## Build gate

- `npm run build:three-kit` (writes `static/helpers/three-kit.js`)
- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/helpers`
- `npm run build`

## Test plan

- Unit: noise determinism and range.
- Bundle smoke: a vitest that `import`s the built file into a jsdom window
  (skipped when it hasn't been built) and finds `HaruspexThreeKit.THREE.REVISION`
  equal to the installed `three`'s, plus every `kit` member.
- Manual: `npm run tauri dev`; in devtools, register an artifact page with
  `<script src="<threeKitUrl()>">` through `invoke('artifact_register', …)`,
  load it in a sandboxed iframe and see `HaruspexThreeKit` defined (repeated
  for real in phase 04's tests).

## Commit

`build(helpers): bundle three and a modelling kit as a classic script`

## Rollback

Revert the commit; the npm scripts go back to plain `vite dev` / `vite build`.
Nothing loads the kit yet, so a revert breaks nothing. A stale
`static/helpers/three-kit.js` left behind is gitignored and unused.
