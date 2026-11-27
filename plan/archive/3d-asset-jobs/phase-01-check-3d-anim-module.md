# Phase 01 — check_3d runs an animation module beside the build module

**Depends on:** nothing · **Enables:** 04 (the job's checker), 10 (the animation stage)

## Goal
A build module cannot import a sibling file: `runBuildModule` turns the one
source into a `blob:` URL, and a relative import resolves against that URL and
fails. The job keeps creation and animation in two files, so `check_3d` gains
an optional `anim` argument naming an animation module. The runner imports both,
builds the object, then calls the animation module's `animate(THREE, object,
kit)` and exports its clips with the object. The Code tab gets the same split
for free.

## Files touched
- `src/lib/helpers/three/runModule.ts` — `modulePage(source, kitUrl, animSource?)` and `runBuildModule(source, { anim })`; the RUNNER imports a second blob and merges clips.
- `src/lib/helpers/three/runModule.test.ts` — page text and merge cases.
- `src/lib/agent/tools/check-3d.ts` — `anim` param; reads the file; errors name the file they came from.
- `src/lib/agent/tools/check-3d.test.ts` — arg parsing, refusal cases.
- `docs/guide/helpers.md` — one paragraph under "The 3D helper" on keeping clips in their own file.

## Steps
1. In `runModule.ts`, add `anim?: string` to `ModuleRunOptions`. `modulePage` embeds it as `window.__hxAnim` (JSON, `<` escaped as for `__hxSource`), or `null`.
2. RUNNER: when `window.__hxAnim` is a string, make a second blob and change the wrapper to `import * as mod from "<src>"; import * as anim from "<anim>"; window.__hxRun(mod, anim);`. Without it the wrapper stays as today and `anim` is undefined.
3. In `__hxRun(mod, anim)`, after `build` returns and the object is checked: if `anim` is given, take `anim.default` or `anim.animate`; if it is not a function throw `own('The animation module has no default export function animate(THREE, object, kit).')`. `var extra = await fn(kit.THREE, object, kit.kit)`; it must be an array of `AnimationClip`s (each `clip.isAnimationClip` or has `tracks`), else throw `own('animate() must return an array of AnimationClip.')`. Clips from `build` and from `animate` are concatenated; a clip name present in both is an error: `own('Clip "<name>" comes from both modules.')`.
4. Line numbers: errors from the animation blob must say so. Keep the two blob URLs in `var srcUrl, animUrl`; in the `error` listener and `lineOf`, pass `{ line, file: 'anim' | 'build' }` by matching the URL in the stack line / `e.filename` (extend `LINE_PATTERN` use: test `stack line includes animUrl`). Send `file` in `hx-err`; `ModuleError` gains `file: 'build' | 'anim'` (default `'build'`).
5. `check-3d.ts`: add `anim` to the schema: "An animation module (.js): its default export `animate(THREE, object, kit)` returns an array of AnimationClip for the object `path` builds. Only with a module `path`." `parseArgs` refuses `anim` with a `.glb`/`.gltf` path and a non-`.js`/`.mjs` anim. `source()` reads both files; failure lines become `- <file>:<line>: msg` when `file` is `anim`, as today otherwise; the "Fix … and call check_3d again" line names the anim path when every error came from it.
6. Update `TOOL_DESCRIPTION` text in `check-3d.ts`: one sentence that clips may live in a separate module passed as `anim`.
7. Guide: in `docs/guide/helpers.md`, under the 3D helper, add: clips can be kept in their own file, `animate(THREE, object, kit)`, checked with both files.

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/helpers/three src/lib/agent/tools/check-3d`, `npm run format:check`.

## Test plan
- Unit: `modulePage` with and without anim (no second import when absent); parseArgs refusals.
- In `runModule.test.ts`, with its existing harness (mocked `invoke`, fake timers, posted `hx-*` messages), add: anim module returning one clip → `hx-glb` sent; anim returning a non-array → error with `file: 'anim'`; duplicate clip name → error.
- Live check in phase 13.

## Commit
`feat(helpers): check_3d takes an animation module beside the build module`

## Rollback
Revert the commit. The argument is optional, so nothing else depends on it until phase 02.
