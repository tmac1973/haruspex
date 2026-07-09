# Job Plugins + Autonomous Coding — Project Overview

**Status:** Planning only — no implementation yet. · **Type:** Refactor (registry architecture) + new feature (`autonomous_coding` job type). · Meant to be read, argued with, and edited before any code gets written.

---

## Problem

Job types (research, audit, guided_planning) are hard-coded. Adding one today
touches **~11 files across two languages**:

- `src/lib/stores/jobs.svelte.ts:11` — the `JobType` string union, plus a new
  `XConfig` interface folded into the flat `JobWithSteps`/`JobInput` structs.
- `src-tauri/src/db/mod.rs` — mirror fields on the Rust structs + an
  `ALTER TABLE` migration.
- `src-tauri/src/db/jobs.rs` — extend `JOB_WRITE_COLS`, `job_write_params`, and
  the hand-ordered positional tuple decode in `get_job` (the most error-prone
  step in the whole list).
- `src/lib/agent/jobs/runner.svelte.ts` — branches in `planSteps`, `enqueue`,
  `startRun`, `runPipeline`, plus the new pipeline function itself.
- `src/lib/components/jobs/JobEditor.svelte` — hand-rolled type toggle buttons,
  a conditional form section, reset/load/save plumbing (8+ `jobType === ...`
  conditionals).
- `JobRunView.svelte`, `JobList.svelte` — type-specific rendering and the
  guided "no steps" run-button special case.
- `tools/registry.ts` / `tools/types.ts` — new tool category + gating.
- `promptCatalog.ts` — scope extension.

Meanwhile the type-specific *logic* is unevenly housed: audit lives in clean
injected-deps modules (`auditPipeline.ts`, `auditCluster.ts`,
`auditReport.ts`), research is ~120 inline lines, and guided planning is ~575
lines inlined directly in `runner.svelte.ts`.

A fourth job type is wanted now (autonomous coding, below), and more will
follow. The marginal cost per type should be "write one module, register it."

## Goals

- A **`JobTypeDefinition` registry** (modeled on the existing tool registry in
  `src/lib/agent/tools/registry.ts`): each job type is one self-contained
  module under `src/lib/agent/jobs/types/<id>/` that registers its metadata,
  config defaults, editor form section, step planner, and pipeline.
- **Zero Rust changes to add a job type.** Type-specific config moves into a
  single JSON `type_config` column (the `schedule_config` pattern,
  `jobs.svelte.ts:46`); Rust stays a generic persistence layer.
- **All three existing job types re-implemented as plugins**, with every
  scattered `job_type === ...` branch deleted from runner/editor/list/run-view.
- The job-type picker in `JobEditor.svelte` becomes a **registry-driven
  `ModeSelector`** (replacing the hand-rolled toggle buttons at `:546-571`).
- **`autonomous_coding`** ships as the first *new* plugin and the proof that
  the architecture holds (details below).

## Non-goals

- **Not a true plugin system.** No dynamic loading, no third-party API, no
  separate packages, no versioning. This is an internal registry; "plugin"
  means a statically imported, self-registering module.
- **No speculative capability hooks.** The plugin interface starts minimal;
  hooks (custom run views, HITL, resume state) are added only where a concrete
  type needs them. Expect to reshape the interface when type #5 arrives —
  that's fine.
- **No behavior changes to existing job types** during the conversion phases.
  Research, audit, and guided planning must work identically before/after.
- **No scheduled/headless autonomous-coding runs** in v1 (it opens with an
  interactive interview; a scheduled trigger would park at `needs_input`).

---

## Part 1 — The registry architecture

### `JobTypeDefinition`

```ts
// src/lib/agent/jobs/types/types.ts — the plugin contract (sketch)
export interface JobTypeDefinition<C = Record<string, unknown>> {
	id: string;                       // 'research' | 'audit' | ... (DB job_type value)
	label: string;                    // picker title
	description: string;              // picker card description (ModeSelector)
	badgeLabel?: string;              // JobList badge (defaults to label)
	available?: () => Promise<boolean>; // platform gate (e.g. shell_platform_supported)
	hasPlannedSteps: boolean;         // JobList run-button rule (guided/coding = false)

	configDefaults: () => C;          // editor reset defaults
	Editor: Component;                // config form section rendered by JobEditor
	validateConfig?: (config: C) => string | null;

	planSteps: (job: JobWithSteps) => PlannedStep[];   // display step list at start
	runPipeline: (ctx: JobRunContext<C>) => Promise<void>;

	toolCategories?: string[];        // extra tool categories enabled for this type
	promptScope?: PromptScope;        // catalog prompts offered in the editor
}
```

