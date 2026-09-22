# Phase 16 — Anchor composition, seed honesty, and a quality baseline

**Depends on:** 10 (the gate, so a quality change can be measured rather than
admired) · **Enables:** nothing — this is follow-up work deferred from the
first real end-to-end runs.

## Why this phase exists

Phases 05–11 were verified against a stubbed backend. Running them against real
ComfyUI produced assets, and produced three findings that are quality or
honesty problems rather than bugs — each was deliberately pinned at the time to
keep the end-to-end work moving. They are written down here so the reasoning
and the measurements survive.

Everything below was observed on SD1.5 (`v1-5-pruned-emaonly-fp16`) at
`target_size: 32`, `upscale: 16`, against a four-entry spec (two sprites, one
icon, one texture). The final run of that spec produced three of four assets;
the coin and the cobblestone were judged decent by eye, the sword was not.

## Goal

Make the style anchor teach the model what ONE asset looks like, stop the
recipe claiming a reproducibility it does not have, and establish whether any
of this beats the procedural tiles a coding run already generates.

## Files touched

- `src/lib/agent/jobs/types/asset-generation/anchor.ts` — `anchorPrompt`.
- `src/lib/image/comfyui/backend.ts` (or `client.ts`) — resolve a real seed
  when the request carries none.
- `src/lib/image/types.ts` — the `ImageRequest.seed` contract.
- `src/lib/agent/jobs/types/asset-generation/report.ts` — nothing structural;
  the seed column becomes meaningful once the backend reports one.
- `plan/local-image-generation/` — record the comparisons in steps 3 and 4.
- Tests for each.

Step 3 comes first in practice: if a better base model fixes the silhouettes,
most of step 1 is unnecessary and `anchor.ts` may not need touching at all.

## Steps

### 1. The anchor shows a few large sprites, not dozens of tiny ones

The anchor prompt asks for "a sprite sheet of separate game sprites", and
SD1.5 obliges by filling a 1024px canvas with **dozens of sprites roughly 24px
across**. The style information IP-Adapter then transfers is "many small
cluttered figures" — it never shows the model what a single subject looks like
rendered large. That is the most likely cause of the quality ceiling observed:
a gold coin (round, simple, forgiving silhouette) came out well, an iron sword
(needs a readable silhouette) did not.

Each asset is generated at `target_size * upscale` = 512px and then cropped and
downscaled to 32px, so the reference ought to demonstrate the style at
something near that scale, not at 24px.

Rewrite the prompt to ask for a small number of LARGE subjects — three or four,
each occupying a meaningful fraction of the frame — while keeping the four
rules phase 08 and the first real runs paid for:

1. the style goes first, because whatever opens the prompt decides the medium;
2. never say "reference sheet" or "2x2 grid", which produce floor plans;
3. never name ground or terrain as a subject, which fills the background;
4. name the background colour in words, never in hex.

Note that rule 2's replacement — "sprite sheet" — is itself the phrasing that
causes the clutter, so the wording that replaces it must be checked against
rule 2 not to reintroduce the floor plan. This is the delicate part of the
phase and the reason it is a phase rather than a one-line change.

Measure the result rather than asserting it: generate anchors at a fixed seed
under the old and new prompts, and compare (a) the number and size of distinct
subjects, (b) the resulting `palette_distance` of the same four assets, and
(c) whether a human can tell what each asset is. (c) is the criterion that
matters and the only one no test can check.

### 2. `seed: null` must mean a real seed, not the template's default

`ImageRequest.seed` is documented as "null = let the backend choose; the
resolved value comes back in meta". The ComfyUI backend does not choose: an
absent value leaves the template's own default in place, which is **0**. So
every first attempt of every entry runs at seed 0, and `ImageResultMeta.seed`
reports 0 as though something had picked it.

Two consequences, both visible in a real report: `coin_icon` and `cobblestone`
both recorded "Seed 0", and the anchor recipe — whose entire purpose is to
explain why a later run stopped matching — records a seed nobody chose.

Resolve a random seed in the backend when the request carries none, apply it,
and report it. The recipe then means what it says, and a re-run of a failed
entry genuinely differs from the first attempt rather than repeating it.

Care is needed not to break determinism where it is wanted: an entry that pins
`seed` in the spec must still be reproducible, and the anchor reuse path must
not start regenerating because a seed changed.

### 3. Try a better base model before redesigning the anchor further

SD1.5 is weak at following composition instructions, and every failure in this
phase is a composition failure: a subject that fills the frame instead of
sitting small in it, a sheet of dozens of sprites instead of a few, a silhouette
that does not read. Phase 14's catalogue already records the reason to expect
better — SDXL is "markedly better at following composition instructions, which
is a precondition of background removal rather than a matter of taste".

SDXL is the cheapest thing to try, since it is UNet-based and therefore keeps
both coherence layers this pipeline depends on: IP-Adapter conditioning and
circular-padding seamless tiling. A DiT model (Flux, Qwen, Z-Image) loses both
and would have to be evaluated against a degraded pipeline, which confounds the
comparison.

