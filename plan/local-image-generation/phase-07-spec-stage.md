# Phase 07 — Spec stage: load or derive the asset spec

**Depends on:** 06 · **Enables:** 08 and 09 always have a spec to work from;
11 relies on the same stage accepting a spec written upstream.

## Goal

Fill in stage 0. If the configured spec file exists, load, validate and report
it. If it does not, derive one from the job's description using the LLM and
write it. Either way the stage ends with a spec on disk and a summary in the run
view — and asks nothing, because the anchor stage owns the single checkpoint.
This is what makes the feature usable from a one-line prompt without making the
spec optional: the contract is always a file on disk.

## Files touched

- `src/lib/agent/jobs/types/asset-generation/pipeline.ts` — implement `SPEC`.
- `src/lib/agent/jobs/types/asset-generation/prompts.ts` — new.
  `specDerivationPrompt(description, workingDir)`.
- `src/lib/agent/jobs/types/asset-generation/tools.ts` — new. The
  `submit_asset_spec` forced tool schema.
- `src/lib/agent/jobs/types/asset-generation/derive.ts` — new. Turn the tool
  payload into an `AssetSpec`, assigning ids and output paths the runner owns.
- `src/lib/agent/jobs/runner.test.ts` — update the phase-06 "no spec finishes
  succeeded" test, which this phase deliberately changes.
- `src/lib/agent/jobs/types/asset-generation/*.test.ts` — extend.

## Steps

1. Stage logic: resolve the spec path; if the file parses and validates, finish
   the stage with the entry count and the style line. If it parses but fails
   validation, fail the run with the validation problems — a spec the user wrote
   and got wrong must be fixed by them, not silently rewritten.
2. If the file is absent and `description` is empty, fail the stage with one
   sentence saying the job needs either a spec file or a description.
3. Otherwise derive. One turn with `forceFinalTool: 'submit_asset_spec'` and a
   read-only toolset (`fs_read_text`, `fs_list_dir`, `code_grep`, `code_glob`)
   so the model can ground itself in the project — an existing content tree tells
   it what assets the game actually needs.
4. `submit_asset_spec` takes `{ style: {...}, entries: [{ kind, title, prompt,
   size?, seamless? }] }`. The model proposes titles and prompts and nothing
   else. **The runner assigns both `id` and `out`** — `out` from
   `defaultOutPath(kind, id)` in phase 05, and ids by this slug rule, stated
   once so the test asserting uniqueness has something to assert against:
   lowercase; every run of non-alphanumeric characters becomes a single `_`;
   leading and trailing `_` trimmed; prefixed with `a_` if the result does not
   start with a letter; truncated to 48 characters; and a collision appends
   `_2`, `_3`, … after truncating far enough to keep the limit —
   exactly as the coding job's decompose stage assigns item ids rather than
   trusting the model. (Phase 11's chained variant differs on one point and only
   one: there the ids come from the plan, because the plan already named the
   content. That stage's tool takes an explicit `id` per entry; this one does
   not, and neither accepts `out`.)
5. Apply defaults the model should not have to think about, all of them named
   constants rather than judgement calls: `normalize` is
   `NormalizeProfile::default()`
   from phase 04 with `target_size` set from the job's `target_size` config;
   `anchor` is `{ image: DEFAULT_ANCHOR_IMAGE, recipe: DEFAULT_ANCHOR_RECIPE }`
   — phase 08 reads those paths, so this stage must populate them; `seamless`
   is true for `kind: 'texture'`; `style.model` and `style.loras` are left
   unset, meaning "whatever the backend is configured with", since a derivation
   has no basis for pinning either.
6. Validate the derived spec. On failure, retry the turn once with the problems
   quoted, then fail the stage — the same bounded-retry shape `ensureWritten`
   uses in the other pipelines.
7. Write the spec to the configured path with `renderAssetSpec`.
8. This stage asks nothing, in either run mode. `ask_user_question` is not in
   its allowlist at all. The overview commits to the style anchor being the only
   checkpoint, and phase 08 presents the spec summary alongside the anchor so
   both questions — what is about to be made, and what it will look like — are
   answered in one place.
9. The stage's output names the spec path, the entry count and a breakdown by
   kind, so the run view tells the user what is about to be generated.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Existing valid spec: loaded, not rewritten (assert the file bytes are
  unchanged), entry count reported.
- Existing invalid spec: run fails, the validation problems appear in the error,
  and the file is not overwritten.
- No spec, no description: the run fails with the one-sentence message.
- Derivation: a mocked turn returns three entries; ids are assigned by the
  runner and are unique even when two titles slugify identically; `out` paths do
  not collide; a `texture` entry comes out `seamless: true`.
- Derivation producing an invalid spec retries once with the problems quoted,
  then fails.
- Neither run mode puts `ask_user_question` in this stage's allowlist, asserted
  for both, since a second checkpoint here would contradict the overview.
- The derived spec carries `anchor.image` and `anchor.recipe` at their default
  paths — the field phase 08 reads and the one most easily forgotten.
- The phase-06 runner test for a missing spec is updated to expect a failed run
  when `description` is also empty, and still expects success when a spec
  exists.

## Commit

```
feat(jobs): load or derive the asset spec
```

## Rollback

Revert the `SPEC` stage body to the skeleton and delete `prompts.ts`,
`tools.ts`, `derive.ts`. A job configured with an existing spec file keeps
working, since that path is the skeleton's behaviour too.
