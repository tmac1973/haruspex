# Phase 09 — The asset job draws transition sets

**Depends on:** phase 03 (`RecipeDeps.ask` with an image), phase 06 (the
renderer), phase 08 (`spec.transitions`) · **Enables:** phase 10.

**PR:** 3 of 3 ("transitions": phases 06–10).

## Goal

When the spec lists transitions, the asset job writes each set's edge
settings, draws the sheet and its JSON map once the material textures
exist, and judges the set as a small map. On a no, it revises the edge
settings once while looking at that map. The report and Review assets show
the sets beside the textures.

## Files touched

- `src/lib/agent/jobs/types/asset-generation/transitions.ts` — new. Draws,
  judges and records one set, like `codeTexture.ts`.
- `src/lib/agent/jobs/types/asset-generation/transitions.test.ts` — new.
- `src/lib/agent/jobs/types/asset-generation/recipes.ts` — the recipe turn
  also asks for edge blocks; `reviseEdge`.
- `src/lib/agent/jobs/types/asset-generation/tools.ts` —
  `submit_texture_recipes` gains `edges`; `parseRecipes` returns them.
- `src/lib/agent/jobs/types/asset-generation/prompts.ts` — `recipePrompt`
  lists transitions; `TRANSITION_HINT`; `edgeRevisionPrompt`.
- `src/lib/agent/jobs/types/asset-generation/pipeline.ts` — runs the sets
  after `generateEntries`; judges them; writes the spec.
- `src/lib/agent/jobs/types/asset-generation/types.ts` —
  `TransitionOutcome`.
- `src/lib/agent/jobs/types/asset-generation/report.ts` (+ test) — a
  "Transition sets" section.
- `src/lib/agent/jobs/types/asset-generation/review.ts` (+ test) — marking
  and remaking sets.
- `src/lib/agent/jobs/types/asset-generation/ReviewAssets.svelte` (+ test) —
  set cards.
- `docs/guide/jobs.md` — the asset generation paragraph.

## Steps

1. **Edge blocks in the recipe turn.**
   - `tools.ts`: `submit_texture_recipes` gets an optional
     `edges: [{ id, edge: { wobble?, rim?, cap_height? } }]`. `parseRecipes`
     returns `{ recipes, edges }`: `recipes` is the existing
     `Map<string, SubmittedRecipe>`, and `edges` is a `Map<string, unknown>`.
   - `recipes.ts`: `RecipeDeps.ask` now resolves to that
     `{ recipes, edges }` object (phase 03 left it returning the recipe
     map). `askFor` reads `.recipes`. `pipeline.ts`'s `recipeDeps` returns
     the whole `parseRecipes` result. The test doubles in
     `recipes.test.ts` and `generate.test.ts` change to match.
   - `prompts.ts`: `recipePrompt` gains a sixth parameter, making it
     `recipePrompt(textures, palette, stylePrompt, feedback?, imageShown = false, transitions: Array<{ id, view, a, b?, cap?, notes? }> = [])`.
     When `transitions` is non-empty, it adds:
     "Transition sets, drawn from the textures above where they meet. For
     each, give an edge: wobble 0–0.25 (how far the border wanders; 0.1
     for built edges, 0.2 for natural ones), rim a #rrggbb line along the
     border (usually a shade darker than the material it borders) or none,
     cap_height 1–8 for side sets (how deep the top surface is). Give it in
     `edges`."
     Then one line per set: `- <id>: <view>, <a> meets <b>` or
     `- <id>: side, <a> with <cap> on top` (`<a> alone against air` when
     there is no cap). When the set has `notes` (from Make again), the
     next line reads `  The user asked for this set: <notes>`.
   - `recipes.ts` `writeRecipes` passes the spec's transitions that have no
     `edge`. The recipe turn now runs when any texture lacks a recipe *or*
     any transition lacks an edge. A re-run after Make again therefore
     asks for that set's edge, with its note, even when every texture
     already has a recipe. Textures that already have a recipe are not
     listed in that turn. Each returned edge is checked with `validateTransitionEdge`; a
     refused one gets one retry, as recipes do. A set still without an edge
     takes `{}` (all defaults), not a failure. The edges are written into
     `spec.transitions[*].edge`.
2. **`transitions.ts`** — `runTransition(t, ctx)`, where `ctx` carries
   `spec`, `deps` (as `CodeTextureContext`), `render`, `preview`, `judge`,
   `revise` and `record`. For one `TransitionEntry`:
   - If `escapesWorkdir(t.out)`, fail with the reason.
   - If `t.out` exists, record `skipped`.
   - Look up `a`, and `b` or `cap`. If any lacks a `recipe` (its texture
     failed, or `code_textures` is off), fail: "The set needs <id>'s
     recipe, and it has none."
   - Seeds: `textureSeed(aEntry)` and `textureSeed(bEntry | capEntry)`, so
     the uniform tiles equal each material's variant-0 tile.
   - Draw with `renderTransition(view, a.recipe, other?.recipe, t.edge ?? {}, tileSize, seedA, seedOther, [])`.
     `tileSize` is the same value the pipeline already passes to code
     textures, `Math.min(256, spec.normalize.target_size || DEFAULT_TARGET_SIZE)`,
     so every material and set in a run shares one size. The palette is
     `[]` because code textures in the job are not palette-snapped either
     (the pipeline's `render` passes `[]`), so uniform tiles still equal
     the material tiles.
     Write the sheet to `t.out` and the JSON from
     `transitionMap(view, tileSize, a.id, other?.id)` to the `.json` path,
     through `writeWorkdirFile`.
   - If the judge is on, build `transitionPreview(view, sheet, tileSize)`
     and judge it (step 3). On a no with `attempt === 1`, call
     `revise(t, reason, preview)` (step 4). Sets get one revision, not
     the textures' two: that was the decision for sets (overview,
     "Set rejects"), because only the edge can change. If it returns an edge, redraw
     and judge again. A second no, or no revision, keeps the files and
     records `unresolved` with the reason.
   - Record `{ id, status, attempts, reason?, edge?, files: [sheet, json] }`
     as a `TransitionOutcome`.
