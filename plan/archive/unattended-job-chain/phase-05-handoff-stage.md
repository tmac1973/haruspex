# Phase 05 — The handoff stage

**Depends on:** 01, 02, 03, 04 · **Enables:** Phase 06 (which configures what this creates)

## Goal

Close the chain. Adds a sixth guided-planning stage that either creates and
starts an autonomous-coding job, or records exactly why it did not, and adds the
third run mode that turns it on. This is the phase where the overnight workflow
becomes real: answer the interview, approve the overview and the outline, walk
away.

## Files touched

- `src/lib/agent/jobs/types/guided-planning/definition.ts` — a sixth stage, `Handoff`, after `Approval`.
- `src/lib/agent/jobs/types/guided-planning/pipeline.ts` — `HANDOFF = 5`; the handoff implementation; carry the verification verdict forward so the gate can read it.
- `src/lib/agent/jobs/types/guided-planning/config.ts` — widen `run_mode` with `unattended_chain`; require verification in that mode.
- `src/lib/agent/jobs/types/guided-planning/config.test.ts` — coverage that the mode forces `skip_verification` to false.
- `src/lib/agent/jobs/types/guided-planning/Editor.svelte` — third mode value; disable the skip-verification toggle when it is selected, with a one-sentence reason.
- No change needed here: `createJob(input: JobInput): Promise<number | null>` is already exported from `src/lib/stores/jobs.svelte.ts:269`, and `JobInput` (line 118) is `JobCore & TypeConfigColumn & ModelOverrideConfig` — exactly the three groups the handoff needs to populate.
- `src/lib/agent/jobs/runner.test.ts` — harness coverage of every gate outcome.

## Steps

1. Add the `Handoff` stage to `GUIDED_STAGES` and `HANDOFF = 5` to the pipeline's index constants, keeping the documented rule that the constants match the display order.
2. Capture the verification outcome in a variable the handoff can read: whether verification ran at all, and `classifyFindings` applied to the last not-clean verdict.
3. Implement the handoff to run in every mode and finish with a sentence naming the outcome. The stage never blocks and never prompts.
4. Gate order, each with its own message:
   - mode is not `unattended_chain` → `Skipped — run mode is "<mode>"`.
   - verification did not run → `Skipped — the plan was not verified` (defensive; step 6 makes this unreachable through the Editor).
   - blocking findings exist → `Not started — N blocking finding(s)`, then the blocking bullets.
   - otherwise → create and start.
5. Create the job by calling `createJob` from `$lib/stores/jobs.svelte` with a `JobInput` of `job_type: 'autonomous_coding'`, inheriting `working_dir`, the model/backend override and `model_advanced` from the planning job, `use_git` and `web_research` from the planning config, and `plan_dir` set to the planning run's output folder. Name it after the planning job so it is findable.
6. Make `unattended_chain` require verification: the Editor disables the skip-verification toggle when that mode is selected, and `parseGuidedPlanningConfig` forces `skip_verification` to `false` whenever the mode is `unattended_chain`, so a hand-edited config cannot produce the ungated combination.
7. Start it with `enqueue(newJobId, 'chained')`. Both `createJob` and `enqueue` signal failure by returning `null` rather than throwing — `enqueue` does so when the job type is unavailable on this platform. Treat either `null` as a reportable outcome: finish the handoff stage with text naming which call failed, and leave the planning run `succeeded`. The handoff must never throw, because a run that has already produced a good plan must not be recorded as failed over a handoff it could not complete.
8. Record the created job's id in the handoff stage's output so the planning run says what it started, and set the coding job's description to name the planning run it came from, so the link reads in both directions.
9. Update Phase 02's APPROVAL-stage test to account for the sixth stage if it asserts anything about stage count or index ordering, and check no other test hardcodes the number of guided-planning stages.
10. Write the tests listed under Test plan.

## Build gate

```
npm run check && npm run lint && npm run test && npm run format:check
```

## Test plan

Each through the runner harness, asserting on the created-job call and the
handoff stage's recorded output:

- `attended` mode: no job created; output names the mode.
- `unattended_plan`: no job created; output names the mode.
- `unattended_chain`, clean verdict: exactly one `autonomous_coding` job created; `enqueue` called with `'chained'`; output names the new job id.
- `unattended_chain`, verdict with only `(c)` findings: job still created — advisory findings do not block.
- `unattended_chain`, verdict with an `(a)` finding: no job created; output says "blocking" and includes the finding text.
- `unattended_chain`, verdict with an untagged bullet: no job created — the fail-safe holds end to end.
- `unattended_chain` where `enqueue` returns `null`: run still reaches `succeeded`, handoff output says the coding job could not be started and why.
- The created job's config carries `use_git` and `web_research` from the planning job, and `plan_dir` matching the plan output folder.
- `parseGuidedPlanningConfig('{"run_mode":"unattended_chain","skip_verification":true}')` yields `skip_verification: false`.
- A full `unattended_chain` run issues `askUserQuestion` only before the outline is approved, and never after — the single assertion that the headline promise holds.

## Commit

`feat(jobs): start an autonomous-coding run when a plan verifies clean`

## Rollback

Revert the commit. Runs recorded before the revert keep their sixth step row;
the run view renders whatever steps a run persisted, so an old six-step run
still displays. Jobs already created by a handoff are ordinary coding jobs and
are unaffected — they remain editable and re-runnable by hand.