`native_edge` matters here and is easy to get wrong: SDXL produces artefacts
below 1024, so a 32px target wants `upscale: 32`, not the 16 that suits SD1.5.
Comparing the two at the same generation edge measures the wrong thing.

**This has now been run, and the answer is yes for sprites and no for
textures.** Same prompts, same seeds, SDXL at 1024 against SD1.5 at 512,
measured through the real pipeline with a 32-colour palette from an SDXL
anchor:

| Asset | SD1.5 | SDXL |
| --- | --- | --- |
| iron sword | 3 attempts, silhouette unreadable | **PASS**, alpha 0.186, pal 0.093 |
| health potion | failed all 3 attempts, produced nothing | **PASS**, alpha 0.245, pal 0.038 |
| gold coin | passed, looked decent | fails AlphaHigh — filled the frame |
| cobblestone | passed, looked decent | fails Entropy at 0.00 — see below |

The anchor is the clearest difference: SD1.5 produced dozens of sprites about
24px across, SDXL produced fourteen at roughly 200px, each a clean, readable
pixel-art object with a bold outline on a flat backdrop. That is the reference
IP-Adapter should have been transferring all along, and it strongly suggests
step 1's prompt rewrite is treating a symptom of a weak base model.

Three new findings came out of the same run, and each is a real piece of work
rather than a tuning knob:

**Textures need a feature scale, and SDXL makes this worse.** The cobblestone
came back as hundreds of tiny tiles across 1024px. Downscaled to 32px each
stone is under a pixel, they average together, and the result is a flat grey
field — entropy 0.00, which the gate correctly rejects as mush. SD1.5 passed
the same prompt only because it produced coarser features by accident. A
texture prompt has to say how many features should span the tile ("large
stones, five or six across"), because the generation edge and the target size
together decide whether any detail survives. This is the mirror of the sprite
problem: sprites want ONE large subject, textures want FEW large features.

**Naming the key colour can put it inside the subject.** The isolation
scaffold says "magenta" three times, and SDXL rendered a magenta symbol on the
face of the gold coin. Global chroma keying then punches a hole through the
middle of the asset. This is in direct tension with the fix that made entry
prompts name the colour in words at all — a hex string produced no background,
and a colour word produces a background the model may also use as a design
colour. The principled repair is not in the prompt: key only regions CONNECTED
to the border, by flood fill, rather than every matching pixel globally. Then
a magenta detail enclosed by the subject survives and a magenta backdrop does
not. `normalize.rs::chroma_key` is global today.

**Isolation is still not guaranteed.** The coin filled the frame despite
"small in frame, centred, lots of empty space around it". Better prompt
adherence raises the hit rate; it does not make the scaffold reliable, so the
retry path that phase 10 fixed remains load-bearing.

Taken together: SDXL is the better base for sprites and icons by a wide
margin, and switching to it does not remove the need for steps 1 and 2 so much
as re-aim them. Phase 14's catalogue should recommend it where VRAM allows,
which it already does at ≥10 GB.

### 4. Compare against the procedural baseline, and write the answer down

A previous autonomous coding run produced tilemaps procedurally, in code, with
no diffusion model at all. On the evidence so far those may look *better* than
the generated assets. That is worth knowing plainly, because it decides how
much further this feature is worth pushing.

Generate the same small set both ways, put them side by side, and record the
judgement in this folder — including "the procedural ones are better", if that
is the answer. The overview's success criterion is "a contact sheet of the set
reads as one game", and a baseline that already meets it is the honest thing to
measure against.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- The anchor prompt still obeys all four rules from phase 08 and the first real
  runs: style first, no sheet/grid language, no ground among the subjects, the
  background named in words. These already have tests; they must keep passing
  against the rewritten prompt.
- The new prompt asks for a bounded, small number of subjects, and the test
  says what that number is rather than leaving it to the prompt's prose.
- A request with `seed: null` reaches the backend with a concrete seed, and the
  same value comes back in `meta.seed`. Verify it has teeth by removing the
  resolution and watching the assertion fail.
- Two requests with `seed: null` get DIFFERENT seeds — the property that makes
  a retry a retry.
- A request that pins a seed is unchanged by the resolution, and its `meta`
  echoes the pinned value.
- Anchor reuse still reuses: a run whose spec and recipe are unchanged makes no
  backend call, regardless of seed handling.
- The measurements from steps 1 and 3 recorded in this folder, including the
  numbers that made the case, so a later reader can tell a measured decision
  from a preference.

## Commit

```
fix(assets): teach the anchor one subject at a time, and resolve real seeds
```

## Rollback

The prompt change is one function and revertable alone; the committed anchors
of existing projects are unaffected, since reuse reads the image rather than
regenerating from the prompt. The seed change is revertable alone too, at the
cost of returning to seed 0. The comparison in step 3 is a document and has
nothing to roll back.
