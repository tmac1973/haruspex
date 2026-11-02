# Phase 06 — The `glb` kind

**Depends on:** 01, 03, 04, 05 · **Enables:** the feature's goal: the Code tab's model makes 3D assets through a specialist. Later kinds follow the same pattern.

## Goal
Register the `glb` kind. A call generates a Three.js HTML file with the specialist, saves it next to the target GLB, runs it headless, exports and checks the GLB, writes it into the project and shows the main model a render. A failing run returns the errors with line numbers and the HTML path; a `recheck` call on that path repeats the run on the edited file without generating again. User-visible: the PR body names `docs/guide/specialists.md`.

## Files touched
- `src/lib/specialists/kinds/glb.ts` — new: the kind.
- `src/lib/specialists/kinds/index.ts` — import `./glb.ts`.
- `src/lib/specialists/kinds/glb.test.ts` — new.
- `src/lib/agent/tools/ask-specialist.test.ts` — add a case with the real `glb` and `text` kinds registered.
- `src/lib/components/settings/SpecialistsSection.test.ts` — add a case that the Add menu lists both real kinds.
- `docs/guide/specialists.md` — add the GLB kind.

## Steps
1. Register `{ id: 'glb', label: '3D asset (GLB)', summary: 'Writes a Three.js scene and exports it as a GLB file.', writes: true, requestRequired: false }` with:
   - `defaultDescription`: "Makes a low-poly 3D asset (props, characters, buildings) as a GLB file. Send a short English request."
   - `defaultSystemPrompt` (the model card's prompt as of 2026-11-01):
     ```text
     Create game assets for the Godot editor, which uses GLB files. Create whatever the user requests as a good-quality low-poly asset using only Three.js in one complete standalone HTML file. The HTML must show the asset and include an Export GLB button that downloads a working GLB. If the requested asset needs animation, add it and include the animation in the exported GLB; otherwise make it static.
     ```
   - `defaultSampling`: `{ temperature: 0.8, top_p: 0.95, top_k: 40, min_p: 0, max_tokens: 24000 }`.
   - `params`: `path` (string: "Where to save the GLB, relative to the session folder; must end in .glb"), `recheck` (string: "Path of a .glb.html this tool saved earlier; re-runs it without generating"), `overwrite` (boolean: "Replace an existing GLB"). None is required by the schema; `run` enforces "either `request` and `path`, or `recheck`".
2. `run` — generate mode (`request` and `path`):
   - Validate `path` ends in `.glb` and resolves inside the session folder (`resolveShellPath` / `ctxCwd` as `make-asset.ts` does). If the GLB exists and `overwrite` is not true, refuse with the path.
   - Append to the request: " Export only the asset itself, with no ground, floor, backdrop or wall unless the request asks for one." (the spike's bench, torch and medic station).
   - `callSpecialist` with progress on the tool card. A `length` finish reason returns `toolError("The specialist ran out of tokens (max N). Raise Max tokens in Settings → Code → Specialists, or ask for a simpler asset.")`.
   - `extractHtml`; no HTML → `toolError` with the answer's first 500 characters.
   - Write the HTML to `<path>.html` through `assetIo(ctx)` / `writeAsset` (overwriting the old source is allowed: it belongs to this tool).
3. `run` — recheck mode (`recheck`): a call that also passes `request` or `path` is refused ("recheck takes no request or path: it re-runs the saved source"). The path must end in `.glb.html`, resolve inside the session folder (`resolveShellPath` / `ctxCwd`, as for `path`) and exist; read it; the GLB path is the same path without `.html`. No generation; `overwrite` is implied, because the GLB came from this source.
   - `callLabel(entry, args)`: `"<name>: recheck <file name>"` when `recheck` is set; otherwise `null`, so the tool's default label shows.
4. Both modes then:
   - `onProgress('Exporting')`, `runAssetHtml(html, { signal: ctx.signal })`.
   - If a GLB came back, `onProgress('Checking')`, `previewGlb(bytes)`.
   - **Failure** (no GLB, any run error including `console` ones, or `preview.ok === false`): do not write the GLB. Return `toolResult` (not `toolError`, so the model treats it as work to continue) with: "Export failed." then each error as `- line N: message` (or `- message` when the line is unknown) and each preview problem, then "The source is at <html path>. Fix it with your edit tools, then call ask_specialist with name '<name>' and recheck '<html path>'." A GLB that exported but failed the check is not written.
   - **Success**: write the GLB with `writeAsset`. If `ctx.visionSupported !== false` and `ctx.pendingImages.length < MAX_PENDING_IMAGES`, push `{ path: <glb path>, dataUrl: preview.png }`. Return `toolResult` with the GLB path, the source path, "N meshes, N triangles", the animations (`Walk (5 tracks)` or "no animation"), the size in metres, and, when an image is attached, "Check the render: if it doesn't look like the request, call again with a clearer request." Set `thumbDataUrl` to the PNG for the tool card.
5. Guide: add a "3D assets (GLB)" section to `docs/guide/specialists.md`: a model that fits (`ccore/Qwen3.5-4B-GLB-3D-Coder`), that it needs the network to load Three.js from a CDN, where the GLB and its `.glb.html` source go, that the agent repairs failing code and re-checks it, and that the render reaches the model only when it has vision. Keep the page under 6 KB.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`, `npm run build`; the `Guide` check passes.

## Test plan
- `glb.test.ts` (mock `callSpecialist`, `runAssetHtml`, `previewGlb`, `assetIo`):
  - Generate success writes `<path>.html` then `<path>`, attaches the image with vision and not without, and the result lists stats.
  - Path not ending in `.glb`, path outside the folder, existing GLB without `overwrite` → refusals.
  - Neither `request`+`path` nor `recheck` → refusal.
  - `length` finish and missing HTML → the two errors.
  - Run errors (with and without lines), a `console` error alone, and a preview problem each fail without writing the GLB, and the result names the recheck call.
  - Recheck reads the HTML, never calls the specialist, writes the GLB beside it; recheck with `request` or `path` and a recheck path outside the folder are refused; `callLabel` names the rechecked file.
- Extensibility (the overview's criterion): in `ask-specialist.test.ts`, the tool schema gains `path`, `recheck` and `overwrite` only when a GLB specialist is on for the session, and in `SpecialistsSection.test.ts` the Add menu lists both kinds; neither file needed a change for the new kind beyond these cases, proving a kind is added with one module and one import.
- Live test, dev build on Linux, Remote control API: a GLB specialist pointed at `http://asmodean:3000`, model `ccore-Qwen3.5-4B-GLB-3D-Coder.Q8_0`, the Code tab model on `http://compute:3000`; a scratch Godot-style project. Ask the agent for each of the 15 spike prompts in turn with an `assets/` path, with the kind's default system prompt. Then repeat the first five with "Send no system prompt" on (the server's own prompt), to check both paths. Pass: every prompt ends with a GLB in the project and its `.glb.html`, any repair done by the agent through a `recheck` call; record first-try and after-repair counts against the spike's 8/15 and 15/15 in issue #906.
- Hand test on Windows and macOS: one generate and one recheck each, through the GLB specialist.

## Commit
`feat(specialists): glb kind for 3D assets`

## Rollback
Revert the commit (kind module, its import line, the guide section). Saved GLB specialist entries then become "unknown kind" entries that are kept but never offered (phase 01's filter), so users' settings survive a revert.
