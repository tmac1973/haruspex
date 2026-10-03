# Phase 15 — Cross-platform hardening, docs, and end-to-end verification

**Depends on:** 11 (the chain) and 14 (the local path), so every route through
the feature exists · **Enables:** nothing — this is the last phase.

## Goal

Prove the whole feature against the overview's success criteria, on every
platform, by both routes, and write it down. Nothing new is designed here; this
phase closes gaps, fixes what the end-to-end runs expose, and leaves the
documentation a future reader needs.

## Files touched

- `CLAUDE.md` — Settings → Image, the asset job, the sidecar and port tables,
  and the third model family.
- `docs/image-generation.md` — expanded into the full user-facing guide;
  phase 12 created it to record the pinned sidecar version.
- `src/lib/image/**`, `src/lib/agent/jobs/types/asset-generation/**`,
  `src-tauri/src/image_gen/**`, `src-tauri/src/image_engine.rs` — fixes only.
- `src/lib/agent/jobs/types/asset-generation/endToEnd.test.ts` — new. The
  criteria as tests, with the live parts env-gated.

## Steps

1. Write the success criteria as tests wherever they can be mechanical, and as a
   documented manual checklist where they cannot:
   - a one-line prompt with a ComfyUI backend produces a directory of normalized
     PNGs with no workflow authoring;
   - the same job against the local backend produces the same shape of output;
   - **delete ten outputs, re-run, get ten back in the same style** — the
     sharpest test of the design, since it exercises anchor reuse, skip-existing
     and palette persistence at once;
   - a chained run asks nothing from first stage to last;
   - a forced-bad generation is caught, retried, and reported unresolved with no
     file written;
   - the spec, anchor image and recipe are all committed and reproduce the art
     from a fresh clone.
2. Live end-to-end tests follow the existing convention: `it.skip`-gated behind
   `HARUSPEX_IMAGE_E2E=1` plus `HARUSPEX_IMAGE_BACKEND_URL`, so CI never
   reaches for a model or a server — named here so the gate can actually be
   written and documented, the same way the verifier probe is gated.
3. Windows: verify the sidecar spawn, the shell selection used by any git
   commands, and path handling for spec `out` values that use backslashes. The
   `out`-escape rule gets a Windows-specific test, because a path check that
   passes on Linux and fails on Windows is the classic version of that bug.
4. macOS and Linux: verify the Vulkan backend starts, and that stopping the
   engine releases VRAM.
5. Failure paths, each exercised by hand and each leaving a usable message: the
   backend URL is wrong; the backend is up but has no model; the engine binary
   is missing; **the backend is stopped partway through a long run**, which is
   the overview's stated constraint and the one most easily left untested; the
   disk fills mid-run; the run is cancelled with requests in flight.
6. Look at the contact sheet phase 10's report assembles from the run's own
   output — a real artifact at a known path, not an ad-hoc one — and judge it. If it does not read
   as one game, name the layer that failed — reference conditioning, palette, or
   grid — and record it. The overview's coherence criterion is the one criterion
   a test cannot assert, and pretending otherwise would repeat the mistake this
   plan was written after.
   A failed judgement has a defined remedy, so this is not a finding with
   nowhere to go: the permitted fixes here are **data, not capability** — the
   shipped `NormalizeProfile` defaults (palette size, reference strength, check
   thresholds), the anchor prompt's wording, and the bundled templates'
   sampler settings. Anything larger is recorded as a follow-up with the
   evidence, and this plan ends.
7. Documentation: `docs/image-generation.md` grows from phase 12's version
   note into a guide covering choosing a backend, the
   spec format with a worked example, what the anchor is and why it is
   committed, how to add assets later, what degradation means in a report, and
   the licensing rule. Update CLAUDE.md's tables.
8. Fix what steps 3–6 expose, within the bounds step 6 sets: defaults, copy and
   prompts may change; no new capability, no new config field, no new stage.

## Build gate

```
npm run check && npm run lint && npm run format:check && npm run test
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && ./scripts/export-ipc-types.sh   # must report no drift
npm run build && npm run tauri build     # the packaged app, on each platform
```

## Test plan

- The mechanical criteria above, as automated tests.
- The live end-to-end suite run once per backend by hand, with results recorded.
- The re-run criterion run twice, on both backends, since anchor reuse is the
  claim most likely to rot.
- The chained run's no-question assertion re-run against the full three-job
  chain, not a mocked one.
- A packaged build on each platform launches, shows Settings → Image, and starts
  no image process until asked.
- The coherence judgement in step 6, recorded either way.

## Commit

```
chore(image): harden across platforms, document, and verify end to end
```

## Rollback

Documentation and tests only, plus whatever targeted fixes the verification
produced. Each fix is independently revertable; reverting this phase wholesale
would remove the proof of the feature, not the feature.
