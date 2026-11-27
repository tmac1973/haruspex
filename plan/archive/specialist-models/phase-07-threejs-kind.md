# Phase 07 — The `threejs` kind

**Depends on:** 01, 03, 04, 05, 06 · **Enables:** Three.js scenes for native Three.js web projects, with [ccore/Qwen3.5-4B-3D-Coder](https://huggingface.co/ccore/Qwen3.5-4B-3D-Coder) as the model that fits.

## Goal
Register a second 3D kind for projects that are Three.js apps themselves, where a GLB is the wrong output. A call generates a self-contained Three.js HTML scene, saves it at the path the main model gives, runs it headless with no export, requires it to run cleanly and draw something, and shows the main model a screenshot. The main model then ports the scene code into the project's own modules with its edit tools. Failures and `recheck` work exactly as for `glb`, through phase 06's `runHtmlKind`. User-visible: the PR body names `docs/guide/specialists.md`.

## Files touched
- `src/lib/specialists/kinds/threejs.ts` — new: the kind.
- `src/lib/specialists/kinds/index.ts` — import `./threejs.ts`.
- `src/lib/specialists/kinds/threejs.test.ts` — new.
- `docs/guide/specialists.md` — add the Three.js kind.

## Steps
1. Register `{ id: 'threejs', label: 'Three.js scene', summary: 'Writes a self-contained Three.js scene as an HTML file.', writes: true, requestRequired: false, callLabel: htmlCallLabel }` with:
   - `defaultDescription`: "Writes a self-contained Three.js scene (one HTML file) for a web project: objects, environments, animated scenes. Port the result into the project's code. Send a short English request."
   - `defaultSystemPrompt` (the model card's prompt as of 2026-11-02):
     ```text
     Use only the Three.js core ES module from
     https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js.
     Do not import addons or legacy examples/js paths;
     implement any camera controls directly inside the HTML.
     ```
   - `defaultSampling`: `{ temperature: 0.7, top_p: 0.95, top_k: 20, max_tokens: 24000, thinking: false }` (thinking off: with it on, the 2026-11-02 spike spent 24k and then 48k tokens reasoning and never wrote HTML) (inside the card's ranges: temperature 0.6–0.8, top-p 0.90–0.95, top-k 20–40).
   - `params`: `path`, `recheck` and `overwrite`, with exactly the schemas and `required: false` that phase 06 declares for `glb` (phase 01's registry refuses a mismatch).
2. `run` calls `runHtmlKind` with:
   - `sourcePath`: generate mode needs `path` ending in `.html` (source and target are the same file, so there is no separate target to overwrite: `overwrite` guards that file); recheck needs a path ending in `.html` and re-runs it in place (no overwrite check).
   - `requestSuffix`: `''` (the card's prompts are used as written).
   - `runOptions: { export: false }`.
   - The snapshot is taken about 1.5 s after load from the page's own camera, so it shows the scene's opening view; fog-heavy scenes come out pale but still pass the blank check (the spike's elephant habitat and canal lock did).
   - `finish`: `result.png` missing → `{ ok: false, problems: ['The page drew no canvas.'] }`; `await snapshotProblems(result.png)` non-empty → those problems. On success, if `ctx.visionSupported !== false` and `ctx.pendingImages.length < MAX_PENDING_IMAGES`, push `{ path: <html path>, dataUrl: result.png }`; return `toolResult` with the HTML path, "It loads three 0.160.0 core from cdnjs and has its own camera controls. Port the scene code into the project: match the project's three import and version, and drop the page's renderer, camera and controls setup if the project has its own.", plus, when an image is attached, "Check the screenshot: if it doesn't look like the request, call again with a clearer request." Set `thumbDataUrl` to the PNG.
   - In generate mode the HTML is written before the check (phase 06's flow), so a failing scene still leaves its source at `path` for the recheck.
3. Guide: add a "Three.js scenes" section to `docs/guide/specialists.md`: a model that fits (`ccore/Qwen3.5-4B-3D-Coder`), that the result is one HTML file the agent then ports into the project, that it needs the network for Three.js from cdnjs, that the agent repairs failing code and re-checks it, and that the screenshot reaches the model only when it has vision. Keep the page under 6 KB.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`, `npm run build`; the `Guide` check passes.

## Test plan
- `threejs.test.ts` (mock `callSpecialist`, `runAssetHtml`, `assetIo`, `snapshotProblems`):
  - Generate writes the HTML at `path`, runs without export, attaches the screenshot with vision and not without, and the result carries the porting note.
  - A path not ending in `.html`, an existing file without `overwrite` → refusals.
  - No snapshot, a blank snapshot and a run error each fail with the recheck instruction.
  - Recheck re-runs the file in place without calling the specialist.
- Registry: registering `threejs` beside `glb` does not throw (shared `path`, `recheck`, `overwrite` schemas match), and the tool schema lists the params with both kind labels when both specialists are on.
- Live test, dev build on Linux, Remote control API. A `threejs` specialist pointed at `http://asmodean:3000`, model `ccore-Qwen3.5-4B-3D-Coder.Q8_0` (the instance has the card's system prompt set on the server since 2026-11-02, so test once with the kind's prompt and once with "Send no system prompt"); the Code tab model on `http://compute:3000`; a scratch Vite + three project. Ask the agent for the card's four example scenes (elephant habitat, dragonrider aerie, canal lock, air traffic control tower) with a `scenes/` path, then ask it to port the tower into the project as a module and run `npm run build`. Pass: four HTML files that run cleanly (after any recheck repairs), screenshots reach the model, and the ported module builds. Record first-try and after-repair counts in issue #906, against the 2026-11-02 spike: with thinking off, 2 of 5 scenes ran clean first try and the main model fixed the other 3 in one round each (`birds is not defined`, `materials.lightStone is not a function`, `x is not defined`); generations took 97–139 s.

## Commit
`feat(specialists): threejs kind for Three.js scenes`

## Rollback
Revert the commit (kind module, its import line, the guide section). Saved Three.js specialist entries become "unknown kind" entries that are kept but never offered, as for `glb`.
