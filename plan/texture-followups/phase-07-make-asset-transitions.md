# Phase 07 — Transition sets from `make_asset`

**Depends on:** phase 06 (the renderer and its TypeScript wrappers) ·
**Enables:** phase 10 (live check through `make_asset`).

**PR:** 3 of 3 ("transitions": phases 06–10).

## Goal

Let the Code-tab or Shell assistant ask for a transition set. It passes the
recipes it already wrote for its textures, and gets back the 4×4 sheet,
the JSON map, and the preview map to look at. Like textures, this needs no
image backend.

## Files touched

- `src/lib/agent/tools/make-asset.ts` — `transition` kind and its
  arguments: `view`, `recipe`, `recipe_b`, `cap`, `edge`.
- `src/lib/agent/tools/make-asset.test.ts` — transition tests.
- `src/lib/assets/texture.ts` — `transitionFiles(path)`: the sheet path and
  its `.json` sibling.
- `src/lib/agent/tools/registry.ts` — `changedFiles` reports the sheet and
  the JSON for a transition.
- `src/lib/code/system-prompt.ts` — the `make_asset` line names transitions.
- `docs/guide/images.md` — a paragraph on transition sets.

## Steps

1. Add `'transition'` to `KINDS`. Add schema properties:
   - `view`: `{ type: 'string', enum: ['top', 'side'], description: 'Transition only: top for two ground materials meeting, side for platform ground against air.' }`
   - `recipe_b`: `{ type: 'object', description: 'Transition, top only: the second material's recipe, as you wrote it for its texture.' }`
   - `cap`: `{ type: 'object', description: 'Transition, side only: a recipe drawn along upward faces (grass on dirt). Optional.' }`
   - `edge`: `{ type: 'object', description: 'Transition only: { wobble?: 0–0.25, rim?: "#rrggbb", cap_height?: 1–8 (side) }.' }`
   - `seed_from`: `{ type: 'string', description: 'Transition only: the texture file you drew recipe into, so the plain tiles match it exactly.' }`
   - `seed_from_b`: `{ type: 'string', description: 'Transition, top only: the texture file you drew recipe_b into.' }`
   - Extend `recipe`'s description: for a transition, the first material
     (top) or the solid (side).
2. In `parseInput`, for `transition`: require `recipe`. Require `view` to be
   `top` or `side`. Require `recipe_b` for `top`. Take `cap` for `side`,
   and ignore `recipe_b` there. Return a clear sentence for each missing
   piece. `size` defaults to 32, like a texture.
3. Add `makeTransition(input, target, ctx)` beside `makeTexture`:
   - Validate `recipe`, and `recipe_b` or `cap`, with `validateRecipe`. Each
     refusal names which one: "recipe_b was refused: …". Validate `edge`
     with `validateTransitionEdge`.
   - Dry-run write both files from `transitionFiles(path)`: the sheet at
     `path`, and the JSON at the same stem with `.json`.
   - Read `palette_from` as for textures.
   - Seeds. A material's plain tile was seeded from its texture's path
     (`seedOf(path)` in `makeTexture`). So that a set's uniform tiles equal
     those tiles exactly, the tool takes `seed_from` (the path A's or the
     solid's texture was written to) and `seed_from_b` (B's, top-down
     only). Each seed is `seedOf(resolveShellPath(p, cwd))`. When one is
     absent, its seed is `seedOf(path + '#a')` or `seedOf(path + '#b')`;
     the tiles are then the same material, just not those exact pixels.
     The cap's seed is always `seedOf(path + '#cap')`.
   - Render with `renderTransition`, and write the sheet. Add a
     `writeText(path, text, overwrite, dryRun)` method to `AssetIo`, using
     `fs_write_text` in a Code session's folder or
     `fs_write_text_absolute` otherwise, as the bytes methods do. Write the
     JSON from `transitionMap` through it, with names `"a"` and `"b"`
     (top-down), or `"solid"` and, when there is a cap, `"cap"`
     (side-view). The result text says which
     recipe was `a` and which `b`.
   - Build the preview with `transitionPreview`, and push it to
     `pendingImages` when the model can see. Result text: `Wrote <sheet>
     and <json> (16 tiles, <n>×<n> each, in a 4×4 sheet; the JSON names
     each tile's corners).` Add the line: `The image shows the set laid out
     as a small map. If a border looks like a straight seam or the rim is
     too loud, change edge and draw again with overwrite: true.`
4. `registry.ts` `changedFiles`: for `make_asset` with `kind: 'transition'`
   and a `Wrote` result, return `transitionFiles(args.path)`.
5. `system-prompt.ts`: in both variants of the `make_asset` line, add "or
   a transition set where two textures meet (pass the recipes you used)".
6. `docs/guide/images.md`: add a short paragraph under "Make art for a
   project": ask for the edges between two textures, or platform ground
   with a grass top. You get one 4×4 sheet of 16 tiles and a JSON file
   naming each tile's corners, for an engine's corner-matching terrain
   (Godot's Match Corners, Tiled's corner sets). Mention what it doesn't
   do: no 47-tile sets and no isometric tiles. Keep the page under 6 KB.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`

## Test plan

`make-asset.test.ts`, with `texture_transition_render`,
`texture_transition_preview` and `texture_transition_validate` routed in
the invoke mock:

- A top-down set writes the sheet and the JSON, calls render with both
  recipes and `view: 'top'`, and pushes the preview image.
- A side-view set without a cap calls render with `other` absent; with a
  cap, passes it.
- Missing `recipe_b` on a top set, a missing `view`, and a refused `cap`
  each come back as a sentence naming the argument, before anything is
  written.
- `seed_from` and `seed_from_b` set `seed_a` and `seed_other` to those
  paths' seeds; without them, the seeds come from the sheet path with
  `#a` and `#b`.
- No image backend: a transition still works.
- `changedFiles` (through `executeTool`) reports both files.

## Commit

`feat(assets): transition sets from make_asset`

## Rollback

Revert the commit. The renderer (phase 06) and the job (phase 09) don't
depend on it.
