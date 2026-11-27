# Phase 06 — The `glb` kind

**Depends on:** 01, 03, 04, 05 · **Enables:** the feature's goal: the Code tab's model makes 3D assets through a specialist. 07 reuses this phase's HTML-kind flow for the `threejs` kind.

## Goal
Register the `glb` kind. A call generates a Three.js HTML file with the specialist, saves it next to the target GLB, runs it headless, exports and checks the GLB, writes it into the project and shows the main model a render. A failing run returns the errors with line numbers and the HTML path; a `recheck` call on that path repeats the run on the edited file without generating again. The generate / save / recheck / report flow is written once, as a helper that any kind producing a Three.js HTML page can use; GLB is its first user. User-visible: the PR body names `docs/guide/specialists.md`.

## Files touched
- `src/lib/specialists/three/htmlKind.ts` — new: `runHtmlKind(run, spec)`, the shared flow.
- `src/lib/specialists/three/htmlKind.test.ts` — new.
- `src/lib/specialists/kinds/glb.ts` — new: the kind.
- `src/lib/specialists/kinds/index.ts` — import `./glb.ts`.
- `src/lib/specialists/kinds/glb.test.ts` — new.
- `src/lib/agent/tools/ask-specialist.test.ts` — add a case with the real `glb` and `text` kinds registered.
- `src/lib/components/settings/SpecialistsSection.test.ts` — add a case that the Add menu lists both real kinds.
- `docs/guide/specialists.md` — add the GLB kind.

## Steps
1. `htmlKind.ts` — `runHtmlKind(run: SpecialistRun, spec: HtmlKindSpec): Promise<ToolExecOutput>` where `HtmlKindSpec = { sourcePath(args): { source: string; target: string } | string; requestSuffix: string; runOptions: { export: boolean }; finish(result: AssetRunResult, paths: HtmlKindPaths, run: SpecialistRun): Promise<HtmlKindOutcome> }` and `HtmlKindOutcome = { ok: true; output: ToolExecOutput } | { ok: false; problems: string[] }`. `HtmlKindPaths = { source: string; target: string; sourceAbs: string; targetAbs: string }`: the relative paths for messages, the resolved ones for reads and writes. `AssetRunResult` is phase 05's exported type. `sourcePath` returns the pair of paths exactly as the model wrote them (relative to the session folder), or a refusal string; it only checks their shape, such as the extension. The flow:
   - **Mode.** `recheck` set: a call that also passes `request` or `path` is refused ("recheck takes no request or path: it re-runs the saved source"). Otherwise `request` and `path` are both required ("Pass request and path, or recheck.").
   - **Paths.** After `sourcePath` returns its pair, the helper resolves each path inside the session folder (`resolveShellPath` / `ctxCwd`, as `make-asset.ts` does) and refuses one outside it. Reads and writes use the resolved paths; every message to the model (results, failures, the recheck instruction) uses the relative paths `sourcePath` returned. In generate mode, if the target exists and `overwrite` is not true, refuse with the path.
   - **Generate mode.** `callSpecialist(run.entry, run.request + spec.requestSuffix, { ...callOptionsFrom(run.ctx), images: run.images })`. A `length` finish reason returns `toolError("The specialist ran out of tokens (max N). Raise Max tokens in Settings → Code → Specialists, or ask for something simpler.")`. `extractHtml`; no HTML → `toolError` with the answer's first 500 characters. Write the HTML to the source path through `assetIo(ctx)` / `writeAsset` (overwriting an old source is allowed: it belongs to this tool).
   - **Recheck mode.** `images` are refused ("recheck re-runs the saved source; images only go with a new request"). The source must exist; read it. No generation.
   - **Run.** `onProgress('Running')`, `runAssetHtml(html, { signal: ctx.signal, ...spec.runOptions })`, then `spec.finish(result, paths, run)`.
   - **Failure** (any run error, `console` ones included, or `finish` returning `ok: false`): return `toolResult` (not `toolError`, so the model treats it as work to continue) with: "The check failed." then each error as `- line N: message` (or `- message` when the line is unknown) and each problem, then "The source is at <source>. Fix it with your edit tools, then call ask_specialist with name '<name>' and recheck '<source>'." Nothing is written to the target.
   - **Success**: return `finish`'s output.
   - `htmlCallLabel(entry, args)` returns `"<name>: recheck <file name>"` when `recheck` is set, else `null`; kinds using the helper use it as their `callLabel`.
