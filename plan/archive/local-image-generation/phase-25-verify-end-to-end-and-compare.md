# Phase 25 — Verify end to end, and compare against the procedural baseline

**Depends on:** 21–24 · **Enables:** nothing — the last phase.

## Goal

Finish what phase 15 left undone, against the pipeline as it now stands, and
answer phase 16 step 4's question in writing: are the generated assets better
than the procedural ones an autonomous coding run already makes?

## What carries over from phase 15, unchanged

Steps 3–8 of phase 15 still apply as written: Windows and macOS verification,
the failure paths (wrong URL, no model, missing binary, backend stopped
mid-run, disk full, cancel with requests in flight), packaged builds that
start nothing at boot, and the documentation. Do them here, against the new
pipeline, rather than twice. Step 6's coherence judgement is replaced by
step 3 below; its rule stays — remedies found here are **data, not
capability**.

## Steps

1. **The full chain, for real.** Guided planning → assets → coding on a fresh
   project, chained, unattended. Phase 11 has never run for real (`TODO.md`).
   Record: does it ask anything, does the coding run find its assets, what
   does the morning's report say.
2. **The re-run criterion.** Delete ten outputs from a finished set and
   re-run. The ten come back as one smaller sheet (phase 21 step 7) kept
   consistent by phase 22's mechanism. Judge them side by side with their
   neighbours. This is still the claim most likely to rot, so it runs on both
   backends.
3. **The procedural comparison.** The same small set — the `asset-smoke`
   entries plus eight top-down sprites from `asset-test` — made three ways:
   this pipeline on Ming, this pipeline on SDXL's last committed output (for
   the record, not rerun), and a coding run's procedural painter. One contact
   sheet each, at 64 px and 32 px. Write down which is better and why,
   including "the procedural ones", in `measurements-phase-25.md`. This decides
   how much further the feature is worth pushing.
4. **Update the docs for the pivot.** `docs/image-generation.md`: the model
   choice and its licence line, sheets, the transparent start in one sentence
   for anyone reading a workflow, and the non-commercial Qwen option. CLAUDE.md:
   the tech stack line and the image-models line still say SD1.5/SDXL.
5. **Retire the old plan's claims.** The overview's "three independent layers"
   goal and its IP-Adapter decisions are marked superseded where they stand
   (done in the revision), and `TODO.md` is rewritten to the state this phase
   leaves.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && ./scripts/export-ipc-types.sh   # must report no drift
npm run build && npm run tauri build     # the packaged app, on each platform
```

## Test plan

- The live end-to-end suite once per backend by hand, results recorded.
- The chain's no-question assertion against the real three-job chain.
- The comparison in step 3, recorded either way.

## Commit

```
chore(image): verify the sheet pipeline end to end and record the comparison
```

## Rollback

Tests, documents and targeted fixes, each revertable alone.
