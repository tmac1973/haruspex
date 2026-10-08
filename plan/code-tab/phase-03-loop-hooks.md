# Phase 3 — Loop hooks and the code tool profile

**Depends on:** — · **Guide:** none (`no-docs`)

## Goal

Two small changes to shared agent plumbing that the Code session needs, landed
on their own so their tests stand alone.

## 1. Steering

`AgentLoopOptions.takeSteering?: () => string[]`.

In `agent/loop/iteration.ts`, after a tool batch's results are appended and
before the next model call, drain it. Each string becomes a `user` message
appended after the tool results, and an `onSteering?(texts)` callback fires so
the UI can mark them delivered. If the model finishes (no tool calls) while
messages are still queued, the loop runs one more iteration instead of
completing — the user's message must never be silently held past the turn.

Not drained mid-stream or mid-tool: the boundary is the iteration.

Tests: drained between iterations; one-more-iteration on completion with
pending input; abort with pending input returns them to the caller
(`onComplete` meta carries `undeliveredSteering`) so the UI can restore them to
the input box.

## 2. Code tool profile without the Shell

Today `codeMode` in the registry implicitly means "Shell Code mode" — tool
descriptions and `codeRoot(ctx)` branch on `ctx.shellMode`. Make the profile
explicit:

- `ToolFilterOpts.codeMode` stays; `shellMode` stays; the Code tab passes
  `codeMode: true, shellMode: false`.
- `ToolContext.codeSessionId?: string` (phase 2 uses it as the bg owner).
- `getToolSchemas` picks the `run_command` description by
  `shellMode` (live terminal wording vs one-shot wording + background tools).
- `command_output` / `command_stop` and the phase-6 tools (`open_in_shell`,
  `open_in_editor`) are offered only when `codeMode && !shellMode`.
- `codeRoot(ctx)` already returns `ctx.workingDir` when not in shell mode — add
  a test pinning it.

Tests: schema sets for (codeMode, shellMode) ∈ {(t,f), (t,t), (f,t), (f,f)}.

## Done when

Both are merged with no caller using them yet; the existing Shell Code mode
behaviour is unchanged (its tests pass untouched).
