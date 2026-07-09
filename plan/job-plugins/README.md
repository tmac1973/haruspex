# Job Plugins + Autonomous Coding — Implementation Plan

Phased, dependency-ordered implementation plan for (1) converting the jobs tab
to a registry/plugin architecture and (2) shipping the `autonomous_coding` job
type as the first new plugin. See [`overview.md`](./overview.md) for the
project definition, the `JobTypeDefinition` contract, and the full Decisions
appendix.

**Status: planning only — nothing implemented yet.**

## Phase map (strictly dependency-ordered)

| # | File | Phase | Depends on |
|---|---|---|---|
| 1 | `phase-01-extract-guided-planning.md` | Extract guided planning from the runner (pure refactor) | — |
| 2 | `phase-02-registry-research-pilot.md` | `JobTypeDefinition` + registry; research converted as pilot | 1 |
| 3 | `phase-03-convert-audit-guided.md` | Convert audit + guided planning; delete all `job_type` branches; ModeSelector picker | 2 |
| 4 | `phase-04-type-config-column.md` | JSON `type_config` column; Rust slimming; migrate per-type columns | 3 |
| 5 | `phase-05-coding-scaffold-preflight.md` | `autonomous_coding` plugin scaffold: editor form, platform gate, Stage 0 preflight interview | 4 |
| 6 | `phase-06-coding-loop-engine.md` | Decompose stage, loop engine, git checkpoints, blocked handling, finalize report | 5 |
| 7 | `phase-07-run-view-hardening.md` | Run-view treatment for loop runs; integration hardening + e2e | 6 |

Everything is sequential: each phase ships independently, the app works
throughout, and existing job types are behavior-identical through Phase 04.

## Locked decisions (full rationale in `overview.md`)

**Architecture**

- Internal registry, not a true plugin system — statically imported,
  self-registering modules under `src/lib/agent/jobs/types/<id>/`, modeled on
  the tool registry (`src/lib/agent/tools/registry.ts`).
- Zero Rust changes to add a job type: per-type config lives in a JSON
  `type_config` column (the `schedule_config` pattern). Model-override columns
  stay shared/real; old per-type columns become dead after a one-time
  migration.
- Minimal interface now; capability hooks (`askUser`, `saveRunnerState`,
  `available()`) exist only because a concrete type needs them.
- Job-type picker becomes a registry-driven `ModeSelector` (replacing the
  hand-rolled buttons in `JobEditor.svelte:546-571`).

**Autonomous coding ("ralph loop")**

- Full shell access, gated on `shell_platform_supported()`.
- Decompose-then-ralph: one decomposition turn → atomic checklist
  (`TODO-coding.md`); then fresh-context iterations, exactly one item each.
- Input = a plan directory path (picker pre-filled from recent guided-planning
  runs); contract is "a folder of md plans," not a DB link.
- Commit per verified step; `git init` + baseline commit before the loop.
- Run until done — no iteration cap; zero human interaction during the loop.
- Stage 0 preflight interview (same `ask_user_question` modal as guided
  planning) resolves every deferred decision before the loop starts; the tool
  is removed from the loop's toolset afterwards.
- Stuck steps: 3 failed attempts → mark BLOCKED with notes, move on; run ends
  "done with blockers" plus a final `REPORT-coding.md`.
