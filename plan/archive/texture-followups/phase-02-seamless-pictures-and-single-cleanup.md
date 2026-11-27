# Phase 02 — Seamless pictures, and the dead texture path removed

**Depends on:** phase 01 · **Enables:** nothing later depends on it; closes
the image-model gap #613 left.

**PR:** 1 of 3 ("texture fixes": phases 01–03).

## Goal

Since #613, no tool can ask the image model for a picture that tiles, which
a painted or photographic 3D material needs. Add `seamless: true` to
`make_asset`'s `image` kind, carried through on the plain-picture request.
Then remove the texture path in `src/lib/assets/single.ts`, which nothing
calls any more.

## Files touched

- `src/lib/agent/tools/make-asset.ts` — new `seamless` parameter (image kind
  only); passed to `makeSingleAsset`.
- `src/lib/assets/single.ts` — `SingleAssetInput.seamless`; `plainPicture`
  sets `seamless` on its request; `SingleKind` becomes
  `'sprite' | 'icon' | 'image'`; the texture branch, the "does not tile"
  handling in `finish`, and `DEFAULT_SIZE.texture` are removed.
- `src/lib/assets/single.test.ts` — texture tests removed; seamless test
  added.
- `src/lib/agent/tools/make-asset.test.ts` — seamless tests.
- `src/lib/code/system-prompt.ts` — the `make_asset` line mentions seamless
  pictures for materials.
- `docs/guide/images.md` — "Make art for a project" says a plain picture can
  be asked to tile.

## Steps

1. In `single.ts`, add `seamless?: boolean` to `SingleAssetInput`. In
   `plainPicture`, pass `seamless: input.seamless === true` on the
   `generateForTool` request. `forTool.ts` already turns it off when the
   backend lacks `seamlessTiling`, and adds a note starting "It does not
   tile". Pass `img.notes` through to the result unchanged.
2. Narrow `SingleKind` to `'sprite' | 'icon' | 'image'`. Delete the
   `untiled` logic in `finish`, which only a texture used. Remove
   `texture` from `DEFAULT_SIZE`. `makeSingleAsset` now always takes the
   sprite path for a non-image kind: a sheet of one on a backend with
   alpha, else `buildEntryRequest`.
3. In `make-asset.ts`, keep `KINDS` as
   `['sprite', 'icon', 'texture', 'image']`, typed as a local union, since
   `texture` no longer reaches `single.ts`. Add the schema property
   `seamless: { type: 'boolean', description: 'Image only: make the picture tile edge to edge, for a material. Pixel-art tiles are kind texture.' }`.
   Pass `seamless` into `makeSingleAsset` only when the kind is `image`.
4. If the result carries a note starting "It does not tile", the tool
   result keeps it, so the model can tell the user the backend can't tile.
5. Update the `make_asset` line in `system-prompt.ts` (backend case only):
   "Pass seamless: true with kind image for a painted material that must
   tile."
6. Update `docs/guide/images.md`. Add one sentence: a plain picture can be
   asked to tile, for a painted 3D material. If the backend in Settings →
   Image can't tile, the picture is still written, and the assistant says
   it won't tile.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`

## Test plan

- `make-asset.test.ts`: `{ kind: 'image', seamless: true }` reaches
  `makeSingleAsset` with `seamless: true`. A sprite call with
  `seamless: true` does not pass it. A "does not tile" note comes back in
  the result.
- `single.test.ts`: `plainPicture` with `seamless` sends `seamless: true`
  to `generateForTool`; without it, sends `false`.
- `npm run check` proves nothing still passes `kind: 'texture'` to
  `single.ts`.

## Commit

`feat(assets): seamless pictures from make_asset; drop the unused texture path in single.ts`

## Rollback

Revert the commit. Nothing later depends on it. Leaving it half-applied
(the parameter without the cleanup) is harmless.
