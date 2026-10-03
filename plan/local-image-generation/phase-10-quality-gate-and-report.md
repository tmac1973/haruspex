# Phase 10 — Quality gate, bounded retries, and the report

**Depends on:** 09 · **Enables:** 11 — the chain can only be trusted once a run
cannot quietly ship a hundred blank PNGs.

## Goal

Check every artifact before accepting it. Cheap deterministic checks run first;
an optional vision-model judge runs second when the job's model supports images.
A failure retries within a budget, and an entry that never passes is recorded as
unresolved rather than written as if it succeeded. The stage ends with a report
that says plainly what was made, what was degraded, and what could not be made.

This phase exists because of a bug found the hard way in the coding pipeline: a
stage that trusts its producer reports success for work that never happened.

## Files touched

- `src-tauri/src/image_gen/checks.rs` — new. `evaluate(stats, profile, kind)` →
  `CheckReport { passed: bool, stats: ImageStats, failed: Vec<CheckName> }`,
  where `CheckName` is `AlphaLow | AlphaHigh | Entropy | PaletteDistance` — one
  variant per row of step 4's retry table, named for the failure rather than the
  statistic so alpha below and above range stay distinguishable. It
  is **pure**: it takes the `ImageStats` phase 04's `image_normalize` already
  returned and compares them to the thresholds already on `NormalizeProfile`.
  It never re-opens the image, because `palette_distance` is only knowable
  before quantization and no longer exists in the normalized output.
- `src/lib/assets/contactSheet.ts` + `src-tauri/src/image_gen/sheet.rs` — new.
  `image_contact_sheet(paths, cell)` tiles the run's produced assets into one
  PNG, `cell` being `target_size * 4` so a 32 px asset is legible at a glance. The overview makes "a contact sheet of the set reads as one game" a
  success criterion and phase 15 judges one; nothing produced it until now.
- `src-tauri/src/image_gen/commands.rs` — add `image_check` and
  `image_contact_sheet`.
- `src-tauri/src/lib.rs` — register it.
- `src/lib/agent/jobs/types/asset-generation/gate.ts` — new. Mechanical checks
  plus the optional judge, and the retry policy.
- `src/lib/agent/jobs/types/asset-generation/prompts.ts` — add
  `judgePrompt(entry, spec)`.
- `src/lib/agent/jobs/types/asset-generation/tools.ts` — add
  `submit_asset_judgement`, the judge's forced tool, defined here the way
  `submit_asset_spec` is defined in phase 07.
- `src/lib/agent/jobs/types/asset-generation/report.ts` — new.
- `src/lib/agent/jobs/types/asset-generation/pipeline.ts` — wire the gate into
  `GENERATE`, implement `REPORT`.
- Tests for each.

## Steps

1. Mechanical checks, in Rust, over the `ImageStats` normalization produced,
   each against the effective profile's `checks` block from phase 04:
   - `alpha_coverage` within `[alpha_min, alpha_max]` — defaults 0.05 and 0.95,
     catching a blank canvas (nothing opaque) and a failed key (everything
     opaque). The `texture` override raises them to 0.999 and 1.0, since a
     tiling texture is fully opaque.
   - `entropy` at or above `entropy_min`, default 2.0 bits per pixel over the
     quantized palette — catches flat grey mush, the most common bad
     generation.
   - `palette_distance` at or below `palette_distance_max`, default 0.15: the
     fraction of pixels further than ΔRGB 48 from their palette entry *before*
     snapping. High distance means the generation was off-style and
     quantization papered over it, which is exactly the failure a palette-only
     design hides.
2. Every threshold is a `NormalizeProfile` field with the default above, so a
   user with an unusual style loosens it in the spec without editing code — and
   no new schema is introduced here. These defaults are shipped values, not
   provisional ones; phase 15 may tune them on evidence, which is ordinary, but
   a run today uses exactly these.
3. The vision judge, when `config.vision_judge` is on **and**
   `ctx.visionSupported()` is true — the flag the job runner already threads
   into every turn, so no new capability query is invented: one turn, given the
   normalized image and the anchor sheet, asked whether this is recognisably
   the entry's subject and in the anchor's style, returning `{ ok: boolean,
   reason: string }` through the forced `submit_asset_judgement` tool. With no vision support, skip it and
   say so **once** in the report — never fail an entry for a capability the
   user does not have.
4. Retry policy: a failed check re-generates with a new seed, up to
   `config.max_attempts`. The next attempt's negative prompt is amended from a
   fixed table, so the mapping is code rather than judgement:
   `alpha` below range → append `'blank, empty, transparent'`;
   `alpha` above range → append `'flat background, no subject isolation'`;
   `entropy` → append `'featureless, flat, low detail'`;
   `palette_distance` → re-append `spec.style.prompt` and add
   `'limited palette'`. A judge rejection appends nothing; its reason is prose
   and is recorded, not injected.
5. An entry exhausting its attempts is recorded `unresolved` with the last
   reason and its **best** `CheckReport` — best meaning fewest entries in
   `failed`, ties broken by lower `palette_distance`. **Nothing is written to
   its output path** — a half-good PNG on disk would be skipped by the next
   run's skip-existing rule and never retried.
6. `REPORT` assembles a contact sheet of everything the run produced via
   `image_contact_sheet`, writes it beside the spec as `contact-sheet.png`, and
   writes `REPORT-assets.md` in the same directory phase 06 established:
   totals; the contact sheet embedded; a table rendered from phase 09's
   `EntryOutcome` records — outcome, attempts, seed, duration, degradation; an "Unresolved" section naming each failure
   and its reason; a "Degraded" section naming the coherence layer each
   affected entry did without; and the anchor's provenance read from phase 08's
   `AnchorOutcome` rather than scraped from prose.
7. The run finishes `succeeded` even with unresolved entries — the work that
   was done is real — but the stage output leads with the unresolved count so
   it is the first thing the user sees.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

## Test plan

- Rust, fixture-driven, end to end through `image_normalize` so the stats are
  real: a fully transparent PNG fails alpha coverage; a fully opaque sprite
  fails the upper bound; a flat grey image fails entropy; an in-style fixture
  passes all three; a deliberately off-palette fixture fails palette distance.
  Each threshold gets a just-inside and just-outside case.
- `evaluate` is pure — called twice with the same stats it returns the same
  report, and it never touches the filesystem.
- `image_contact_sheet` tiles N assets into one image of the expected
  dimensions, and handles N not being a perfect square.
- Gate: a failing check triggers a retry with a different seed; passing on
  attempt two records `attempts: 2`; exhausting attempts marks the entry
  unresolved **and writes no file** — asserted by checking the path does not
  exist, because this is the rule that keeps a bad asset from being permanently
  skipped.
- Judge: runs only when enabled and the model reports vision; a `{ ok: false }`
  verdict triggers a retry; with no vision support the judge is skipped and the
  report says so once, not once per entry.
- Report: contains every section and embeds the contact sheet; unresolved
  entries appear with reasons; degraded entries name their missing layer; the
  anchor provenance line is rendered from `AnchorOutcome` and distinguishes
  reused from generated and approved from auto-accepted.
- A run where every entry fails still finishes `succeeded` with a report, and
  the stage output leads with the unresolved count.

## Commit

```
feat(jobs): check every generated asset before accepting it, and report honestly
```

## Rollback

Delete `gate.ts` and `checks.rs`, drop the `image_check` registration, re-run
`./scripts/export-ipc-types.sh`, and have `GENERATE` accept results directly
again. The report can stay — it degrades to listing outcomes without check
detail.