2. Register the `glb` kind: `{ id: 'glb', label: '3D asset (GLB)', summary: 'Writes a Three.js scene and exports it as a GLB file.', writes: true, requestRequired: false, callLabel: htmlCallLabel }` with:
   - `defaultDescription`: "Makes a low-poly 3D asset (props, characters, buildings) as a GLB file for a game engine. Send a short English request."
   - `defaultSystemPrompt` (the model card's prompt as of 2026-11-01):
     ```text
     Create game assets for the Godot editor, which uses GLB files. Create whatever the user requests as a good-quality low-poly asset using only Three.js in one complete standalone HTML file. The HTML must show the asset and include an Export GLB button that downloads a working GLB. If the requested asset needs animation, add it and include the animation in the exported GLB; otherwise make it static.
     ```
   - `defaultSampling`: `{ temperature: 0.8, top_p: 0.95, top_k: 40, min_p: 0, max_tokens: 24000 }`.
   - `params`: `path` (string: "Where to save the output, relative to the session folder"), `recheck` (string: "Path of a source file this tool saved earlier; re-runs it without generating"), `overwrite` (boolean: "Replace an existing output file"), each with `required: false` (the helper enforces the modes). These three are written generically because phase 07's kind declares the same names with the same schemas (phase 01 requires that).
3. `glb`'s `run` calls `runHtmlKind` with:
   - `sourcePath`: generate mode needs `path` ending in `.glb` (source `<path>.html`); recheck needs a path ending in `.glb.html` (target: the same path without `.html`, `overwrite` implied).
   - `requestSuffix`: " Export only the asset itself, with no ground, floor, backdrop or wall unless the request asks for one." (the spike's bench, torch and medic station).
   - `runOptions: { export: true }`.
   - `finish`: no GLB → `{ ok: false, problems: [] }` (the runner's errors already explain it). Otherwise `onProgress('Checking')`, `previewGlb(bytes)`; `ok === false` → its problems. On success write the GLB with `writeAsset`; if `ctx.visionSupported !== false` and `ctx.pendingImages.length < MAX_PENDING_IMAGES`, push `{ path: <glb path>, dataUrl: preview.png }`; return `toolResult` with the GLB path, the source path, "N meshes, N triangles", the animations (`Walk (5 tracks)` or "no animation"), the size in metres, and, when an image is attached, "Check the render: if it doesn't look like the request, call again with a clearer request." Set `thumbDataUrl` to the PNG for the tool card.
4. Guide: add a "3D assets (GLB)" section to `docs/guide/specialists.md`: a model that fits (`ccore/Qwen3.5-4B-GLB-3D-Coder`), that it needs the network to load Three.js from a CDN, where the GLB and its `.glb.html` source go, that the agent repairs failing code and re-checks it, and that the render reaches the model only when it has vision. Keep the page under 6 KB.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`, `npm run build`; the `Guide` check passes.

## Test plan
- `htmlKind.test.ts` (mock `callSpecialist`, `runAssetHtml`, `assetIo`; a fake `spec`):
  - Generate writes the source then calls `finish`; images from the run reach `callSpecialist`.
  - Neither `request`+`path` nor `recheck` → refusal; recheck with `request` or `path` → refusal; paths outside the folder → refusal; existing target without `overwrite` → refusal.
  - `length` finish and missing HTML → the two errors.
  - Run errors (with and without lines), a `console` error alone, and a `finish` problem each fail with the recheck instruction and no target write.
  - Recheck reads the source and never calls the specialist; recheck with images is refused; failure messages use the relative paths; `htmlCallLabel` names the rechecked file.
- `glb.test.ts` (mock `runHtmlKind`'s collaborators as above plus `previewGlb`): `.glb` / `.glb.html` path rules; export requested; success writes the GLB, attaches the image with vision and not without, and the result lists stats; a preview problem fails without writing.
- Extensibility (the overview's criterion): in `ask-specialist.test.ts`, the tool schema gains `path`, `recheck` and `overwrite` only when a GLB specialist is on for the session, and in `SpecialistsSection.test.ts` the Add menu lists both kinds; neither file needed a change for the new kind beyond these cases, proving a kind is added with one module and one import.
- Live test, dev build on Linux, Remote control API: a GLB specialist pointed at `http://asmodean:3000`, model `ccore-Qwen3.5-4B-GLB-3D-Coder.Q8_0`, the Code tab model on `http://compute:3000`; a scratch Godot-style project. Ask the agent for each of the 15 spike prompts in turn with an `assets/` path, with the kind's default system prompt. Then repeat the first five with "Send no system prompt" on (the server's own prompt), to check both paths. Pass: every prompt ends with a GLB in the project and its `.glb.html`, any repair done by the agent through a `recheck` call; record first-try and after-repair counts against the spike's 8/15 and 15/15 in issue #906.
- Hand test on Windows and macOS: one generate and one recheck each, through the GLB specialist.

## Commit
`feat(specialists): glb kind for 3D assets`

## Rollback
Revert the commit (helper, kind module, its import line, the guide section). Saved GLB specialist entries then become "unknown kind" entries that are kept but never offered (phase 01's filter), so users' settings survive a revert.
