# Phase 06 — A texture-only tool for jobs

**Depends on:** 02 · **Enables:** 08

## Goal
`make_asset` takes every kind, and an allowlist can't narrow a tool to one
kind. The 3D job's Allow textures box must offer code-drawn textures and
nothing that needs an image backend. Add `draw_texture`, a thin tool over
`make_asset`'s texture branch, offered only through a job allowlist.

## Files touched
- `src/lib/agent/tools/make-asset.ts` — export `drawTexture(args, ctx)` (the existing texture branch, unchanged behaviour).
- `src/lib/agent/tools/draw-texture.ts` (new) — registers `draw_texture`.
- `src/lib/agent/tools/draw-texture.test.ts` (new).
- `src/lib/agent/tools/index.ts` — import it.
- `src/lib/agent/tools/registry.ts` — `draw_texture` is never offered by the normal filter (job allowlist only).

## Steps
1. In `make-asset.ts`, lift the `kind === 'texture'` path (recipe check, `renderTexture`, variants, 3×3 preview, `textureNote`) into `export async function drawTexture(args: Record<string, unknown>, ctx: ToolContext)`. `make_asset` calls it for textures; its tests stay green.
2. `draw-texture.ts`: schema = `make_asset`'s `prompt`, `path`, `recipe`, `size`, `variants`, `overwrite` (copy the descriptions). Description: "Draw a tiling texture PNG by code from a recipe, for kit.texture() in a build module. Put it in the model's textures/ folder." `execute` calls `drawTexture({ ...args, kind: 'texture' }, ctx)`. Refuse a `path` that is not a `.png`.
3. Register `draw_texture` with a new category `'job'`, and add `reg.category === 'job'` to the job-owned categories (`audit`, `planning`, `coding`, `memory`) that `registry.ts` never offers by default. `toolAllowlist` still offers it.

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/agent/tools`, `npm run format:check`.

## Test plan
- Unit: `draw_texture` writes a PNG from a minimal recipe through a fake `assetIo`; refuses a non-png path.
- Unit: the normal Code-tab and chat filters never include `draw_texture`; an allowlist does.
- `make-asset` tests unchanged.

## Commit
`feat(tools): draw_texture, a job-only code-drawn texture tool`

## Rollback
Revert; `make_asset` keeps its own copy of the branch after the revert.
