# Phase 03 — Subtask profiles: own model, tools, caps and cost

**Depends on:** phases 01–02 · **Enables:** phase 05 (`delegate_3d` runs as a
subtask with a 3D profile).

## Goal

Let a subtask run with a **profile**: its own model, its own system prompt and
first message (with images), a fixed tool list (helper tools allowed), a
writable-path limit, a round cap, a dollar cap, and a done check that can nudge
it once. When a cap is hit, the subtask is asked for its report in one last call
with no tools. A profiled subtask on a different lane takes its own inference
slot. Every subtask's card also shows its cost and the latest image a step
returned. That card change is the only user-visible part. `delegate` itself
does not change.

## Files touched

- `src/lib/code/subtaskRun.ts` — `SubtaskSpec` gains `profile?:
SubtaskProfile`; `runSubtaskSpec` passes it to `runSubtask` and adds cost to
  the card state.
- `src/lib/code/subtaskProfile.ts` (new) — the `SubtaskProfile` type and
  `profileLane(profile, parentBackend)`.
- `src/lib/code/runSubtask.ts` — use the profile when set: backend, prompt,
  first message, tools, writable paths, caps, done check, final report call,
  own slot; forward step thumbnails.
- `src/lib/code/subtask.ts` — `SubtaskState` gains `costUsd?: number`,
  `tokens?: number` and `sheet?: string` (a final image a profile's `finish`
  returned); add `withUsage(state, usage, modelId)`; keep a
  thumbnail on the latest image-bearing child step only.
- `src/lib/agent/runTurn.ts`, `src/lib/agent/loop.ts` — a
  `stopBeforeRound?: () => boolean` loop option, checked before each model
  call after the first. When it returns true the loop ends with stop reason
  `'capped'`.
- `src/lib/agent/tools/registry.ts` — `ToolSchemaOpts.subtaskHelpers?:
string[]`: a subtask still gets no helper tools, except those of the helpers
  named here.
- `src/lib/agent/loop/turnTools.ts` — pass `subtaskHelpers` through.
- `src/lib/code/systemPrompt.ts` — `buildSubtaskPrompt` takes an optional
  system text that replaces the generic subtask prompt.
- `src/lib/components/code/SubtaskCard.svelte` — show cost (`formatCost`)
  and tokens (`formatTokens`) when known, and the latest step thumbnail.
- `src/lib/code/usageTotals.ts` — export the single-call cost function
  `addCall` already uses (reported cost, else catalogue estimate) as
  `callCostUsd(usage, modelId)`.
- `docs/guide/code-subtasks.md` — "Follow a subtask": the card shows the
  subtask's tokens and, when the model has a price, its cost.
- Tests beside each file: `runSubtask.test.ts`, `subtaskRun.test.ts`,
  `subtask.test.ts`, `registry.test.ts`, `SubtaskCard.test.ts`,
  `usageTotals.test.ts`, a loop test for `stopBeforeRound`.

## Steps