`JobRunContext` packages what pipelines already receive ad hoc from
`runner.svelte.ts`: the job + run rows, the parsed `type_config`, `patchStep`,
`runJobTurn`, `finalizeRun`, plus two capabilities generalized from guided
planning:

- **`askUser(...)`** — the `ask_user_question` HITL primitive
  (`tools/user-question.ts` + `UserQuestionModal` + `userQuestion.svelte.ts`),
  available to any plugin that opts in.
- **`saveRunnerState(json)` / `loadRunnerState()`** — the
  `job_runs.planning_state` column, generalized as an opaque per-run resume
  slot (column keeps its name; semantics documented as plugin-owned JSON).

### Registry

`src/lib/agent/jobs/types/registry.ts` — `registerJobType(def)`,
`getJobType(id)`, `listJobTypes()`. Same shape as `registerTool`. Types
self-register via a barrel import in the jobs tab entry path. Consumers:

| Consumer | Today | After |
|---|---|---|
| `JobEditor` type picker | hand-rolled buttons `:546-571` | `ModeSelector` over `listJobTypes()` |
| `JobEditor` config form | 8+ `jobType === ...` conditionals | `<def.Editor bind:config>` |
| `runner.svelte.ts` dispatch | 5 branches (`planSteps :209`, `enqueue :359`, `startRun :397`, `runPipeline :551`) | `getJobType(job.job_type).planSteps / .runPipeline` |
| `JobList` badge + run button | `:102`, `:114` | `def.badgeLabel`, `def.hasPlannedSteps` |
| `JobRunView` | `isGuided :21` | generic stage rendering (see Phase 03) |
| Tool gating | category checks in `tools/registry.ts:105` | `def.toolCategories` |
| Prompt catalog | `PromptScope` filtering | `def.promptScope` |

### Config storage

New nullable `type_config TEXT` (JSON) column on `jobs`. A one-time migration
copies the existing per-type columns (6 audit + 2 planning) into JSON; the old
columns stop being written and are left in place as dead columns (SQLite column
drops aren't worth the risk). The 6 model-override columns are **shared** (they
apply to every type) and stay as real columns. After this, touch points #3–#5
from the Problem list disappear permanently.

---

## Part 2 — The `autonomous_coding` job type ("ralph loop")

### What it is

Give the job a folder of plan files (typically a guided-planning run's output
dir) and a project working dir. It resolves any remaining open decisions with
you **up front**, decomposes the plan into small atomic coding steps, then runs
an unattended fresh-context-per-iteration loop — implement one step, verify,
commit, check it off — until the plan is done. Designed as a **"start it and
go to bed"** exercise: zero human interaction after kickoff.

### End-to-end flow

1. **Create** the job: name, working dir (the project being built), **plan
   directory** (path field with a picker pre-filled from recent
   guided-planning runs' `plan_output_dir`s — loose coupling: the contract is
   "a folder of `.md` plans," hand-written plans work too), optional **verify
   command** (e.g. `npm test`), model override. Job type is hidden on
   platforms where `shell_platform_supported()` is false.
2. **Stage 0 — Preflight interview (interactive).** A fresh-context turn reads
   the plan dir and the project dir, and is told explicitly: *the run that
   follows is fully unattended; this is the last chance to ask anything.* It
   must hunt down every deferred, ambiguous, or environment-dependent decision
   in the plan and resolve each via `ask_user_question`, one at a time (the
   same modal as guided planning). Answers are written to
   `DECISIONS-coding.md` in the plan dir. The user answers, then goes to bed.
3. **Stage 1 — Decompose.** A fresh-context turn reads plans + decisions and
   submits an ordered list of **small atomic steps** via a forced structured
   tool (`submit_task_list`, the `submit_plan_outline` pattern). The runner
   persists it as `TODO-coding.md` in the plan dir and as run state; the items
   become the run view's step list.
