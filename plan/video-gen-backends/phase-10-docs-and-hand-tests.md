# Phase 10 — User guide, showcase and the hand-test issue

**Depends on:** 03, 04, 05, 07, 08, 09 · **Enables:** the PR can merge

## Goal

The user guide and the showcase describe the app as it is after phases 01–09,
and the hand tests the automated suite can't cover are filed in one issue.

## Files touched

- `docs/guide/video-generation.md` — the list, routing, ComfyUI, Install.
- `docs/guide/video-sequence.md` — the two selects and Automatic.
- `docs/showcase/video.md` — a card for a clip made on ComfyUI, and the
  cards that name "Settings → Video generation" updated to the list.
- PR body — names both guide pages.

## Steps

1. `video-generation.md` (under 6 KB), sections whose headings say what the
   user wants to do:
   - "Add a video model": Settings → Video generation → Add model; ComfyUI or
     llama-toolchest; Settings → Inference → API Keys for a key.
   - "Install a model into ComfyUI": the four families, with licence and
     commercial use, and that direct download works only on a local server.
   - "Choose which model makes a clip": first in the list that can do it; an
     unreachable one is skipped; ask for a model by name in chat.
   - "What each model can do": start image, end image, speech, sound, per family.
   - What it doesn't do: the bundled engine makes no video; no custom ComfyUI
     video workflows; a refused clip is not retried on another model.
2. `video-sequence.md`: "Video model" and "Speaking model", what Automatic picks,
   and the note when no one model can do every clip.
3. `docs/showcase/video.md`: add one card (format at the top of
   `scripts/build-showcase.mjs`): a Wan 2.2 clip from a picture on ComfyUI.
   Run `node scripts/build-showcase.mjs` to check it.
4. Run `node scripts/guide-check.mjs` locally.
5. `gh issue create` "Video model list: hand tests" with a checklist of every
   "By hand" item in phases 04, 05, 07, 08 and 09, grouped by phase, and link it
   from the PR body. Add the ComfyUI live runs to issue #745 (Hand tests owed)
   only if this PR merges with them unticked.

## Build gate

`node scripts/guide-check.mjs`, `node scripts/build-showcase.mjs`,
`npm run format:check`, and the guide page test (`src/lib/guide/pages.test.ts`)
in `npm run test`.

## Test plan

- In the app, ask "how do I make a video with ComfyUI?"; the model reads the
  `video-generation` page through `haruspex_docs` and answers with the right Settings path.
- `wc -c docs/guide/video-generation.md docs/guide/video-sequence.md` is under 6144 each.

## Commit

`docs: video models list, ComfyUI video and install`

## Rollback

Revert the commit. The docs then describe the single-model setting again, so
revert it only together with the feature phases.
