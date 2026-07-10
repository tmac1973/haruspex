# Phase 07 — Run-view treatment + integration hardening

**Depends on:** Phase 06 · **Enables:** — (final phase).

## Goal

Make an overnight run legible the next morning, and harden the rough edges
found while building Phases 05–06. This is the polish/e2e phase, deliberately
last so it hardens real behavior instead of guesses.

## Files touched

- **EDIT** `src/lib/components/jobs/JobRunView.svelte` (and/or a per-type
  view slot on `JobTypeDefinition`, if generic stage rendering proved
  insufficient in practice) — live loop treatment: current item, per-item
  attempt badges (`attempt 2/3`), blocked items styled distinctly, a running
  `n done / k blocked / m todo` tally.
- **EDIT** `src/lib/components/jobs/JobRunDetail.svelte` /
  `JobRunHistory.svelte` — historical runs surface "done with blockers (k)"
  and link/point to `REPORT-coding.md` and `PROGRESS-coding.md`.
- **EDIT** `src/lib/agent/jobs/types/autonomous-coding/*` — hardening items
  below.
- Docs: `README.md` job-type section + this plan dir's README build-status
  update (the guided-planning convention).

## Implementation

### Run view

The decompose stage replaces the run's step list with real items (Phase 06);
this phase makes that list good to look at: step = item title, status icon
(todo/running/done/blocked), attempt count, and the last note on hover/expand.
Prefer extending the generic step rendering; only add a `runView` component
slot to the contract if the generic path genuinely can't express this —
that would be its first consumer, which is the bar (see non-goals).

### Hardening checklist

- **Long-run persistence pressure:** the fire-and-forget
  `db_mark_run_step_started/finished` pattern at hundreds of iterations —
  verify no unbounded queue/backlog; batch or debounce progress writes if
  needed.
- **PROGRESS tail bounding:** confirm the iteration prompt stays flat-sized on
  a 50+ item run (measure token counts on a long toy run).
- **Verify-command failure modes:** command not found / non-zero on a clean
  tree / hangs — ensure each maps to a `failed` attempt with a useful note,
  and a sensible per-command timeout exists via the shell plumbing.
- **Working-dir safety:** confirm fs-write guards + shell cwd pinning hold
  (attempt a step whose plan says to write outside the project; it must fail
  the attempt, not escape).
- **Scheduled-trigger behavior:** a scheduled/headless start hits preflight's
  `ask_user_question` with nobody attending → must park as `needs_input`
  cleanly (the guided-planning non-interactive path), not crash or silently
  skip the interview. v1 documents this type as manual-start.
- **Completion signal:** desktop notification on run end ("Autonomous coding
  finished: 12 done, 1 blocked") — you started it and went to bed; the
  morning-after signal is part of the feature. Reuse whatever notification
  path exists; if none does, a minimal Tauri notification is in scope here.

### Final sweep

- `/code-review`-style pass over the whole branch stack; grep-check from
  Phase 03 still holds (no `job_type ===` outside type modules).
- Update `plan/job-plugins/README.md` build status with any architectural
  adaptations made during implementation (the guided-planning README pattern).

## Acceptance

- Overnight-simulation e2e: 15+ item plan, one impossible item, app left
  running — morning state: legible run view, notification fired, report +
  git history tell the whole story without reading logs.
- All prior phases' acceptance still green; `cargo test` / `clippy` /
  `npm run check` / `lint` / `test` green.