4. **Git baseline.** If the working dir isn't a git repo, `git init` + initial
   commit. Otherwise commit any dirty state as a `chore: pre-ralph baseline`
   checkpoint (nothing the loop does can destroy pre-existing work).
5. **Stage 2 — The loop.** While unchecked, unblocked items remain, run one
   **fresh-context iteration**: prompt contains the TODO list, the tail of
   `PROGRESS-coding.md`, and any blocked notes. Instructions: pick the first
   actionable unchecked item, implement **only that item**, verify (run the
   verify command if configured, otherwise build/test by its own judgment via
   shell), and finish by calling a forced `submit_iteration_result` tool
   (`{ item_id, status: done | failed, note }`).
   - **On done:** runner checks the item off, appends a progress note, and
     commits (`feat: <item title> [ralph <n>/<total>]` — conventional format).
   - **On failure:** runner appends the failure note and re-queues the item;
     after **3 failed attempts** the item is marked **BLOCKED** with the
     accumulated notes and the loop moves on to items that don't depend on it.
   - **No iteration cap.** The loop runs until every item is done or blocked.
     `ask_user_question` is **excluded from the loop's toolset** — after Stage
     0 the run literally cannot ask.
6. **Finalize.** A last turn writes `REPORT-coding.md`: what was built, test
   status, the blocked list with why, and suggested next steps. Run ends
   `done` (or "done with blockers", surfaced in the run view and history).

### Locked decisions (Q&A appendix)

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Capabilities | **Full shell** via the Shell Code mode plumbing (#132), gated on `shell_platform_supported()` | Self-verification is what makes a no-human loop viable; fs-only means coding blind. |
| 2 | Loop structure | **Decompose, then ralph**: one decomposition turn → checklist; then fresh-context iterations, one item each | Predictable progress display, bounded context per iteration, checklist doubles as the UI step list. |
| 3 | Plan input | **Plan directory path** (picker pre-filled from recent guided-planning runs) | Loose coupling — contract is "a folder of md plans"; survives run deletion, accepts hand-written plans. |
| 4 | Git | **Commit per verified step**; `git init` if needed; baseline commit before the loop | Checkpoints, readable agent history, rollback when a step goes sideways. |
| 5 | Termination | **Run until done, no iteration cap** | It's a go-to-bed exercise; a cap that fires at 3am helps no one. |
| 6 | Human interaction | **Zero during the loop.** Stage 0 preflight interview (same `ask_user_question` modal as guided planning) irons out every deferred decision before the loop starts; the tool is then removed from the toolset | All questions/decisions front-loaded; most resolved in guided planning itself, this is the final chance. |
| 7 | Stuck steps | **Mark BLOCKED after 3 failed attempts, move on**; run ends "done with blockers" | Wake up to maximum progress plus a clear list of what needs a human, instead of GPU spent all night on one impossible step. |

### Why this proves the architecture

`autonomous_coding` exercises every part of the plugin contract that the three
converted types collectively use: `type_config` JSON only (no Rust changes —
validating Phase 04), `available()` platform gating (first consumer),
`askUser` HITL (shared with guided planning), `saveRunnerState` resume slot,
a custom tool category with forced structured tools (the audit
`forceFinalTool` pattern), `hasPlannedSteps: false` (shared with guided
planning), and a dynamically growing step list. If this type lands without
touching core, the registry is real.

### Risks / open questions

- **Local-model capability.** An unattended overnight loop is only as good as
  the model driving it. The per-job model override (incl. OpenRouter, #168)
  exists precisely for this; the plan should not assume the default local
  model suffices for real projects.
- **Verify-command absence.** Without a configured verify command the loop
  relies on the model choosing to test itself; the decompose prompt should
  bias toward making step 1 "establish a runnable test/build harness."
- **Blocked-dependency cascade.** A blocked early item can strand most of the
  list. Acceptable for v1 (the report says why); a dependency graph in
  `submit_task_list` is a future upgrade if it bites.
- **Runaway shell.** Full shell + auto-approve + unattended is the maximum
  trust configuration. Mitigations: cwd pinned to the project dir, git
  baseline commit, and the existing fs write guards. A command denylist is a
  possible hardening follow-up, deliberately out of scope for v1.
