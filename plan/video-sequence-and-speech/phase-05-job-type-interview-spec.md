# Phase 05 — The Video sequence job: editor, interview and spec stage

**Depends on:** 04 (spec types, validator, plan, estimate) · **Enables:** 06–09
(the later stages plug into this pipeline)

## Goal

Add the `video_sequence` job type with its editor, availability gate, an
optional interview, and a spec stage in which the model writes the spec
through a forced tool call that the runner validates and writes to
`<episode>/sequence.json`. In Attended mode it stops to show the spec and the
run estimate. Later stages are listed but report "not built yet" until their
phases land, so this phase ships a working "brief → reviewed spec" job.

## Files touched

- `src/lib/stores/jobs.svelte.ts` — add `'video_sequence'` to `JobType`.
- `src/lib/agent/jobs/types/video-sequence/definition.ts` —
  `videoSequenceJobType`: label "Video sequence", `hasPlannedSteps: false`,
  `supportsSchedule: false`, stages `SEQUENCE_STAGES` (Interview, Spec,
  Keyframes, Generate, Check, Sound, Assemble, Render, Report); `available()`
  requires video tools on (`videoToolsOn`) and `videoGenBackendKind !==
  'none'`, with the reason shown when not.
- `.../video-sequence/config.ts` — `VideoSequenceConfig { episode_dir, brief,
  run_mode: 'attended'|'unattended', video_instance_id, image_keyframes:
  boolean, vision_checks: boolean, reanchor_every, editor, }` with
  `configDefaults`, `configFromJob`, `configToJson`, `validate`,
  `missingRequired`. Plain JSON only. `reanchor_every` here is the default
  the spec turn writes into `sequence.json`; the spec's value wins.
- `.../video-sequence/Editor.svelte` — the form: episode folder (relative to
  the job's working folder, picker), brief (textarea), run mode, video
  instance (from Settings → Video generation's server), keyframes from the
  image backend (shown only with one), vision checks (shown only when the
  job's model has vision), re-anchor every N, editor (Shotcut/Kdenlive).
- `.../video-sequence/prompts.ts` — interview and spec prompts.
- `.../video-sequence/tools.ts` — `SUBMIT_SEQUENCE_SPEC_TOOL =
  'submit_sequence_spec'` (category `'planning'`, schema mirrors
  `SequenceSpec`), and `specFromSubmission`.
- `.../video-sequence/pipeline.ts` — `runVideoSequencePipeline(ctx)`, with
  `startStep`/`finishStep` helpers as in `asset-generation/pipeline.ts`.
- `.../video-sequence/context.ts` — `buildSpecContext`: the episode folder's
  clips (via `video_probe`), image files, instance limits and capabilities,
  which backends are on.
- `src/lib/agent/jobs/types/index.ts` — register the type (after Asset
  generation).
- Tests: `config.test.ts`, `tools.test.ts`, `pipeline.test.ts` (with a fake
  `JobRunContext`).
- `docs/guide/job-types.md` — a **Video sequence** entry (one paragraph; the
  detail goes on a new page in phase 09).

## Steps

1. Add the type id, definition, config and editor. The episode folder must be
   inside the job's working folder (the same confinement the video tools use).
2. Context: `buildSpecContext` lists clips and images in the episode folder
   and one level of subfolders, with each clip's length, size and whether it
   has sound; and the instance's limits (size, fps, longest clip, start/end
   image, sound).
3. Interview stage (skipped in Unattended unless step 4's first attempt fails
   validation with an error the brief cannot settle):
   - Run one job turn with `toolAllowlist: [ask_user_question]` and the
     interview prompt: ask, one question at a time, only what the brief leaves
     open — total and per-section length, the join kinds, sound (clip sound,
     music style per section, narration text), start images, existing clips to
     mix in and where. "proceed" ends it.
   - Collect the Q&A as text for the spec turn.
4. Spec stage:
   - If `<episode>/sequence.json` exists, parse and validate it, and skip the
     derive turn.
   - Else run a derive turn with `forceFinalTool: SUBMIT_SEQUENCE_SPEC_TOOL`,
     the brief, the interview answers and the context. Capture the arguments
     in `onToolStart`, then `parseSequenceSpec` → `validateSequenceSpec`. On
     errors, give them back in a retry turn, up to 3 attempts (as
     `MAX_DERIVE_ATTEMPTS` in asset generation).
   - Write `sequence.json` (pretty JSON) with `writeWorkdirFile`.
5. Attended checkpoint: `askUserQuestion` with the spec summary (sections,
   joins, sound, clip count, the estimate ("unknown until the first clip"), notes) and options **Approve**,
   **Change it** (free text → a revise turn → validate → ask again), **Edit
   the file** (opens `sequence.json` in an editor window; on answer, re-read
   and validate), **Stop**.
6. Later stages: each logs "Not built yet" and the run ends `succeeded` after
   Spec, until phases 06–09 replace them.
7. Guide entry in `job-types.md`.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test`.
The Guide check needs the `job-types.md` change in the same PR.

## Test plan

- Unit: config round trip; `available()` false without video tools or video
  generation, with the reason; `specFromSubmission` on a valid and an invalid
  submission.
- Pipeline (fake context): Unattended with a full brief runs no interview and
  writes the spec; a first invalid spec is retried with the errors; an
  existing `sequence.json` skips the derive turn; Attended asks the
  checkpoint and **Stop** ends the run cancelled.
- Hand: the fox brief, Attended, on a remote model and on the 9B local model;
  the interview asks about the join and the sound; the spec it writes has two
  sections and validates.

## Commit

`feat(jobs): Video sequence job — interview and a validated spec`

## Rollback

Revert the commit. Existing jobs of this type would fail to load their type;
delete them first (none exist outside testing at this point).
