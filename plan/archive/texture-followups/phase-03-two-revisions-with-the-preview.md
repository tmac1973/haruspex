# Phase 03 — Two recipe revisions, and the reviser sees the preview

**Depends on:** phase 01 · **Enables:** phase 09 reuses the "revise while
looking" turn for transition sets.

**PR:** 1 of 3 ("texture fixes": phases 01–03).

## Goal

A texture the judge rejects gets one revision today, and the model writing
it works from the judge's sentence alone. Allow up to two revisions, and on
a vision model put the 3×3 preview the judge saw into the revising turn, so
the model sees what it is fixing.

## Files touched

- `src/lib/agent/jobs/types/asset-generation/codeTexture.ts` —
  `MAX_RECIPE_REVISIONS = 2`; the loop revises while
  `attempt <= MAX_RECIPE_REVISIONS`; passes the preview to `revise`.
- `src/lib/agent/jobs/types/asset-generation/generate.ts` —
  `CodeTextureDeps.revise(entry, reason, preview)`.
- `src/lib/agent/jobs/types/asset-generation/recipes.ts` — `RecipeDeps.ask`
  takes an optional image; `reviseRecipe(spec, entry, reason, deps, preview)`.
- `src/lib/agent/jobs/types/asset-generation/pipeline.ts` — `recipeDeps`
  sends the image as a prior user message when `ctx.visionSupported()`.
- `src/lib/agent/jobs/types/asset-generation/prompts.ts` — `recipePrompt`
  feedback line says the image shows the last recipe laid 3×3.
- `src/lib/agent/jobs/types/asset-generation/generate.test.ts`,
  `recipes.test.ts` — updated and new tests.
- `docs/guide/jobs.md` — the asset generation paragraph says a rejected
  texture is redrawn up to twice.

## Steps

1. In `codeTexture.ts`, add `export const MAX_RECIPE_REVISIONS = 2;`. In the
   loop, ask for a revision when `attempt <= MAX_RECIPE_REVISIONS` (it was
   `attempt === 1`). Keep the `shown` bytes from `forJudge`, and pass them
   to `code.revise(entry, reason, shown)`. When the judge did not look,
   `shown` is the bare tile, and no revision is asked for anyway, because
   `verdict` is null.
2. In `generate.ts`, change `CodeTextureDeps.revise` to
   `(entry, reason, preview: Uint8Array) => Promise<…>`.
3. In `recipes.ts`, change `RecipeDeps.ask` to
   `(prompt: string, image?: Uint8Array) => Promise<Map<…>>`. `askFor`
   forwards an image, and only `reviseRecipe` passes one.
4. In `pipeline.ts` `recipeDeps`, when an image is given and
   `ctx.visionSupported()` is true, add
   `history: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(image) } }] }]`
   and set `visionSupported: true` on that turn. Otherwise the turn is as
   today. Wire `revise: (entry, reason, preview) => reviseRecipe(spec, entry, reason, recipeDeps(ctx), preview)`.
5. Give `recipePrompt` a fifth parameter:
   `recipePrompt(textures, palette, stylePrompt, feedback?, imageShown = false)`.
   When `imageShown` is true, the feedback line reads: "The image shows
   your last recipe laid 3×3, as a map lays it. A reviewer said: …". It is
   true only when `reviseRecipe` has a preview and
   `ctx.visionSupported()` holds, so a text-only model is never told about
   an image it can't see. `RecipeDeps` gains `visionSupported: boolean`
   for this.
6. Update `docs/guide/jobs.md`: a texture the reviewer rejects is redrawn
   up to twice before it is kept and marked for Review assets.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`

## Test plan

- `generate.test.ts`: the judge says no, no, yes → three renders, two
  revisions, status `done`, `attempts: 3`. The judge says no three times →
  `unresolved`, `kept: true`, the judge called three times, `revise` called
  twice. `revise` receives the preview bytes (the harness's
  `preview` mock output).
- `recipes.test.ts`: `reviseRecipe` with a preview calls `ask` with the
  image, and the prompt mentions the 3×3 image. Without one, neither.
- A pipeline-level test (in the existing `runner.asset*.test.ts` style)
  checks the recipe turn gets the image only when vision is supported.

## Commit

`feat(assets): revise a rejected texture recipe twice, looking at the tiled preview`

## Rollback

Revert the commit. Phase 09 builds on the `ask(prompt, image)` signature,
so revert phase 09 first if it has landed.
