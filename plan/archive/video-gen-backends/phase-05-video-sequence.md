# Phase 05 — Video-sequence jobs on video model entries

**Depends on:** 01, 02, 03, 04 · **Enables:** 10 (the guide describes the new selects)

## Goal

A video-sequence job uses one entry for its clips and one for its speaking
clips. "Automatic" (the default for both) picks by the job's needs. A job saved
with a toolchest instance id opens with the matching entry.

## Files touched

- `src/lib/agent/jobs/types/video-sequence/config.ts` — `video_model_id`, `speaking_model_id`; reads old ids.
- `src/lib/agent/jobs/types/video-sequence/context.ts` — `SpecContext` and
  `ValidateContext` hold an entry and its `VideoCaps`, not a `ToolchestInstance`.
- `src/lib/agent/jobs/types/video-sequence/pick.ts` (new) — the Automatic choice.
- `src/lib/agent/jobs/types/video-sequence/generateStage.ts` — generate and resume through the entry's backend.
- `src/lib/agent/jobs/types/video-sequence/generate.ts` — `GenerateDeps` typed on the new handle.
- `src/lib/agent/jobs/types/video-sequence/speechStage.ts` — `VideoCaps`.
- `src/lib/agent/jobs/types/video-sequence/Editor.svelte` — the two selects.
- `src/lib/sequence/spec/validate.ts` — capability checks on `VideoCaps` fields.
- `src/lib/sequence/spec/progress.ts` — the saved handle type.
- `src/lib/videogen/types.ts`, `src/lib/videogen/toolchest/backend.ts` — drop `instanceId`.
- `src/lib/videogen/toolchest.ts` — delete the last single-instance helpers.
- Tests: `config.test.ts`, `pipeline.test.ts`, `generate.test.ts`,
  `definition.test.ts`, `pick.test.ts` (new), validate tests.

## Steps

1. `config.ts`: replace `video_instance_id` and `speaking_instance_id` with
   `video_model_id` and `speaking_model_id` (entry ids). `''` means Automatic;
   `speaking_model_id: 'none'` means no speaking model. `parseConfig` reads an
   old `video_instance_id` and maps it to the first entry whose backend is
   `llama-toolchest` and whose `model` equals it; with no match it keeps the
   id as `video_model_id` so the Editor shows it as missing (as it does today).
   The same for `speaking_instance_id`. `configToJson` writes only the new keys.
2. `pick.ts`:
   - `pickVideoEntry(cfg, signal)`: a named id → that entry, readied
     (probe + caps). Automatic runs before any plan exists, because the picked
     entry's limits shape the plan, so it reads no needs from the plan: it takes
     the first entry, in Settings order, that answers and has `text` or
     `startImage` and not `needsSpeech`, preferring one that also has `endImage`
     (the planner chains clips on end frames only when the model can). Sound is
     not a need for a job.
   - `pickSpeakingEntry(cfg, signal)`: `'none'` → null; a named id → that entry;
     Automatic → the first entry with `caps.speech`, or null.
   - Both go through entries in Settings order and probe each one whose caps
     are unknown (saving its caps), as `routeVideo` does; an entry that doesn't
     answer is skipped.
   - No entry qualifies (every entry is down, or the only ones need speech):
     the pick throws, and preflight fails with "No video model in Settings →
     Video generation can make a clip from a prompt or a picture." followed by
     each entry's reason, as `routeVideo` lists them.
   - After the plan is made: with a named entry, `validate.ts` refuses a clip
     that entry can't make, as it does today. With Automatic, `validate.ts` does
     not refuse such a clip; it adds the note "No one video model can do every
     clip, so some clips use another." to the plan once. Nothing is stored per
     clip: at generate time (step 5) each clip is checked again.
3. `context.ts`: `buildSpecContext` calls the two pickers; `SpecContext` holds
   `{ video: { entry, caps }, speaking: { entry, caps } | null, note? }`.
   `instanceText` and `ValidateContext` read `caps.limits` and the caps flags.
4. `validate.ts`: replace the capability-string checks (`'audio'`, `'start_image'`,
   `'end_image'`) with `caps.speech`, `caps.startImage`, `caps.endImage`.
5. `generateStage.ts`: `generate` calls
   `videoBackendForEntry(req.audio ? speaking.entry : video.entry).generate(req, opts)`,
   except that, with Automatic, a clip whose need (`needOf` from
   `#lib/videogen/route.ts`) the picked entry's caps don't meet goes through
   `routeVideo` instead. This check runs again on resume, so nothing extra is saved. `resume` uses `videoEntryForHandle(handle)`. A progress file saved
   before this phase holds an old handle, which `videoEntryForHandle` accepts.
6. `Editor.svelte`: "Video model" lists "Automatic" then each entry by name;
   "Speaking model" lists "Automatic", "None", then each entry whose caps have
   `speech` (or whose caps are unknown). A saved id missing from the list shows
   as its own option, as today. Copy: one sentence per select; the detail
   ("Its longest clip decides how many clips a section takes.") moves to the
   `title` tooltip.
7. Remove `instanceId` from `VideoGenerateOptions` and from the toolchest
   backend: the job now names entries, so nothing passes it.
8. Delete `generateVideo`, `resumeVideo`, `listVideoInstances`, `probeVideo`,
   `readyVideoInstance`, `chosenVideoInstanceId` and `seenVideoInstances` from
   `src/lib/videogen/toolchest.ts`. Settings stopped calling them in phase 04,
   and the job stops in steps 3, 5 and 6. `grep -rn` for each name finds no caller.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan

- `config.test.ts`: an old config with `video_instance_id: 'ltx-2.3'` and a
  matching entry parses to that entry's id; with no match it keeps the id;
  `configToJson` writes no old keys.
- `pick.test.ts`: Automatic prefers the first entry with end images over an
  earlier one without; an entry that only does speech is never picked; no
  qualifying entry throws with each entry's reason; the speaking pick skips non-speech entries; an unreachable first entry
  is skipped.
- validate tests: with Automatic, a start-image clip on a text-only pick is kept
  and the note is added; with a named entry it is refused.
- `pipeline.test.ts` and `generate.test.ts`: a job resumes from a progress file
  with an old handle.
- By hand: a sequence on Automatic with LTX and S2V entries, the speaking clips on S2V.

## Commit

`feat(video-sequence): pick the job's video models from Settings → Video generation`

## Rollback

Revert the commit. Configs saved by this phase use the new keys, which the old
parser ignores, so those jobs fall back to the Settings default model.
