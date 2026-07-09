# Phase 05 — `autonomous_coding` scaffold + Stage 0 preflight interview

**Depends on:** Phase 04 · **Enables:** Phase 06.

## Goal

Create the `autonomous_coding` plugin as far as the **preflight interview**:
job creation with its config form, platform gating, and a runnable Stage 0
that interrogates the plan directory and resolves every open decision with the
user via the guided-planning question modal. No decomposition or coding loop
yet — this phase proves the plugin lands with zero core/Rust changes and that
the HITL gate works.

## Files touched

- **NEW** `src/lib/agent/jobs/types/autonomous-coding/definition.ts` —
  `id: 'autonomous_coding'`, label "Autonomous Coding", `hasPlannedSteps:
  false`, `available()` (first consumer — see below), config interface +
  parse/serialize.
- **NEW** `src/lib/agent/jobs/types/autonomous-coding/Editor.svelte` — config
  form (fields below).
- **NEW** `src/lib/agent/jobs/types/autonomous-coding/pipeline.ts` — Stage 0
  only this phase: `runPreflight(ctx)` + the pipeline shell that will chain
  stages in Phase 06.
- **NEW** `src/lib/agent/jobs/types/autonomous-coding/prompts.ts` — preflight
  prompt (see below); decompose/loop prompts arrive in Phase 06.
- **EDIT** `src/lib/agent/jobs/types/types.ts` + registry — add `available()`
  to the contract (async gate; unavailable types are hidden from the
  `ModeSelector` picker and refused by the runner with a clear error).
- **EDIT** `src/lib/agent/jobs/types/index.ts` — register the type.
- Tests: definition/config round-trip, `available()` gating, preflight prompt
  assembly.

## Implementation

### Config (`type_config` JSON — zero Rust changes, by construction)

```ts
interface AutonomousCodingConfig {
	plan_dir: string;          // folder of .md plans (required)
	verify_command: string;    // optional, e.g. 'npm test' — '' = model's judgment
	max_attempts: number;      // per-item failure limit, default 3
}
```

The job's shared **working dir** field is the project being built; `plan_dir`
is separate (commonly `<working_dir>/plan/<feature>/`). The editor's plan-dir
field gets a convenience picker listing recent completed guided-planning runs'
`plan_output_dir` values (query via the existing runs store), plus a plain
path input — the contract is "a folder of md plans," not a DB link.

### `available()` gating

`shell_platform_supported()` (the Shell Code mode gate, #132). Where false:
the type does not appear in the picker; an existing job of this type (synced
DB) shows a disabled Run with an explanatory tooltip. Per the Code-mode ×
Windows notes, the gate is the single choke point — do not sprinkle platform
checks elsewhere.

### Stage 0 — Preflight interview

One interactive fresh-context turn via `ctx.runJobTurn`:

- **Toolset:** read-only fs + `ask_user_question` (the guided-planning HITL
  primitive via `ctx.askUser` wiring) + a forced final `submit_preflight`
  structured tool (`{ decisions: {question, answer}[], ready: boolean,
  blockers?: string[] }`).
- **Prompt (the critical piece):** the model is told, verbatim-strength: the
  run that follows is **fully unattended — this is the last moment a human is
  available**. It must read every plan file and the project dir, and hunt for:
  deferred decisions ("TBD", "we can decide later", options left open),
  ambiguous requirements, environment-dependent choices (ports, package
  managers, versions, credentials), and anything the plan assumes exists but
  doesn't. Each finding → one `ask_user_question` (multiple choice, one at a
  time). It must not proceed while any decision is open.
- **Output:** answers written to `DECISIONS-coding.md` in `plan_dir`
  (fs-write allowlisted to that one path this stage — the write-boundary
  pattern from guided planning Phase 05). If `submit_preflight` reports
  `ready: false` with blockers (e.g. plan dir empty, contradictory plans), the
  run fails cleanly with the blockers as the error message.
- Run view shows a "Preflight" step (named-stage pattern shared with guided
  planning).

### Pipeline shell

`runPipeline(ctx)` this phase: preflight → then a stub step that marks the run
finished with "decompose + loop land in Phase 06" (kept behind an obvious
`NOT_IMPLEMENTED` note so nobody ships it accidentally — or gate job creation
behind a dev flag until Phase 06 merges; implementer's choice, but the branch
must not offer a job type that silently does nothing).

## Acceptance

- Type appears in the picker only where shell is supported; create/edit/save
  round-trips `type_config` with **zero Rust diffs in this phase** (the
  architecture's headline claim, verified).
- Running a job against a plan dir with deliberate TBDs: modal questions fire
  one at a time, answers land in `DECISIONS-coding.md`, run completes the
  preflight step.
- Empty/garbage plan dir → clean failure with actionable message.
- `npm run check` / `lint` / `test` green.
