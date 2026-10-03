# Phase 12 — Context audit and verification lite

Depends on: — / Enables: —

## Goal

Two halves.

**1. The context audit.** Measure where research, audit and
autonomous-coding runs grow their context, then fix only what the numbers
point at (decision 6). Every job turn already starts fresh
(`runEphemeralTurn`), and steps already record `tokens_prompt` and
`peak_prompt_tokens` (`db/mod.rs:633-637`). The context window is already recorded per run (`job_runs.context_size`,
`db/mod.rs:647`). What is missing is how often the in-loop trim fired
(`iteration.ts:828-848`) and how far `fitMessagesToBudget` had to escalate
(`src/lib/agent/context-budget.ts:280+`). Both are signs of a turn running out
of room. An `onContextManaged(ContextManagedInfo)` hook already exists
(`loop.ts:175`, fired at `iteration.ts:522` and `:579`, used by the Shell),
but it doesn't report the in-loop trim or the final forced fit, and job
turns don't receive it.

Known suspects, unmeasured:
- **Research:** a step's prior output is prepended with no cap
  (`research/pipeline.ts:119-137`).
- **Audit:** sample turns run up to 200 iterations by default, and 400 at
  most, in one context (`audit/pipeline.ts:51-52`).
- **Autonomous coding:** phase turns run up to `min(2×max_turns, 40+20×items)`
  iterations (`autonomous-coding/pipeline.ts:184-191`).

**2. Verification lite.** Guided planning's verification becomes a
three-way setting:
- **Full,** today's behaviour: up to `MAX_VERIFY_ROUNDS = 5` verify-and-revise
  rounds;
- **Lite:** one verify read and one revise turn if it found problems, with no
  second verify, and whatever is left carried to the handoff as findings;
- **Skip,** today's `skip_verification`.

## Files touched

- `src-tauri/src/db/mod.rs` (migration) and `src-tauri/src/db/runs.rs`
  (around :154-190, where step rows are written): two new `job_run_steps`
  columns. `StepStats` isn't ts-exported, so the export script has nothing to
  do here.
- `src/lib/agent/loop.ts` (`ContextManagedInfo`), `loop/iteration.ts` and
  `src/lib/agent/context-budget.ts`: report the in-loop trim and the forced
  fit through the existing hook.
- `src/lib/agent/runEphemeralTurn.ts` and `jobs/runner.svelte.ts`:
  accumulate the events per step and save them.
- `src/lib/components/jobs/JobRunDetail.svelte` (or the step card): show
  them.
- `src/lib/agent/jobs/types/guided-planning/config.ts`, `definition.ts`
  (`skip_verification` in the editor state, defaults and converters, around
  :11, :107, :123, :138), `pipeline.ts`, and `Editor.svelte` (whose checkbox
  at :123 becomes a select): the `verification` setting.
- New `plan/misc_futures/measurements-phase-12.md`.
- The pipelines the measurements implicate.
- Tests; `./scripts/export-ipc-types.sh`.

## Steps

1. **Extend the existing hook.** Don't add a parallel one.
   - `ContextManagedInfo` gains `kind: 'trim' | 'fit'` and `forced:
     boolean`.
   - The in-loop trim (`iteration.ts:828-848`) fires it with `kind:
     'trim'`.
   - `fitMessagesToBudget`'s result reports whether it reached the
     forced-fit ("halve") stage, and the pre-send calls fire the hook with
     `kind: 'fit'` and that flag.
   - `runEphemeralTurn` forwards `onContextManaged`, as it does
     `onUsageUpdate`.
   - The Shell's existing use (`runShellTurn.ts:112`, `shell.svelte.ts:959`)
     keeps working; the new fields are additive.
2. **Per-step telemetry.** The runner accumulates the events per step.
   `job_run_steps` gains:
   - `trim_events INTEGER`;
   - `pressure_max TEXT`: `'trim'`, `'fit'` or `'forced'`, the worst
     reached, or null.

   They are written with the existing token columns. The step card shows
   "peak 61% of 32k · trimmed 4×" whenever trimming happened, with the
   window from the run's `context_size`; the tooltip gives the worst kind.
