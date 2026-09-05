# Phase 03 — DB schema + job model + run-state persistence

**Depends on:** nothing (independent foundation track) · **Enables:** Phase 04
(editor), Phase 05 (runner/resume).

## Goal

Add the `guided_planning` job type and the persistence needed for it: new job
columns (initial description, output dir), and **DB-backed run state** for
milestone resume (stage, milestone, approved plan outline) plus a `needs_input`
run status. No behavior yet — this is the data layer that Phases 04–08 build on.

## Files touched

- **EDIT** `src-tauri/src/db/mod.rs` — schema + migration:
  - `jobs` table: add `initial_description TEXT`, `plan_output_dir TEXT`
    (nullable; relative subdir, default derived from name in Phase 04).
  - `job_runs` table: add `planning_state TEXT` (nullable JSON blob).
  - Extend the run `status` domain to include `needs_input` (and an
    `awaiting_checkpoint` value if the schema constrains status; otherwise it's
    just a new string value).
- **EDIT** the Rust job/run structs + their `ts-rs` derivations (wherever
  `JobType`, the job row, and the run row are defined) — add `GuidedPlanning`
  to the job-type enum and the new fields.
- **EDIT** `src/lib/stores/jobs.svelte.ts`:
  - `JobType = 'research' | 'audit' | 'guided_planning'`.
  - Add `initial_description`, `plan_output_dir` to `JobWithSteps`.
- **EDIT** `src/lib/agent/jobs/runner.svelte.ts` (types only here) — add
  `'needs_input'` to `RunStatus` and a `PlanningState` type:
  ```ts
  interface PlanningState {
    stage: 'overview' | 'planning' | 'done';
    milestone: string;            // e.g. 'overview_written', 'phase_03_written'
    approvedOutline: PhaseOutline[] | null;  // set after dep-map approval
    pendingCheckpoint: 'overview_review' | 'dep_map' | null;
  }
  ```

## Implementation

### Migration

Follow the existing additive-migration pattern in `db/mod.rs` (the audit columns
were added the same way — `ALTER TABLE ... ADD COLUMN` guarded by a version
check / `IF NOT EXISTS` idiom already used there). All new columns are nullable
so existing jobs/runs are unaffected.

### `planning_state` as the resume record

`job_runs.planning_state` holds the serialized `PlanningState`. The runner writes
it at each milestone (Phase 05/06/07). On resume, the runner reads it and jumps
to the next stage. The output files on disk are the artifacts; `planning_state`
is the pointer + the approved outline (which isn't fully recoverable from files
mid-write). This is the **DB-backed run state** decision.

### Type parity

Keep Rust the source of truth via `ts-rs`; regenerate bindings so the TS
`JobType`/row types match. Verify no other `match`/`switch` on `JobType` breaks
(grep for exhaustive matches on `job_type`).

## Build gate

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run check && npm run lint && npm run test
```

## Test plan

1. Fresh DB: tables have the new columns; app launches.
2. **Migration on an existing DB:** copy a pre-change DB, launch, confirm
   migration runs once and existing research/audit jobs + runs load unchanged.
3. Round-trip a `guided_planning` job row (create via a test/seed, read back) —
   `initial_description`, `plan_output_dir` persist.
4. Write + read a `planning_state` JSON blob on a `job_runs` row.
5. `ts-rs` bindings regenerated; `npm run check` passes with the new enum value.

## Commit

```
feat(jobs): guided_planning job type + run-state schema

Adds the guided_planning JobType, jobs.initial_description /
plan_output_dir, job_runs.planning_state (JSON resume record), and a
needs_input run status. Additive, nullable migration; ts-rs bindings
regenerated. No behavior yet.
```

## Roll-back rule

Migration is additive and nullable — safe to leave in place even if later phases
revert. If the enum value causes an exhaustiveness break, that surfaces at
`cargo check` / `npm run check` in this phase, not at runtime.
