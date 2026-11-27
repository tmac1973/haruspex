# Phase 04 — The `chained` trigger and a mute preflight

**Depends on:** nothing · **Enables:** Phase 05 (which starts runs with this trigger)

## Goal

Teach the runner a third kind of run trigger, and make it mean one specific
thing in the coding pipeline: this run has nobody watching, so its preflight may
not ask questions. Today `RunTrigger` is `'manual' | 'scheduled'`, and the
coding pipeline rejects `scheduled` outright *because* preflight is interactive.
A chained run is neither — it is unattended like a scheduled one, but it is
allowed to start, because this phase removes the thing that made unattended
unsafe.

## Files touched

- `src/lib/agent/jobs/runner.svelte.ts` — widen `RunTrigger` to include `'chained'`.
- `src/lib/stores/jobRuns.svelte.ts` — the two hardcoded `'manual' | 'scheduled'` unions (the interface field and the `createJobRun` parameter).
- `src/lib/agent/jobs/types/autonomous-coding/pipeline.ts` — keep rejecting `scheduled`; allow `chained`; build `PREFLIGHT_TOOLS` without `ask_user_question` when the trigger is `chained`.
- `src/lib/agent/jobs/types/autonomous-coding/prompts.ts` — `preflightPrompt` takes an `interactive` flag and drops its "ask the user now" instruction when false.
- `src/lib/agent/jobs/types/autonomous-coding/prompts.test.ts` — prompt assertions both ways.
- `src/lib/agent/jobs/runner.test.ts` — harness coverage for a chained coding run.

## Steps

1. Widen `RunTrigger` to `'manual' | 'scheduled' | 'chained'` and update both unions in `jobRuns.svelte.ts`. `job_runs.trigger` is a plain TEXT column with no constraint, so no migration and no Rust change is needed — confirm this by running the IPC export script and seeing no drift.
2. In the coding pipeline's opening guard, keep the `scheduled` rejection and its message exactly as they are. A hand-created job started on a schedule must still be refused.
3. Derive `const interactive = ctx.trigger !== 'chained'` once, near where `contextMode` is resolved, so every consumer reads one value.
4. Build the preflight toolset from that: when not interactive, omit `'ask_user_question'`. The iteration and decompose toolsets already omit it and must not change.
5. Change `preflightPrompt` in lockstep to take the same flag and, when false, drop the instruction telling the model to ask the user about anything unresolved, replacing it with an instruction to record its best-supported choice in `DECISIONS-coding.md` and proceed. Pass `interactive: false` to the preflight turn in the same change. All three — prompt wording, tool presence, interactivity flag — move together: `pipeline.ts:1001` records a run that died on "No interactive user is available" precisely because they disagreed.
6. Leave everything else about preflight alone — it still grounds in the codebase, still runs commands to check the verification command works, and still writes `DECISIONS-coding.md`.
7. Write the tests listed under Test plan.

## Build gate

```
npm run check && npm run lint && npm run test && npm run format:check && ./scripts/export-ipc-types.sh
```

The export script must report no drift; if it rewrites anything, a Rust type
mirrors the trigger union and this phase's assumption is wrong.

## Test plan

- `preflightPrompt(..., interactive: true)` contains the ask-the-user instruction; with `false` it does not, and instead instructs recording a choice.
- Runner harness, coding job with trigger `chained`: every `runEphemeralTurn` call's `toolAllowlist` excludes `ask_user_question`.
- Runner harness, coding job with trigger `manual`: the preflight call's allowlist still includes it — the existing behaviour is unchanged.
- A coding job with trigger `scheduled` still fails with the existing message.
- `git status` after `./scripts/export-ipc-types.sh` shows no modified generated files.

## Commit

`feat(jobs): add a chained run trigger with a non-interactive preflight`

## Rollback

Revert the commit. Nothing creates a `chained` run until Phase 05, so on its own
this is inert. If a chained run row already exists in `job_runs`, its trigger
string stays readable — the column is untyped text and the run view renders it
verbatim.