3. **MANUAL — measure, before changing any pipeline.** A person runs this
   step, not a coding run. The `perf` commit waits for it. Run one real job
   of each type
   on the current job model (Qwen3.8-Flash on vLLM, compute:3000) and record
   per-step peak %, trim count, worst kind, iterations and wall time in
   `measurements-phase-12.md`:
   - **research:** 4 steps, deep research on the middle two;
   - **audit:** 5 samples on a mid-sized repo;
   - **autonomous coding:** a 3-phase plan.
4. **Fix only what crosses the line** (after step 3, in a separate session).
   A step "crosses" when its peak is at least 85% of the window, or its
   `pressure_max` is `'forced'`. For each pattern
   that crosses, apply the matching fix and nothing else:
   - **Research, long prior output:** cap what is prepended at 25% of the
     window. A longer output is summarised first by one sub-agent call, and
     the step is told the full text is in the run history.
   - **Audit, long sample turns:** at 60% of the window, have the turn write
     its findings so far through its submit tool and continue fresh with
     those findings as its only context, at most twice per sample.
   - **Coding, long phase turns:** at 70% of the window, end the turn with a
     progress note to PROGRESS and continue the phase in a new turn from the
     TODO, as the repair path already does for single items.

   Record which fixes were applied, and re-measure the affected job type
   once.
5. **The `verification` setting.**
   - `GuidedPlanningConfig.verification: 'full' | 'lite' | 'skip'` replaces
     `skip_verification`.
   - Parsing: `skip_verification: true` becomes `'skip'`; anything absent or
     unknown becomes `'full'`.
   - In `unattended_chain`, `'skip'` is forced to `'lite'`, not to `'full'`.
     A chain still gets one independent read; that is the point the current
     forced-off rule protects.
   - The editor shows a three-option select with one-line tooltips.
6. **Lite in the pipeline.** Around `pipeline.ts:1820`. Call `verifyTurn` and
   the revise turn directly; `verifyOnce` (:1262) throws the verdict away.
   1. one `verifyTurn`, keeping its verdict;
   2. if it isn't clean, one revise turn;
   3. stop, and set `verified = true`.
   - Since there is no second verify, whether the revise fixed anything is
     unknown. The **whole** first verdict goes through `classifyFindings` and
     is carried into the handoff as open findings, for the coding preflight
     to settle, exactly as unresolved findings are today.
   - The run report says "verification: lite (1 round)".

## Build gate

The overview's gate. `check-ipc` must pass after the type export.

## Test plan

- **Unit, loop:**
  - a conversation pushed over 70% fires `onContextManaged` with
    `kind: 'trim'`;
  - one that needs the forced fit reports `forced: true`;
  - the Shell's handler still receives its existing fields.
- **Unit, runner:** the events for one step are summed, and the worst kind
  is kept; the new columns are written.
- **Unit, config:**
  - `skip_verification: true` parses to `'skip'`;
  - absent parses to `'full'`;
  - `'skip'` in `unattended_chain` reads as `'lite'`.
- **Unit, pipeline:**
  - lite runs exactly one verify, plus one revise only when the verify isn't
    clean;
  - all of the first verdict's findings reach the handoff;
  - full still loops up to 5 rounds.
- **Component:** the step card shows the trim summary only when trimming
  happened.
- **Measured:** `measurements-phase-12.md` has the before numbers for all
  three job types and, for each fix applied, the after numbers.

## Commit

Two commits:
- `feat(jobs): record context pressure per step, and a lite verification mode for planning`
- `perf(jobs): <the fixes the measurements called for>`, or no second commit
  if nothing crossed the line. The measurements file says so either way.

## Rollback

Revert the commits. The new columns stay in the database, unused, as earlier
added columns have. Configs with `verification` set are read by the old code
as "verify", which is the safe default.
