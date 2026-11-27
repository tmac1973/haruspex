# Phase 06 — Coding-run settings on the planning job

**Depends on:** 05 · **Enables:** nothing (final phase)

## Goal

Give the user the one chance they get to shape the chained coding run. The
handoff creates *and starts* the job unattended, so there is no window between
creation and execution in which to edit it — whatever config it is born with is
what runs. This adds a collapsible "Coding run" section to the guided-planning
Editor whose values are stored on the planning job and copied into the job the
handoff creates.

## Files touched

- `src/lib/agent/jobs/types/guided-planning/config.ts` — a nested `coding_run` object: `max_attempts`, `context_mode`, `verify_command`, `step_check_command`, each nullable and each meaning "let the coding job decide".
- `src/lib/agent/jobs/types/guided-planning/config.test.ts` — parse, defaults, malformed-nested-object coverage.
- `src/lib/agent/jobs/types/guided-planning/Editor.svelte` — the collapsible section, shown only when the mode is `unattended_chain`.
- `src/lib/agent/jobs/types/guided-planning/Editor.test.ts` — **new file**; this directory has no Editor test today, unlike `autonomous-coding/`, which has one to model it on.
- `src/lib/agent/jobs/types/guided-planning/pipeline.ts` — the handoff copies these into the created job's `type_config`.
- `src/lib/agent/jobs/runner.test.ts` — coverage that the values reach the created job.

## Steps

1. Add the nested `coding_run` shape to `GuidedPlanningConfig`, with every field nullable and absent parsing to `null`. Null must mean "unset" and not a value, so the coding job's own defaults and its preflight still apply exactly as they would for a hand-created job.
2. Parse defensively: a `coding_run` that is not an object, or fields of the wrong type, degrade to all-null rather than throwing. A malformed config already behaves like no config elsewhere in this file and should here too.
3. In the handoff, spread these into the created job's `type_config` alongside the inherited values from Phase 05, letting null fields simply be absent so the coding job's parser applies its own defaults.
4. Add the Editor section, collapsed by default and rendered only for `unattended_chain` — for the other two modes there is no chained run to configure. Name the settings path in the copy rather than describing where to look.
5. Snapshot any object handed to a settings setter rather than passing a `$state` proxy, per the project's settings convention.
6. Write the tests listed under Test plan.

## Build gate

```
npm run check && npm run lint && npm run test && npm run format:check
```

## Test plan

- `parseGuidedPlanningConfig(null).coding_run` is all-null.
- A populated `coding_run` round-trips through the parser.
- `'{"coding_run":"nonsense"}'` and `'{"coding_run":{"max_attempts":"five"}}'` both degrade to all-null without throwing.
- Runner harness: with `coding_run.max_attempts: 5` set, the created coding job's `type_config` carries `max_attempts: 5`.
- Runner harness: with `coding_run` unset, the created job's `type_config` has no `max_attempts` key, so `parseAutonomousCodingConfig` applies its own default.
- The section does not render in `attended` or `unattended_plan` mode.

## Commit

`feat(jobs): configure the chained coding run from the planning job`

## Rollback

Revert the commit. The handoff falls back to the Phase 05 inheritance set and
the coding job's own defaults, which is a working configuration — a job created
while this existed simply loses the overrides on its next hand-run.
