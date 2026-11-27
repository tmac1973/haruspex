# Phase 03 — Routing by need, and generate_video on the list

**Depends on:** 01, 02 · **Enables:** 04 (Settings shows the order routing uses), 05 (the job routes the same way)

## Goal

`generate_video` picks the first entry, in Settings order, that can do the
request, or the entry the chat model names with `model`. Everything the tool
checks against a `ToolchestInstance` today checks against `VideoCaps` instead,
so a ComfyUI entry can pass through the same code later. The tool and jobs are
offered when the list is not empty, not when `videoGenBackendKind` is set.

## Files touched

- `src/lib/videogen/route.ts` (new) — `VideoNeed`, `needOf`, `meetsNeed`, `routeVideo`.
- `src/lib/videogen/route.test.ts` (new).
- `src/lib/videogen/fit.ts` — `fitClip` and `maxClipFrames` take `VideoCaps`
  (limits plus `frameStep`); `wanFrames` becomes `stepFrames(n, step)`.
- `src/lib/agent/tools/video-gen.ts` — route, `model` and `sound` arguments, caps-based refusals.
- `src/lib/agent/tools/_videoSpeech.ts` — typed on `VideoCaps`.
- `src/lib/agent/tools/_videoJob.ts` — the task spec carries `entryId`; run and
  resume build the backend from it.
- `src/lib/tasks/followers.ts` — the video follower resumes through `videoEntryForHandle`.
- `src/lib/agent/tools/registry.ts` (lines ~534, ~695, `videoGenOffered`) —
  `videoEntries().length > 0`.
- `src/lib/lean/pausedIntegrations.ts:25` — the same test.
- `src/lib/agent/jobs/types/video-sequence/definition.ts:51-55` (`sequenceAvailable`) and
  `src/lib/agent/jobs/types/video-sequence/pipeline.ts:103-113` (preflight) — the same test.
- `src/lib/stores/settings.ts:431-434` — `seedGenerationServers` reads toolchest video entries.
- Tests: `video-gen.test.ts`, `video-gen.speech.test.ts`, `followers.video.test.ts`,
  `fit` cases, and every test that sets `videoGenBackendKind` to switch video on
  now sets `videoModels`: `src/lib/stores/settings.test.ts`,
  `src/lib/agent/systemPrompt.lean.test.ts`, `src/lib/agent/tools/_leanProfile.test.ts`,
  `_deferred.test.ts`, `_deferred.prompt.test.ts`, `_families.test.ts`,
  `src/lib/lean/pausedIntegrations.test.ts`,
  `src/lib/agent/jobs/types/email-research/prompt.test.ts` (find any others with
  `grep -rln videoGenBackendKind src`).

## Steps

1. `route.ts`, modelled on `src/lib/image/route.ts`:
   - `VideoNeed { text; startImage; endImage; speech; sound }`. `text` is true
     when there is no start image (the clip comes from the prompt alone).
   - `meetsNeed(caps, need)`: each `true` field needs the matching cap; `speech`
     also needs `startImage` (the S2V rule now in `speechRefusal`); a model with
     `needsSpeech` meets a need only when `need.speech` is true.
   - `capableEntries(need)`: known-capable entries in list order, then
     unprobed ones (`caps === null`) in list order.
   - `routeVideo(need, run, { named?, prefer? })`: empty list →
     `'Video generation is not set up. The user can add a video model in Settings → Video generation.'`;
     `named` tries only that entry and, on a miss, names the entries that can;
     `prefer` (a task's entry) goes first. For each candidate: build the backend,
     `probe()`, `capabilities()`, `saveVideoCaps`, check `meetsNeed`, then `run(entry, backend, caps)`.
     `unreachable` and `unconfigured` errors pass to the next entry; any other
     error is thrown as is. The final error:
     - every entry answered and none could do it → one sentence naming what is
       missing (`"None of the video models in Settings → Video generation can end on a picture."`);
     - otherwise (any entry unreachable, alone or mixed with ones that can't) →
       `'No video model could make it: name (host): reason; …'`, one reason per
       entry, either the unreachable error's message or what it can't do
       (`"can't end on a picture"`).
2. `fit.ts`: `fitClip(caps, modelName, { seconds, portrait })` uses
   `caps.limits` and rounds frames to `caps.frameStep * n + 1`. The note text
   names the model, not "instance".
3. `video-gen.ts`:
   - New optional arguments: `model` (enum of `videoEntryNames()` when there are
     two or more entries; omitted from the schema when there is one) and
     `sound` (boolean, "true when the clip must have its own sound track").
   - `execute`: check the arguments as now, build the `VideoNeed` from
     `start_image`, `end_image`, `audio` and `sound`, then call `routeVideo`.
     Inside `run`, the existing picture, speech and fit steps use `caps`, and the
     task starts with `entryId` in its spec.
   - Picture and speech refusals name the model (`entry.name`), not the instance id.
   - The answer text names the model that made the clip (`VideoResult.model` is the entry name).
4. `_videoSpeech.ts`: `speaks(caps) = caps.speech`; `speechRefusal`, `speechTooLong`
   take `VideoCaps`.
5. `_videoJob.ts` / `followers.ts`: `runVideoJob` builds the backend with
   `videoBackendForEntry(videoEntryById(spec.entryId) ?? videoEntryForHandle(handle))`.
   A spec saved before this phase has no `entryId`: use the first entry for a new
   run and `videoEntryForHandle` for a resume.
6. Gate on the list everywhere: `registry.ts`, `pausedIntegrations.ts`,
   `sequenceAvailable` and the job's preflight all test `videoEntries().length > 0`.
   The job still runs on the first entry until phase 05.
7. Keep the delegating functions in `toolchest.ts` (`generateVideo`,
   `resumeVideo`, `listVideoInstances`, `probeVideo`, `readyVideoInstance`,
   `chosenVideoInstanceId`): the tool and follower no longer call them, but the
   video-sequence job (`generateStage.ts`, `context.ts`, `Editor.svelte`) still
   does, with `instanceId`. Phase 05 step 8 deletes them.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan

- `route.test.ts`: a prompt-only request skips an entry without `text`; a
  request without speech skips an S2V entry (`needsSpeech`); LTX first and S2V second → speech goes to S2V, plain goes
  to LTX; first entry unreachable → second runs; first refuses (`rejected`) →
  no retry; `named` hits only that entry; empty list → not set up; unprobed
  entries come after probed capable ones; caps are saved after a probe.
- `video-gen.test.ts`: `model` names an entry; `sound: true` skips a Wan entry;
  a spec without `entryId` still runs.
- `followers.video.test.ts`: an old handle with no `entryId` resumes on its server.

## Commit

`feat(videogen): route each clip to the first video model that can make it`

## Rollback

Revert the commit. Tasks started in this phase carry `entryId` in their spec;
the older follower ignores the extra field and resumes by the handle's server.
