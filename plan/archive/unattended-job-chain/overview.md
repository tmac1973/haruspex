# Unattended Planning → Coding Chain — Project Overview

## Problem

Guided planning and autonomous coding both exist to produce real work without
supervision, but neither can currently be left alone end to end. Guided planning
blocks on three approval checkpoints; the last of them lands 36–115 minutes into
a run, long after the user has walked away. Autonomous coding opens with an
interactive preflight interview and hard-refuses to start on a schedule
(`autonomous-coding/pipeline.ts:309`) for exactly that reason. So the workflow
this is all meant to serve — set a job going, go to bed, wake up to a testable
project — is impossible today. The run parks on a modal at 3am and resumes when
somebody presses a button over breakfast.

Separately, both job types assume git exists. Coding creates a branch, commits
each phase, and carries a commit-signing failure policy; planning writes
`## Commit` and `## Rollback` into every phase file, and `phaseFileProblem`
enforces both as required sections. A user building something for fun on a
machine without git installed has no way to opt out of any of it.

## Goals

- Once the guided-planning interview is over (the **Overview** and **Outline**
  stages), the remainder of the chain runs with **zero** user prompts.
- Guided planning can create and start an autonomous-coding job on its own when
  a plan is ready.
- The chain refuses to start coding on a plan whose verification found problems
  that an unattended coding run could not survive.
- Either job type can run with git disabled entirely, including the plan's file
  contract.
- Everything the chained coding run needs is settable *before* the chain starts,
  because there is no opportunity to intervene once it does.

## Non-goals

- **Shortening or removing the guided-planning interview.** The interview is the
  entire value of the job type; a guided-planning run that asks nothing is a
  one-shot prompt with extra stages.
- **Making the Overview and Outline checkpoints optional.** Both land inside the
  ~10-minute window where the user is already answering interview questions.
  Turning off a gate you were going to walk through anyway buys nothing and
  costs the cheapest chance to catch a bad overview.
- **Reducing run time or reasoning cost.** Run 47 showed reasoning is ~100% of
  wall-clock (verification: 4766s of 4782s). That is a real and larger problem,
  and it is a separate piece of work.
- **Resume after crash.** `PlanningState` persists milestones but parking/resume
  is deliberately unwired. Unattended operation makes that gap far more
  expensive; closing it is not in this scope.
- **Lifting the scheduled-run block for hand-created coding jobs.** The block is
  correct for them; only the new chained trigger bypasses it.
- **Changing autonomous coding's post-preflight muteness.** It is already
  guaranteed by toolset — `ask_user_question` appears in `PREFLIGHT_TOOLS` and
  nowhere else.

## Users & primary flow

A single user, on their own machine, who wants a working project in the morning.

1. User creates a guided-planning job, sets **Run mode** to *Unattended plan +
   code*, sets **Use git** to suit the project, and opens the **Coding run**
   section to confirm what the chained job will use.
2. User starts the run and answers the Overview interview one question at a
   time, then approves the overview at its checkpoint.
3. User answers the Outline interview, then approves the dependency map.
4. **The user leaves.** Everything from here is automated.
5. Planning writes the phase files. Verification runs and reaches a verdict.
6. If verification found blocking problems, the chain stops. The run ends with
   the plan on disk and the findings recorded, and no code is written.
7. Otherwise, planning creates an `autonomous_coding` job and starts it with the
   `chained` trigger. Its preflight runs without the question tool; decompose,
   loop and finalize were already mute.
8. In the morning the user finds either a plan with open findings to triage, or
   a project whose build gate has been run against every completed phase.

## Constraints

- **Stage numbering convention for this plan.** Stages are referred to by NAME.
  Where an index is unavoidable it is the pipeline's own 0-based constant:
  `OVERVIEW = 0`, `OUTLINE = 1`, `PLANNING = 2`, `VERIFY = 3`, `APPROVAL = 4`,
  and `HANDOFF = 5` once Phase 05 lands. "Stage 4" in this plan always means
  Approval, never Verify.

- **`ask_user_question` lives only in `PREFLIGHT_TOOLS`**
  (`autonomous-coding/pipeline.ts:116`). Muteness after preflight is enforced by
  toolset, not prompt, and must stay that way.
- **The prompt, the tool and the interactivity flag must agree.**
  `autonomous-coding/pipeline.ts:1001` records a real run that died on "No
  interactive user is available" because a retry turn inherited the preflight
  system prompt and the `ask_user_question` tool but *not* interactivity — three
  settings, two of them saying "ask" and one saying "nobody is there". Any
  change to one of the three must move the other two with it.
- **`resolveCommands` already falls back to the guided-planning overview** for
  the verification command (`autonomous-coding/pipeline.ts:225-260`), explicitly
  so the contract survives a preflight that fumbles the transcription. Half the
  handover exists and must not be duplicated.
- **Scheduled coding runs are rejected outright**
  (`autonomous-coding/pipeline.ts:309`). The chained trigger has to be
  distinguishable from both `manual` and `scheduled`.
