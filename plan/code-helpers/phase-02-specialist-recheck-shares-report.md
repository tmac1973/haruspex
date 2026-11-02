# Phase 02 — The GLB specialist reports like the helper

**Depends on:** 01 · **Enables:** one way of judging a GLB across the app, so
06's tool and the specialist read the same

## Goal

The 3D asset (GLB) specialist's generate and recheck results switch from "N
meshes, N triangles; size" plus one render to the phase 01 report text and
render sheet. Its flow (generate, run the button page, check, write) is
unchanged. `previewGlb` and its single render go away.

## Files touched

- `src/lib/specialists/kinds/glb.ts` — `finish` uses `loadGlb`, `inspectGlb`,
  `renderSheet` and `formatReport`; the `stats` function is removed.
- `src/lib/specialists/kinds/glb.test.ts` — updated to the new text.
- `src/lib/specialists/three/preview.ts` — deleted; `preview.test.ts` cases
  that still matter move to `src/lib/glb/report.test.ts`.
- `src/routes/dev/glb-runner/+page.svelte` — show the sheet and the formatted
  report instead of `GlbPreview`.
- `docs/guide/specialists.md` — the 3D asset (GLB) kind's paragraph says the
  agent gets a size and parts report and a six-view render sheet.

## Steps

1. In `glb.ts` `finish`: `loadGlb(result.glb)`; on `{ error }` return
   `{ ok: false, problems: [error] }`. `inspectGlb`; if `report.problems` is
   non-empty, return them as today. Write the GLB as today.
2. Render the sheet with `renderSheet(gltf.scene, report)`; push it to
   `ctx.pendingImages` under the same conditions as now (`png !== null`,
   vision not false, under `MAX_PENDING_IMAGES`).
3. The result lines: `Saved <target> (source: <source>).`, then
   `formatReport(report)`, then, when the sheet was attached, `The render sheet
   is attached (front, right, back, left, top, three-quarter, over a floor
   grid): if it doesn't look like the request, fix the page or call again with
   a clearer request.` The tool result's thumbnail is the sheet.
4. `disposeTree(gltf.scene)` after rendering.
5. Update the dev runner page and delete `preview.ts`, moving its NaN /
   no-mesh / zero-size cases into `report.test.ts`.
6. Update the guide paragraph; keep `specialists.md` under 6 KB.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/specialists src/lib/glb src/lib/agent/tools`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- Kind tests: a recheck with a passing GLB returns text starting `Saved` and
  containing `Size:` and `meshes,`; a GLB with no meshes fails with `The GLB
  has no meshes.`; a NaN mesh fails.
- Manual: `npm run tauri dev`, `/dev/glb-runner` with
  `plan/specialist-models/fixtures` pages shows the sheet and report.
- Manual (optional, needs a specialist server): one GLB specialist recheck in
  a Code session shows the sheet as the tool card's thumbnail.

## Commit

`feat(specialists): GLB recheck returns the full report and render sheet`

## Rollback

Revert the commit: `preview.ts` and the old result text come back. Phase 01's
module stays and is harmless with no callers.
