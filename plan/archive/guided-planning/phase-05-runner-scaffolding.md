# Phase 05 — Runner scaffolding + interactive run context

**Depends on:** Phases 01, 02, 03, 04 · **Enables:** Phases 06, 07 (the stages).

## Goal

Add a `runGuidedPlanningPipeline()` to the job runner and the shared machinery
all stages need: the **interactive run context** (so `ask_user_question` drives
the modal instead of failing safe), the **pause-to-needs-input** behavior with
**milestone resume**, the **write-boundary allowlist**, and auto-approval of
plan-folder writes. No stage logic yet — this phase makes a guided_planning job
*run an interactive, gated agent loop*; Phases 06/07 fill in what it does.

## Files touched

- **EDIT** `src/lib/agent/jobs/runner.svelte.ts` — `runGuidedPlanningPipeline`,
  dispatch by `job_type`, interactive context, needs-input/resume, allowlist.
- **EDIT** `src/lib/agent/tools/user-question.ts` (Phase 02) — replace the
  non-interactive safe-error branch with a real pause-to-needs-input signal.
- **EDIT** `src/lib/agent/tools/registry.ts` / wherever `ToolContext` is built
  for jobs — set `interactive`, thread a `needsInput` callback and the output
  dir.
- Possibly **NEW** `src/lib/agent/jobs/guided-planning/context.ts` — helpers
  shared by stages (allowlist, output-path resolution/guard, milestone
  persistence).

## Implementation

### Dispatch

In the runner's pipeline dispatch (alongside `runPipeline` /
`runAuditPipeline`), branch `job.job_type === 'guided_planning'` →
`runGuidedPlanningPipeline(run)`.

### Interactive run context

Set `ctx.interactive = true` for guided_planning runs that were started in the
foreground by the user. The runner owns this flag; it is what makes
`ask_user_question` open the modal.

### Pause-to-needs-input + resume (the reusable mechanism)

Replace Phase 02's non-interactive stub. When `ask_user_question` runs in a
non-interactive run (e.g. a scheduled trigger with no one attending):

1. Persist current `planning_state` to `job_runs.planning_state`.
2. Set run status `needs_input` and surface it (Phase 08 renders it; the value
   exists now).
3. Abort the in-flight loop cleanly (reuse the existing `activeAbort` path) and
   return — the run is parked, not failed.

**Resume:** `enqueue`/`startRun` checks for an existing `planning_state` on the
job's latest parked run; if present, it rehydrates and re-enters the correct
stage at the recorded milestone (re-running any Q&A since that milestone). A
parked `needs_input` run resumes the moment the user opens it and answers
(foreground ⇒ interactive ⇒ the next `ask_user_question` shows the modal).

> This is the **milestone-resume** + **needs-input** decision realized. It lives
> here, not in Phase 02, because it requires the `planning_state` column and the
> run lifecycle — a deliberate forward-only staging.

### Write boundary + allowlist

- `toolAllowlist` for guided_planning = read/grep/glob tools + `fs_write_text` +
  `ask_user_question` only. No code-editing, sandbox, email, or web-write tools.
- Resolve the output dir once (`job.plan_output_dir` || `plan/<slug>/`).
  Wrap/`fs_write_text` so any write path is validated to resolve **inside** the
  output dir (reuse the path-normalization already used by fs tools); reject
  otherwise with a tool error the agent can recover from.
- **Auto-approve plan-folder writes:** set the fs-write auto-approve so writes
  inside the output dir don't pop the file-conflict modal (keeps the Q&A flow
  clean). `ask_user_question` is unaffected — questions always interact.

### Milestone persistence helper

A `saveMilestone(run, partialState)` that merges into `planning_state` and
persists. Stages call it at each boundary.

## Build gate

```bash
cargo check --manifest-path src-tauri/Cargo.toml   # if any Rust touched for status
npm run check && npm run lint && npm run test
```

## Test plan

1. Run a guided_planning job with a trivial throwaway system prompt that just
   calls `ask_user_question` once and writes a file via `fs_write_text` to the
   output dir — confirm: modal shows, answer flows back, file lands **inside**
   the output dir.
2. A write to a path **outside** the output dir is rejected with a recoverable
   tool error (agent sees the error, doesn't crash the run).
3. Plan-folder write does **not** trigger the file-conflict modal.
4. **Needs-input:** force `ctx.interactive = false`; an `ask_user_question` call
   parks the run as `needs_input` with `planning_state` persisted; re-opening
   and resuming re-enters and shows the modal.
5. A non-output tool (e.g. a web-write or sandbox tool) is not callable
   (allowlist).

## Commit

```
feat(jobs): guided_planning runner scaffolding + interactive context

Adds runGuidedPlanningPipeline dispatch, the interactive run context
(ask_user_question now drives the modal), pause-to-needs-input with
milestone-state persistence/resume, the plan-folder write boundary +
allowlist, and auto-approved plan-folder writes. Stage logic in 06/07.
```

## Roll-back rule

Revert the runner additions; the job type still exists (Phase 03/04) but won't
run. The Phase 02 tool keeps its safe-error fallback if the user-question edit is
reverted together.