- **`REQUIRED_PHASE_SECTIONS` contains exactly two entries** — a
  `Depends on:` line and a `## Rollback` section — and `phaseFileProblem` gates
  every phase write and every verification revision against them. `## Rollback`
  is in that set as the *tail-truncation detector*: it is the last section of
  the template, and the only cheap way to notice a file whose end is missing.
  `## Commit` is **not** in the set; it appears only in `phaseWritePrompt`'s
  template text. So making `## Commit` conditional needs no change to the gate,
  and `## Rollback` must survive in both git modes.
- **The verify stage's clean/not-clean verdict is newly honest** and currently
  uncommitted. It previously reported `'Plan verified'` unconditionally. The
  chain gate depends on that fix landing.
- **Verification categories are the only severity signal available.** The
  verifier reports four kinds (ordering, deferred decisions, embedded code,
  contradictory/unreachable) and no severity field.
- Tauri 2 + SvelteKit 5 runes, TypeScript; tabs, single quotes, no trailing
  commas. Rust 4-space/100-col.
- Settings are plain JSON and must be snapshotted before being handed to a
  `stores/settings.ts` setter — never store a `$state` proxy.
- Changing a Tauri command or a `#[ts(export)]` struct requires
  `./scripts/export-ipc-types.sh` or CI fails on drift.
- UI copy: one short sentence per section, no exposition, extra detail in a
  `title` tooltip, and name the settings path rather than describing it.

## Success criteria

- A guided-planning run in *Unattended plan + code* mode issues no user prompt
  of any kind after the Outline checkpoint is approved — verifiable by asserting
  `askUserQuestion` is not called past that point in the runner test harness.
- With **Use git** off, a completed plan contains no `## Commit` section but
  still contains `## Rollback` (the tail-truncation detector),
  `phaseFileProblem` accepts those files, and the coding run creates no branch
  and makes no commit.
- A run whose verification reports an ordering, deferred-decision or
  unreachable-step finding ends without creating a coding job, and its final
  output names the findings.
- A run whose verification reports only embedded-code findings (or none) creates
  exactly one `autonomous_coding` job, starts it, and that job appears in the
  jobs list, editable and re-runnable.
- A chained coding run's preflight completes with no `ask_user_question` call
  and still writes `DECISIONS-coding.md`.
- A hand-created coding job started on a schedule is still rejected.
- Every phase of the chain is attributable afterwards: the planning run records
  which coding job it started, and the coding job records which plan it came
  from.

## Decisions

- **Dirty plan at 3am** → Stop, but only if findings are severe — severity
  decides whether the chain proceeds, rather than any finding blocking it.
- **Which findings are severe** → Ordering (a), deferred decisions (b) and
  contradictory/unreachable steps (d) block the chain; embedded code (c) is
  advisory. Rationale: an unattended coding run cannot resolve a "TBD" because
  `ask_user_question` is not in its toolset, so it would silently invent the
  decision.
- **Chained preflight** → Run the preflight stage with `ask_user_question`
  removed from its toolset, rather than skipping the stage. Keeps codebase
  grounding, command validation and `DECISIONS-coding.md`; the prompt changes in
  lockstep with the toolset.
- **Git toggle scope** → Everything, including the plan sections. Coding: no
  branch, no commits, no signing fallback. Planning: phase files omit
  `## Commit`.
- **`## Rollback` with git off** (added while drafting the phases, after
  checking the actual constant) → Kept. It is the last
  section of the template and therefore the tail-truncation detector inside
  `REQUIRED_PHASE_SECTIONS`, which `phaseFileProblem` uses and which became
  load-bearing when the verifier stopped checking for malformed files. Rollback
  without git is still meaningful ("delete the files this phase created"), so
  only `## Commit` is conditional and the gate does not vary by mode.
- **Finding classification** → The verifier prefixes each bullet with the
  category letter it matched; the runner parses those. An untagged or
  unparseable bullet counts as blocking.
- **Handoff location** → A sixth guided-planning stage, always present, which
  either starts the coding job or records why it did not — following the VERIFY
  precedent of running-but-reporting-skipped rather than renumbering stages.
- **Verification + chaining** → `Unattended plan + code` requires verification;
  the Editor disables the skip-verification toggle in that mode and says why.
- **How unattended is expressed** → One mode selector with three values:
  Attended / Unattended plan / Unattended plan + code. Makes "chain enabled but
  final approval still blocking" unrepresentable.
- **What the chain creates** → A real, persisted `autonomous_coding` job, started
  with a new `chained` trigger kind. The trigger is what unlocks the
  non-interactive preflight and bypasses the scheduled-run rejection.
- **Chained job configuration** → Inherited from the planning job (working dir,
  model/backend override, git toggle, web research) with `plan_dir` from the
  planning output, plus a "Coding run" section in the guided-planning Editor to
  set the rest before starting.
