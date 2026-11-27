# Phase 04 — The sequence spec: types, validation, clip plan and estimate

**Depends on:** 01 (the `end_image` capability), 02
(the `Fit` type for existing-clip sections) ·
**Enables:** 05 (the job writes and checks a spec), 06–09 (every stage reads
the clip plan)

## Goal

Define the Video sequence spec as plain data, with a validator that checks it
against the chosen video instance, an expander that turns sections into an
ordered clip plan (continuations, re-anchors, transitions, existing clips),
and a run-time estimate. Pure TypeScript with tests, no UI and no generation,
so the job stages and a later `propose_job` tool can share it.

## Files touched

- `src/lib/sequence/spec/types.ts` — the spec types (below).
- `src/lib/sequence/spec/parse.ts` — `parseSequenceSpec(json) → {spec, problems}`.
- `src/lib/sequence/spec/validate.ts` — `validateSequenceSpec(spec, ctx)`.
- `src/lib/sequence/spec/plan.ts` — `planClips(spec, limits) → ClipPlan`.
- `src/lib/sequence/spec/estimate.ts` — `estimateRun(plan, secsPerClip)`.
- `src/lib/sequence/spec/paths.ts` — `SPEC_FILE = 'sequence.json'`,
  `PROGRESS_FILE = '.haruspex/sequence-progress.json'`,
  `GENERATED_DIR = 'generated'`, `KEYFRAMES_DIR = 'keyframes'`,
  `REPORT_FILE = 'REPORT-sequence.md'`, all relative to the episode folder.
- `src/lib/sequence/spec/progress.ts` — the progress-file type and
  read/merge helpers.
- Tests: `types` has none; `parse.test.ts`, `validate.test.ts`,
  `plan.test.ts`, `estimate.test.ts`, `progress.test.ts`.

## Steps

1. Spec types (`version: 1`):
   - `SequenceSpec { version, title, style, preset?, sections: Section[],
     joins: Join[], sound: Sound, reanchor_every: number }`
     - `style`: one line every prompt and keyframe gets (subject, look, light).
     - `joins.length === sections.length - 1`.
     - `reanchor_every` default 6; 0 turns it off. The job's config value
       (phase 05) is only the default the spec turn writes in; the value in
       `sequence.json` is the one every stage uses.
   - `Section` is one of:
     - `{ kind: 'generated', id, prompt, seconds, start_image?: string,
       keyframe_prompt?: string, negative_prompt?, seed? }` — `start_image` is a
       path in the episode folder the user gave.
     - `{ kind: 'existing', id, path, in_secs?, out_secs?, fit? }`.
   - `Join { kind: 'cut' | 'crossfade' | 'transition', secs?, prompt? }`.
   - `Sound { clip_sound: boolean, music: MusicBed[], narration: Narration[] }`
     - `MusicBed { id, sections: string[], caption, lufs? }` (one bed covers a
       run of sections; `id` is a short slug, unique in the spec).
     - `Narration { section, at_secs, text, voice? }`.
2. `parse.ts`: strict JSON parse, unknown keys reported as problems (not
   dropped silently), defaults filled.
3. `validate.ts`, against `{ limits: VideoLimits, capabilities, imageBackend,
   musicBackend, files: Set<string> }`:
   - every `existing.path` and `start_image` exists in the episode folder;
   - `transition` joins and re-anchoring need `end_image`; without it, a
     transition is downgraded to a 1 s crossfade and re-anchoring to 0, each
     with a note (not an error);
   - a `generated` section with no `start_image` and no image backend is
     text-to-video: allowed only if the instance makes video from text alone,
     else an error naming the section;
   - music needs a music backend; `clip_sound` is not checked here, since
     only a made clip shows whether the set has sound (phase 09 notes clips
     that had none);
   - no length cap; `seconds` > 0.
4. `plan.ts`: for each generated section, split `seconds` into clips of the
   instance's longest clip (`maxFrames` at the chosen size, Wan 4n+1 rule from
   `fitClip`), the last clip shortened to fit. Emit `ClipPlanItem`s in order:
   - `{ id: '<section>-NN', section, prompt, frames, start: StartRef,
     end?: EndRef, trimFirstFrame }`.
   - `StartRef` is `keyframe(section)`, `userImage(path)`,
     `lastFrameOf(prevId)`, or `text`.
   - Every `reanchor_every`-th clip gets `end: reanchor(section, n)`.
   - Continuation clips (`start = lastFrameOf`) get `trimFirstFrame: true`.
   - A `transition` join adds an item `{ id: 'join-K', start:
     lastFrameOf(last clip of A), end: firstFrameOf(B) }`, where B's first
     frame is its keyframe, user image, or an existing clip's first frame.
5. `estimate.ts`: `estimateRun(plan, secsPerClip: number | null)` returns
   `{ clips, minutes: number | null, note }` with music and narration counts.
   Before any clip exists, `secsPerClip` is null and the estimate says
   "unknown until the first clip"; phase 07 calls it again with the first
   clip's measured wall time and shows the result on the Generate step.
   No built-in per-model table.
6. `progress.ts`: `SequenceProgress { specHash, clips: Record<id, { status:
   'pending'|'running'|'done'|'failed', handle?: VideoJobHandle, file?, seed?,
   check?: { ok, problem? } }>, keyframes, music, narration, project?, render? }`.
   `specHash` is a hash of the spec file; a changed spec keeps done clips whose
   `ClipPlanItem` is unchanged and resets the rest.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test`.

## Test plan

- The fox spec (two generated sections of 60 s, one transition, a music bed,
  clip sound) on LTX-2.3 limits gives 12 + 12 clips plus `join-1`, re-anchors
  at clips 6 and 12 of each section, and `trimFirstFrame` on continuations.
- The same spec on an instance without `end_image`: the transition becomes a
  crossfade, re-anchoring 0, two notes.
- An existing-clip section with a missing file is an error naming the path.
- A changed prompt in section 2 keeps section 1's done clips in the progress
  merge and resets section 2's.
- `estimateRun(plan, 260)` for the fox plan gives 25 clips and about
  108 minutes; `estimateRun(plan, null)` gives `minutes: null` and the note.

## Commit

`feat(sequence): spec types, validation, clip plan and run estimate`

## Rollback

Revert the commit; the module is not imported by anything yet.
