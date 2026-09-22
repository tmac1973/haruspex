# Phase 08 — Style anchor: contact sheet, approval, palette, recipe

**Depends on:** 02 (something must generate it), 03 (`image_store_bytes`, to
show the sheet), 04 (palette extraction), 07 (a spec exists) · **Enables:** 09 — every entry is conditioned on what this stage
produces.

## Goal

Establish the style, once, and commit it. The stage generates a single contact
sheet containing several representative subjects, gets it approved (or
auto-accepts it unattended), extracts the shared palette from it, and writes both
the image and the exact recipe that produced it into the project. Every later
run reuses those files rather than regenerating them, which is what makes an
asset added six months from now match the ones already shipped.

## Files touched

- `src/lib/agent/jobs/types/asset-generation/anchor.ts` — new. Generate,
  approve, extract, persist.
- `src/lib/agent/jobs/types/asset-generation/prompts.ts` — add
  `anchorPrompt(spec)`.
- `src/lib/agent/jobs/types/asset-generation/pipeline.ts` — implement `ANCHOR`.
- `src/lib/agent/jobs/types/asset-generation/types.ts` — new. `AnchorOutcome
  { source: 'reused' | 'generated'; approval: 'approved' | 'auto' | 'n/a';
  attempts: number; paletteSize: number }`, held by the pipeline and read by
  phase 10's report — the provenance line needs a structure, not prose scraped
  out of a stage's output.
- `src/lib/agent/jobs/types/asset-generation/anchor.test.ts` — new.

## Steps

1. Reuse first, always. If `spec.anchor.image` and `spec.anchor.recipe` both
   exist on disk and the recipe parses: load the image, **copy the recipe's
   `palette` into `spec.normalize.palette` and re-render the spec**, and finish
   with "Reused the committed anchor". That palette copy is not optional — a
   chained run derives a fresh spec every time, whose profile ships an empty
   palette, so without it a reused anchor reaches phase 09 with nothing to
   quantize against. Generating is the exception, not the rule; this ordering
   is the whole point of the phase.
2. Otherwise build the anchor prompt from `spec.style.prompt` plus a fixed
   instruction to render several distinct subjects — a character, a prop, a
   held object and a ground texture patch — arranged in one frame on a flat
   background of `profile.background.color`, formatted as hex. One image containing several
   subjects is far easier for a model than several agreeing images, and it
   demonstrates the style applied across subject types.
3. Generate at `min(target_size * upscale * 2, MAX_GENERATION_EDGE)` square —
   a 2×2 grid of generation-resolution cells, so with the defaults
   (32 × 16 × 2) that is 1024×1024. The clamp is the one phase 04 applies to
   entries, and it must apply here too: without it a `target_size` of 512,
   which phase 06 permits, asks for the 2048 px image the clamp exists to
   prevent. No new field is introduced. Record the
   seed from `ImageResult.meta`, which phase 01 guarantees is the resolved value
   even when the request passed `null`.
4. Approval — the run's only checkpoint, so it answers both open questions at
   once:
   - **attended** — store the bytes via `image_store_bytes`, put a markdown
     image reference to `haruspex-img://localhost/<hash>` into the stage's
     output **with a summary of the spec beside it** (entry count by kind and
     the first several ids), then call `ask_user_question` with Approve /
     Regenerate / Stop. No bespoke component and no new runner mechanism: the
     run view already renders a stage's markdown, and `ask_user_question` is
     already how a job parks for a human. Regenerate re-runs step 3 with a new
     seed, bounded by `anchor_attempts` — not `max_attempts`, which is the
     per-entry budget. Stop ends the run cleanly so the user can edit the spec
     file and re-run.
   - **unattended** — accept the first generation, and say so in the stage
     output so the report records that no human saw it.
5. Extract the palette from the approved sheet with `image_extract_palette`,
   passing the profile's `palette_size` and `background.color` as the exclusion
   — keying happens per entry later and the key colour must never enter the
   palette.
6. Write the palette back into `spec.normalize.palette` and re-render the spec,
   so the palette is versioned with the entries it governs.
7. Write the anchor image to `spec.anchor.image` (PNG, unmodified — it is a
   reference, not an asset) and the recipe to `spec.anchor.recipe` as an
   `AnchorRecipe` (phase 05). Every field is populated from the request plus
   `ImageResult.meta`, which carries the resolved `sampler` and `loras`
   precisely so this file can be written — that is why phase 01 echoes them
   back rather than leaving them on the request.
8. Commit both plus the spec when `use_git` is on, with
   `chore(assets): style anchor`. Skip silently when git is off, the same way
   the coding job does.
9. The stage returns an `AnchorOutcome` and its output names the anchor path,
   whether it was reused or generated, how many colours the palette has, and —
   when unattended — that it was auto-accepted.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Reuse: with both files present, no backend call is made at all. This is the
  most important test in the phase and gets an explicit
  `expect(backend.generate).not.toHaveBeenCalled()`.
- Reuse with a corrupt recipe falls back to generating, rather than failing.
- **Reuse restores the palette**: starting from a freshly derived spec whose
  `normalize.palette` is empty, the reuse branch leaves it populated from the
  recipe. Verify it has teeth by removing the copy and confirming phase 09
  would quantize against nothing.
- Generation records the backend-chosen seed into the recipe, not `null`, and
  the recipe's `sampler` and `loras` match `ImageResult.meta` rather than the
  request's unset fields.
- The generated sheet is `target_size * upscale * 2` on each edge at the
  defaults, and clamps to `MAX_GENERATION_EDGE` at `target_size: 512`.
- Attended: the stage output carries the sheet's `haruspex-img://` reference
  **and the spec summary**, and `ask_user_question` is called once;
  Regenerate calls the backend again with a different seed; Stop cancels the run
  cleanly; Regenerate beyond `anchor_attempts` stops asking and fails the stage
  with a clear message. A separate test raises `max_attempts` and asserts the
  anchor budget is unaffected.
- Unattended: `ask_user_question` is not in the stage's allowlist at all, the
  first generation is accepted, and the outcome records `approval: 'auto'`.
- Palette extraction excludes the background colour — fixture-driven, and it
  fails if the exclusion is removed.
- The spec is rewritten with the palette, and re-parsing it yields the same
  palette.
- Git off: no git command is issued anywhere in the stage.

## Commit

```
feat(jobs): generate, approve and commit the style anchor
```

## Rollback

Revert the `ANCHOR` stage to a pass-through and delete `anchor.ts` and
`types.ts`. Anchor files already written into a user's project are inert;
a later re-run with the stage restored will reuse them, which is the correct
behaviour.
