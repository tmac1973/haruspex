# Phase 04 — `type_config` JSON column; Rust slimming

**Depends on:** Phase 03 · **Enables:** Phase 05 (autonomous coding needs a
config home that requires no Rust changes).

## Goal

Move per-type job config into a single JSON `type_config` column so that
adding a job type never touches Rust again. This deletes the most error-prone
part of today's touch list: mirrored struct fields, `ALTER TABLE` per field,
`JOB_WRITE_COLS`, `job_write_params`, and the hand-ordered positional decode
in `get_job`.

## Files touched

- **EDIT** `src-tauri/src/db/mod.rs` — migration: `ALTER TABLE jobs ADD COLUMN
  type_config TEXT` + a one-time `UPDATE` that assembles JSON from the
  existing 6 audit columns and 2 planning columns (only for rows where they're
  non-default). Add `type_config: Option<String>` to `JobSummary` /
  `JobWithSteps` / `JobInput`; **delete** the per-type option fields from the
  structs.
- **EDIT** `src-tauri/src/db/jobs.rs` — `JOB_WRITE_COLS` / `job_write_params`
  / `get_job` decode / `row_to_job_summary`: replace the 8 per-type columns
  with the single `type_config`. Old columns are no longer read or written;
  they stay in the schema as documented dead columns (SQLite `DROP COLUMN` not
  worth the risk on user DBs).
- **EDIT** `src/lib/stores/jobs.svelte.ts` — delete `AuditConfig` /
  `GuidedPlanningConfig` from the flat structs; `JobWithSteps` / `JobInput`
  carry `type_config: string | null`. Each type module owns its config
  interface and (de)serialization.
- **EDIT** `src/lib/agent/jobs/types/*/definition.ts` — delete the Phase 02
  interim `toJobInput` / `fromJob` flat-field mappers; replace with
  `parseConfig(json)` / `serializeConfig(config)` (defaults applied on parse,
  unknown keys preserved on round-trip).
- **EDIT** Rust tests (`db/jobs.rs`, `db/runs.rs` test modules) + TS store
  tests for the new column and the migration.

## Implementation

### Migration semantics

- Forward-only, idempotent (guard on column existence like the existing
  `:475-490` migrations).
- The JSON shape written by the migration must match what each type module's
  `parseConfig` expects — write the migration against the modules' documented
  config interfaces, and add a TS test that parses a migrated fixture row.
- Model-override columns (6) and `schedule_config` are untouched: they're
  shared across all types and stay first-class.

### Scope note

`job_runs.planning_state` already is an opaque JSON slot; no change needed —
Phase 02's `saveRunnerState` generalized its usage. This phase is jobs-table
only.

## Acceptance

- Fresh DB and migrated-from-current DB both work: existing audit/guided jobs
  load with their config intact, edit + save round-trips, runs behave
  identically.
- Rust knows nothing type-specific: grep `audit_` / `planning_` in
  `src-tauri/src/` hits only the migration block and dead-column comments.
- Adding a hypothetical job type now requires **zero** Rust edits (assert by
  inspection against the Problem list in `overview.md`).
- `cargo test`, `cargo clippy`, `npm run check` / `lint` / `test` green.