1. Define `SubtaskProfile`:
   - `backend: BackendOverride`
   - `system: string` (whole system prompt)
   - `firstMessage: string`
   - `images: { path: string; dataUrl: string }[]`
   - `tools: string[]` (the loop's `toolAllowlist`)
   - `helpers: string[]` (helper ids whose tools it may have)
   - `writablePaths: string[]`
   - `maxRounds: number`
   - `maxCostUsd: number | null` (null means no dollar cap)
   - `doneCheck?: (steps: SearchStep[]) => Promise<string | null>` (returns a
     nudge, or null when done)
   - `finalReport: (why: 'rounds' | 'cost') => string` (the user message for
     the last call)
   - `finish?: (res: SubtaskResult, usage: { tokens: number; costUsd: number | null }) => Promise<{ text: string; png?: string }>`
     (`usage` is the run's totals, the same figures the card shows)
     (builds what the parent is told once the run ends; without it, the
     generic `resultText` is used)
     1a. `runSubtaskSpec` with a profile:
   - `spec.wt` is null and the child's `root` is `env.folder`. A profiled
     subtask never makes a worktree and never goes through `bringBack`, even
     with `mode: 'write'`.
   - After `runSubtask`, if `profile.finish` is set, its `text` is the result
     text, for foreground and background alike. Its `png` is stored on the
     card as `SubtaskState.sheet` and returned as `SubtaskRunResult.png`.
     Both paths run through `runSubtaskSpec`, so `backgroundSubtasks.ts` gets
     the same text with no change of its own.
2. In `runSubtask`, with a profile:
   - The loop's `backend` is `profile.backend`. `visionSupported` and
     `contextSize` come from its descriptor.
   - The messages are the profile's system prompt, then one user message: the
     first message plus the images as image parts. Without vision, the images
     are left out and the text names their paths.
   - `toolAllowlist: profile.tools`, `subtaskHelpers: profile.helpers` and
     `codeHelpers: profile.helpers` on the loop. `writablePaths` goes on the
     loop as well. `codeReadOnly` is false, and `codeWriteGuard` is the
     session's guard (`env.guard`), since it writes in the real folder.
   - `maxIterations: profile.maxRounds`.
   - Cost: `onUsage` adds `callCostUsd(usage, modelId)` to a running total
     and still calls the parent's `onUsage`. `stopBeforeRound` returns true
     once `maxCostUsd !== null && total >= maxCostUsd`.
   - After the pass, if the loop ended `'capped'` or hit `maxIterations`, run
     one more pass with `toolAllowlist: []`, `maxIterations: 1` and the user
     message `finalReport('cost' | 'rounds')`. Use its text as the report.
   - Otherwise run `doneCheck(steps)`. If it returns a nudge, the signal is
     not aborted and rounds are left under `maxRounds`, push it and run one
     more pass whose `maxIterations` is the rounds left. The round cap counts
     both passes together. If that pass hits either cap, the `finalReport`
     call follows as above. If no rounds are left, skip the nudge and make the
     `finalReport('rounds')` call. There is only ever one nudge. The generic
     `stoppedShort` nudge is not used with a profile.
3. Slot: `profileLane` compares `laneKey(profile.backend)` with
   `laneKey(parentBackend)`. Same lane: use `runInSlot` as today. Different
   lane: `withInferenceSlot({ consumer: 'subagent', backend: profile.backend,
signal }, fn)`, so the parent's slot is neither borrowed nor held for it.
4. Registry: in `subtaskExcludes`, a helper tool is excluded unless its
   helper id is in `opts.subtaskHelpers`. The tool allowlist then narrows it
   further.
5. Card state: `withUsage` adds `usage.total_tokens` and the call's cost to
   `tokens` and `costUsd`. `runSubtaskSpec` publishes it on each call, for
   plain subtasks too.
6. Thumbnails: `runSubtask`'s `onToolEnd` forwards `thumbDataUrl` to
   `markStepDone`. When a new step carries one, earlier child steps lose
   theirs, so a saved session keeps one image per subtask.
7. `SubtaskCard`: under the label row, show "12.3k tokens · $0.42" when
   known (cost only when `costUsd` is set). Under the steps, at the card's
   width, show `sheet` when set, else the latest step thumbnail, with alt
   text from the label.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
node scripts/guide-check.mjs
```

## Test plan

- `runSubtask` with a profile, model calls mocked:
  - Requests go to the profile's backend.
  - The first user message carries the images.
  - Only the allowlisted tools are offered, `check_3d` included when `'3d'` is
    in `helpers`.
  - A write outside `writablePaths` is refused.
- Round cap: a model that always calls tools stops at `maxRounds`, then gets
  one call with no tools and the `'rounds'` final-report message.
- Dollar cap: mocked usage with `cost: 0.3` and `maxCostUsd: 0.5` stops
  before the third call, then makes the report call. `maxCostUsd: null` never
  stops on cost.
- Done check: a nudge string causes exactly one more pass; null causes none.
- Lanes: a profile on `remote:https://openrouter.ai` calls
  `withInferenceSlot` and never calls `runInSlot`. A profile on the parent's
  lane calls `runInSlot`.
- Round cap with a nudge: `maxRounds: 6`, a first pass of 4 rounds and a
  nudge. The second pass gets 2 rounds, then the `finalReport` call. With
  `maxRounds` already used up, no nudge pass runs.
- `subtaskRun`:
  - Card state gains `tokens` and `costUsd` across calls; a plain subtask
    gets them too.
  - Every child call reaches the parent's `onUsage`, foreground and
    background.
  - A profile spec makes no worktree.
  - `finish`'s text is the result and its `png` lands on `sheet`.
- `SubtaskCard.test.ts`: tokens and cost render; cost is hidden when unknown;
  the latest step thumbnail renders; with `sheet` set, the sheet renders in
  its place.
- `registry.test.ts`: a subtask gets `check_3d` only with
  `subtaskHelpers: ['3d']`.

## Commit

`feat(code): subtask profiles (own model, tools, caps) and cost on subtask cards`

## Rollback

Revert the commit. Nothing creates a profile until phase 05. The card change
reads optional fields, so sessions saved with `costUsd` still load in a
reverted build.
