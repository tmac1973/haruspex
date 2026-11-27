# Phase 06 — What the chat model sees and can choose

**Depends on:** 03, 04, 05 · **Enables:** the full flow in the overview.

## Goal
The chat model learns which image models exist and what each can do, may name
one through a `model` argument, is only offered tools that some entry can run,
and can pass as many pictures to `edit_image` as the most capable entry takes.

## Files touched
- `src/lib/agent/tools/image-gen.ts`, `image-edit.ts`, `image-upscale.ts` —
  optional `model` argument; `edit_image`'s `MAX_IMAGES` and `also[]`
  `maxItems` come from the entries.
- `src/lib/agent/tools/registry.ts` — tool schemas built per turn from the
  entries; `edit_image` offered only when some entry can edit,
  `upscale_image` only when some entry can upscale.
- `src/lib/image/entries.ts` — `entryNames()`, `maxEditPictures()`,
  `anyEntryCan(op)` (an entry with `caps: null` counts as able).
- `src/lib/stores/settings.ts` — the IMAGES prompt block lists the entries
  when there are two or more.
- `src/lib/skills/needs.ts` — the "Set up now" note for `fix-picture` lists
  each entry's capability line instead of one backend's.
- `src/lib/image/capabilityLine.ts` — `entryLine(entry)`: the short form in
  step 5 ("klein: draws, edits up to 4 pictures, upscales."), used by both the prompt
  block and `needs.ts`.
- `src-tauri/resources/skills/fix-picture/SKILL.md` — "Set up now" is a list;
  pass `model` only when the user names one.
- Tests beside each; `docs/guide/image-editing.md` and `docs/guide/images.md`.

## Steps
1. `model` argument: present only when there are two or more entries; an enum
   of `entryNames()`, description "Leave out to use the first model that can
   do this." The tool passes it to `routeImage` as `named`.
2. Tool schemas depend on settings, so the registry builds the three image
   schemas when it assembles a turn's tool list (it already filters by
   category per turn at registry.ts:285); cache by `entryConfigKey` of every
   entry plus their `caps`, so a turn with an unchanged list reuses them.
3. `maxEditPictures()` = the largest of: `maxEditImages` of each entry whose
   snapshot can edit, and 4 for each entry with `caps: null` (today's fixed
   cap). With no entry able to edit, `edit_image` is not offered (step 4). `edit_image` caps `1 +
   also.length` at it and the schema's `also.maxItems` is it minus 1. The
   router still refuses a count the chosen entry can't take (Phase 04).
4. Tool offer: `anyEntryCan('edit')` gates `edit_image`; `anyEntryCan('upscale')`
   gates `upscale_image`; `generate_image` is offered whenever an entry can
   draw (every entry can). `generationRefusal` keeps refusing when the list is
   empty.
5. Prompt block, two or more entries:
   ```
   IMAGES: models, in the order used:
   - Ming-Image 0.1 Design: draws, transparent backgrounds.
   - klein: draws, edits up to 4 pictures, upscales.
   Pass `model` only when the user names one.
   ```
   One entry: today's block unchanged. Keep each line to the capability words
   `capabilityLine` already uses, so the 9B prompt grows by one short line
   per entry.
6. `fix-picture`'s "Set up now" gets the same list, built by `entryLine`,
   with the Settings path after it ("Settings → Image").

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan
- Registry tests: with entries {draw-only}, `edit_image` and `upscale_image`
  are not offered; add an edit entry and `edit_image` appears; an entry with
  `caps: null` keeps both offered.
- Schema tests: one entry → no `model`; two → enum of both names;
  `also.maxItems` is 9 with a FLUX.3 Image Klein entry (`max_edit_images: 10`)
  and 3 with only klein.
- `image-edit.test.ts`: 10 pictures with a FLUX.3 entry runs; 10 with only
  klein is refused before any request.
- Prompt snapshot for one and for three entries.
- Live: on asmodean with FLUX.3 Image Klein, klein and qwen-image-edit-2511
  entries, ask Chat to combine five pictures; it runs on FLUX.3 Image Klein.
  Ask "use Ming-Image to edit this"; the tool refuses and names the entries
  that can edit.

## Commit
`feat(image): let the chat model see and pick the image models`

## Rollback
Revert the commit. Nothing is saved; tools go back to the fixed schemas and the
single-line prompt, and routing still works without names.
