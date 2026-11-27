# Phase 01 — Git toggle on both job types

**Depends on:** nothing · **Enables:** Phase 05 (the chained job inherits the setting)

## Goal

Let a user run either job type on a machine with no git, or on a project they
don't want versioned. Adds one `use_git` setting to each job type; when off, the
coding run creates no branch and makes no commits, and written phase files carry
no `## Commit` section. Independently shippable: it improves both job types on
its own, with or without any of the chaining work.

## Files touched

- `src/lib/agent/jobs/types/autonomous-coding/config.ts` — add `use_git: boolean | null` to `AutonomousCodingConfig` and parse it (absent = on, matching how `create_branch` and `web_research` default).
- `src/lib/agent/jobs/types/autonomous-coding/config.test.ts` — parse/default coverage.
- `src/lib/agent/jobs/types/autonomous-coding/pipeline.ts` — skip branch creation, per-phase/per-step commits and the signing-fallback path when `use_git` is off.
- `src/lib/agent/jobs/types/autonomous-coding/Editor.svelte` — the toggle; hide `create_branch` and `signing_fallback` when it is off, since both become meaningless.
- `src/lib/agent/jobs/types/guided-planning/config.ts` — add `use_git: boolean | null` to `GuidedPlanningConfig` and parse it.
- `src/lib/agent/jobs/types/guided-planning/config.test.ts` — parse/default coverage.
- `src/lib/agent/jobs/types/guided-planning/pipeline.ts` — `phaseWritePrompt` takes the flag and omits `## Commit` from its section list when off.
- `src/lib/agent/jobs/types/guided-planning/pipeline.test.ts` — prompt assertions both ways.
- `src/lib/agent/jobs/types/guided-planning/Editor.svelte` — the toggle.
- `src/lib/agent/jobs/runner.test.ts` — harness coverage that a `use_git: false` coding run makes no branch and no commit.

## Steps

1. Add `use_git: boolean | null` to `AutonomousCodingConfig`, parsed as `raw.use_git !== false` so an absent value (every existing job) reads as on.
2. Add the same field and parse to `GuidedPlanningConfig`.
3. In `phaseWritePrompt`, take `useGit: boolean` and build the section list so it reads `…## Build gate, ## Test plan, ## Commit, ## Rollback` when on and `…## Build gate, ## Test plan, ## Rollback` when off.
4. Leave `REQUIRED_PHASE_SECTIONS` untouched, and confirm before starting that it still holds exactly two entries — a `Depends on:` matcher and a `## Rollback` matcher. `## Commit` is not among them, so no gate change is required and the gate does not vary by mode. If a future edit has added a `## Commit` matcher, this step becomes "remove it" and the Test plan's first git-off assertion is what catches the difference.
5. Pass the flag at all **three** `phaseWritePrompt` call sites in the planning pipeline: the Planning loop's write turn, the Planning loop's `ensureWritten` retry prompt, and `reviseTurn`'s `ensureWritten` retry prompt. (At time of writing these are lines 1227, 1240 and 977 respectively; find them by call, not by line number.)
6. In the coding pipeline, guard branch creation on `use_git`, guard every commit call on it, and skip the signing-fallback handling entirely when off.
7. Add the toggle to the autonomous-coding Editor, labelled "Use git", and hide `create_branch` and `signing_fallback` beneath it when off.
8. Add the same toggle to the guided-planning Editor.
9. Write the tests listed under Test plan.

## Build gate

```
npm run check && npm run lint && npm run test && npm run format:check
```

## Test plan

- `parseAutonomousCodingConfig(null).use_git === true`; `'{"use_git":false}'` parses to `false`; an unrelated config leaves it `true`.
- Same three for `parseGuidedPlanningConfig`.
- `phaseWritePrompt(..., useGit: true)` contains `## Commit`; with `false` it does not, and still contains `## Rollback` in both.
- `phaseFileProblem` accepts a git-off phase file (no `## Commit`, has `## Rollback`) and still rejects one whose tail is missing — proving the truncation detector survives the change.
- Through the runner harness: a coding job with `use_git: false` issues no branch-creation and no commit call.

## Commit

`feat(jobs): let guided planning and autonomous coding run without git`

## Rollback

Revert the commit. The config field is additive and absent values read as "on",
so any job authored while it existed keeps working — a job explicitly set to
`use_git: false` silently reverts to using git, which is the pre-change
behaviour for every job.