3. **Judging** in `pipeline.ts`: `judgeTransition(ctx, spec, t, image, anchor)`,
   shaped like `judgeAsset`. Subject: for top,
   `"<a's drawn or prompt> meeting <b's drawn or prompt>, as edge tiles"`;
   for side, `"platform ground of <a> with <cap> on top"`. Call
   `judgePrompt(subject, spec.style.prompt, undefined, TRANSITION_HINT)`,
   which asks the two general questions, not the texture one. Add to
   `prompts.ts`:
   `TRANSITION_HINT = 'This is a set of edge tiles drawn by code, shown laid out as a small map. Judge whether the two materials meet naturally — a border that wanders, not a ruler line or a grid of squares — and whether any tile shows a seam against its neighbours. Do not judge the materials themselves; they were approved already.'`
   For side sets, append: `' Empty air is shown as a checkerboard.'`
4. **Revision**: `reviseEdge(spec, t, reason, deps, preview)` in
   `recipes.ts`. It sends `edgeRevisionPrompt(t, reason, imageShown)`
   through `deps.ask(prompt, preview)` (phase 03's signature): "The image
   shows the set laid out as a map. A reviewer said: <reason>. The edge
   was <json>. Submit a new edge for <id> in `edges`, and no recipes."
   It takes `edges.get(t.id)` and validates it; returns null if refused or
   absent. Material recipes are never changed here.
5. **Pipeline** (`pipeline.ts`), after `generateEntries`, only when
   `codeTextures` is on and `spec.transitions?.length`:
   - Patch the step: `Drawing transition sets…`.
   - Run `runTransition` for each, sequentially (each takes milliseconds
     plus a judge turn).
   - Apply outcomes to the spec: set the revised `edge`, and set or clear
     `rejected` as `markRejections` does for entries. Write the spec once.
   - Add to the step summary: `N transition set(s) drawn.`
   - When `codeTextures` is off and the spec has transitions, add the line:
     "Transition sets were skipped: they are drawn from code-drawn
     textures (Draw textures in code)."
6. **Report** (`report.ts`): a "Transition sets" section after the
   code-texture section, with one row per set: id, view, materials,
   status, files, and the reviewer's reason when unresolved. Omitted when
   there are none.
7. **Review assets** (`ReviewAssets.svelte`, `review.ts`):
   - List sets after textures. Each card shows the preview map (built on
     open with `transitionPreview` from the sheet on disk), the id, view,
     materials and any `rejected` reason.
   - "Make again" with a note: move the sheet and the JSON to `.history`
     with `historyPath`, drop `edge`, and put the note in `notes`. The
     next run's recipe stage then writes a new edge with the note in its
     prompt line for that set.
8. **Guide** `docs/guide/jobs.md`: one or two sentences in the asset
   generation paragraph. Where ground textures meet, the job also draws
   16-tile edge sets (and platform sets for side-view games), each as a
   4×4 sheet with a JSON map, when textures are drawn in code. Keep the
   page under 6 KB.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`

## Test plan

- `transitions.test.ts` (render, preview and judge injected, as
  `generate.test.ts` does for code textures):
  - Draws a top set from two recipes with the materials' own seeds, and
    writes the sheet and the JSON.
  - Skips a set whose sheet exists.
  - Fails a set whose material has no recipe, naming it.
  - Judge no then yes: one revision, redrawn with the new edge,
    `attempts: 2`, and the revised edge returned.
  - Judge no twice: `unresolved`, files kept.
  - The judge isn't called, and no preview is built, when judging is off.
- `recipes.test.ts`: edges parsed and validated; a refused edge retried
  once; a still-missing edge becomes `{}`; `reviseEdge` sends the image.
- `prompts.test.ts`: `recipePrompt` lists transitions only when given;
  `edgeRevisionPrompt` mentions the image only when `imageShown`.
- `report.test.ts`: the section appears with a set, and not without.
- `review.test.ts`: Make again moves both files to `.history` and drops
  `edge`.
- `ReviewAssets.test.ts`: a set card renders with its reason.
- A `runner.asset*` end-to-end test with stubbed IPC: a spec with two
  textures and one top transition writes three PNGs, a JSON map, and a
  spec carrying the edge.

## Commit

`feat(assets): the asset job draws and judges transition sets`

## Rollback

Revert the commit. Specs keep their `transitions` (phase 08) and any
written `edge`. Sets already drawn stay on disk, and nothing draws new
ones.

## As built

- `RecipeDeps.ask` resolves to `Submitted` (`{ recipes, edges }`), read by
  `parseSubmitted`. `parseRecipes` is still there for the recipes alone.
- **A run with every texture recipe in place still asks for edges** when a
  set has none, with `recipes` empty. That covers Make again on a set, so
  its note reaches the model.
- The pipeline's set step is a helper, `drawTransitions`; the pipeline
  function was already far over the lint limits. `judgeAsset` and the new
  `judgeTransition` share `judgeImage`.
- **Review assets shows a set as its 4×4 sheet,** not the preview map.
  The sheet is already on disk, and showing it calls nothing in Rust.
- **The guide is on the `textures` page,** not `jobs`, which has no room.
- The report's code-texture table now counts revisions ("passed after 2
  revision(s)"). That fix is in PR 1, since phase 03 is what made two
  possible.
- The end-to-end test is in `runner.assetGenerate.test.ts`, with the
  texture commands added to `wireFs`.
