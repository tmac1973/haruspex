# Phase 08 — Transitions in the asset spec

**Depends on:** phase 06 (the `TransitionView` and `TransitionEdge` types)
· **Enables:** phase 09 (the job draws what the spec lists).

**PR:** 3 of 3 ("transitions": phases 06–10).

## Goal

Give the asset spec a top-level `transitions` list. Teach both spec writers
to fill it: the job's own spec stage and guided planning's asset step. A
set is listed wherever two ground textures meet on the map, and once per
side-view platform material. This phase only records sets; phase 09 draws
them.

## Files touched

- `src/lib/assets/spec/types.ts` — `TransitionEntry`;
  `AssetSpec.transitions?: TransitionEntry[]`.
- `src/lib/assets/spec/parse.ts` — `transitions` added to `KNOWN_KEYS` and
  parsed.
- `src/lib/assets/spec/validate.ts` — reference, view and path checks.
- `src/lib/assets/spec/write.ts` — written after `entries`, omitted when
  empty.
- `src/lib/assets/spec/paths.ts` — `defaultTransitionOut(id)`.
- `src/lib/assets/spec/spec.test.ts` — round-trip and validation tests.
- `src/lib/agent/tools/coding.ts` — `submit_asset_spec` schema gains
  `transitions` (by title).
- `src/lib/agent/jobs/types/asset-generation/tools.ts` —
  `submit_plan_asset_spec` schema gains `transitions` (by id).
- `src/lib/agent/jobs/types/asset-generation/derive.ts` — `deriveSpec` and
  `derivePlanSpec` turn submitted transitions into `TransitionEntry`s.
- `src/lib/agent/jobs/types/asset-generation/derive.test.ts` — tests.
- `src/lib/agent/jobs/types/asset-generation/prompts.ts` — new
  `TRANSITION_RULE` lines, used by `specDerivationPrompt`.
- `src/lib/agent/jobs/types/guided-planning/pipeline.ts` — the asset step's
  prompt includes `TRANSITION_RULE`.

## Steps

1. **Type** in `types.ts`:
   ```ts
   export interface TransitionEntry {
   	id: string;            // ID_PATTERN, unique across entries and transitions
   	view: TransitionView;  // 'top' | 'side'
   	a: string;             // texture entry id: material A, or the solid
   	b?: string;            // texture entry id: material B (top only, required there)
   	cap?: string;          // texture entry id: drawn on upward faces (side only)
   	out: string;           // sheet path; the JSON map is the same stem + .json
   	edge?: TransitionEdge; // written by the recipe stage (phase 09)
   	rejected?: string;     // as on AssetEntry
   	notes?: string;
   }
   ```
2. **Parse**: add `'transitions'` to `KNOWN_KEYS`. Map each raw item to a
   `TransitionEntry`, dropping items that aren't objects. `view` defaults to
   `'top'`. `out` is kept as written, `''` when absent (validation then
   reports it). Keep `edge` as given; Rust validates it when drawing.
3. **Validate**, each problem a sentence naming the transition's id:
   - id matches `ID_PATTERN`, and is unique across entries and
     transitions;
   - `a`, `b` and `cap` name existing entries of kind `texture`;
   - `view: 'top'` has `b` and no `cap`; `view: 'side'` has no `b`;
   - `a !== b` and `a !== cap`;
   - `out` is non-empty, passes `escapesWorkdir`, and is not any entry's `out` or any of
     its `variants`.
4. **Write**: `transitions` after `entries`, omitted when absent or empty.
   An existing spec without the key round-trips byte for byte.
5. **Paths**: `defaultTransitionOut(id)` returns
   `assets/generated/transition/${id}.png`.
6. **Tool schemas**: both submit tools gain
   ```
   transitions: { type: 'array', items: { type: 'object', properties: {
     title: string,               // "Grass to dirt" (submit_asset_spec) — or id (submit_plan_asset_spec)
     view: { enum: ['top','side'] },
     a: string, b: string, cap: string   // entry titles (job) or ids (plan)
   }, required: ['view','a'] } }
   ```
   The descriptions say: top for two ground textures that touch on the map,
   side for platform ground against air with an optional surface texture
   as `cap`.
7. **Derive**: `deriveSpec` resolves `a`, `b` and `cap` titles to the ids
   it assigned (case-insensitive, trimmed). Its own id comes from `title`
   through `uniqueId`, sharing the `taken` set with entries. Both derive
   functions set `out` to `defaultTransitionOut(id)`, as they do for
   entries with `defaultOutPath`. Default title
   when absent: `"<a> to <b>"` or `"<a> platform"`. `derivePlanSpec` takes
   ids as given. A name that matches no entry is kept as written, so
   `validateAssetSpec` (step 3) reports it. The existing retry
   (`specRetryPrompt` with the validation problems) then asks the model to
   correct it, as it does for entries.
8. **Prompt**: add to `prompts.ts`
   ```ts
   export const TRANSITION_RULE: string[] = [
   	'   - `transitions`: where two ground textures touch on the map (grass and',
   	'     a dirt path, sand and water), list one `top` transition naming both.',
   	'     For a side-view game, list one `side` transition per platform ground,',
   	'     naming its texture as `a` and, if its top surface differs (grass on',
   	'     dirt, snow on rock), that surface\'s texture as `cap`. Skip pairs that',
   	'     never meet. Both materials must be texture entries in your list.'
   ];
   ```
   Insert it after `KIND_RULE` in `specDerivationPrompt`, and after
   `...KIND_RULE` in guided planning's asset step prompt.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`

## Test plan

- `spec.test.ts`: a spec with two transitions parses and writes back
  identically. A spec without `transitions` writes byte for byte as
  before. Each validation rule in step 3 has a failing case whose message
  names the id.
- `derive.test.ts`: titles resolve to ids; an unknown title is kept as
  written, and `validateAssetSpec` then reports it; a side transition with
  a cap resolves both; ids don't collide with entry ids; `derivePlanSpec`
  keeps given ids.
- `prompts.test.ts`: `specDerivationPrompt` contains `TRANSITION_RULE`.
  The guided-planning asset prompt test (in its pipeline tests) does too.
- The asset job given a spec with transitions runs exactly as before:
  phase 09 hasn't wired them in yet, and they are carried through
  untouched. A `runner.asset*` test checks the spec on disk after a run
  still holds them.

## Commit

`feat(assets): transitions in the asset spec, listed where ground materials meet`

## Rollback

Revert the commit. A spec written with `transitions` meanwhile still
parses: `parse.ts` keeps unknown top-level keys in `spec.unknown` and
writes them back, so the sets survive untouched until this phase returns.
Revert phase 09 first if it has landed.
