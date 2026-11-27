# Phase 01 — Read-only `delegate` tool and child runner

**Depends on:** nothing · **Enables:** phase 02 (cards), phase 04 (write mode),
phase 05 (background mode)

## Goal

The Code-tab agent gets a `delegate` tool that runs a read-only child agent loop
on a self-contained task and returns its capped report. Several `delegate` calls
in one response run side by side, up to the lane's capacity, without ever
deadlocking a serialized lane. Children are blocking (the parent's loop waits
for its batch), one level deep, and at most 8 per parent turn. In this phase the
UI shows a delegate call as an ordinary grouped tool step; cards come in phase
02.

## Files touched

- `src/lib/stores/settings.ts` — new `codeSubtasks: 'off' | 'read' | 'write'`,
  default `'read'`.
- `src/lib/components/settings/CodeSection.svelte` — a Subtasks dropdown with
  Off and Read only (phase 04 adds Read and write).
- `docs/guide/settings.md` — the Code section lists Subtasks.
- `src/lib/code/runSubtask.ts` (new) — `runSubtask(opts)`: builds the child's
  code system prompt and drives `runAgentLoop` inside the given slot runner;
  returns `{ outcome, report, steps, stopReason }`.
- `src/lib/code/runSubtask.test.ts` (new) — runner tests with a mocked loop.
- `src/lib/code/runCodeTurn.ts` — export `prepareSystem` and `assemble`;
  `prepareSystem` takes an optional `subtask` and passes it to
  `buildCodeSystemPrompt`; set `ToolContext.codeEffort` from
  `CodeTurnOptions.effort`.
- `src/lib/code/system-prompt.ts` — `buildCodeSystemPrompt` gains
  `subtask?: { task: string }` (child framing: work only on the task, answer
  with a report under 4,000 characters, no questions to the user) and a
  `delegate` section for the parent describing when to delegate.
- `src/lib/code/system-prompt.test.ts` — cases for both new sections.
- `src/lib/agent/tools/delegate.ts` (new) — registers `delegate`.
- `src/lib/agent/tools/delegate.test.ts` (new) — tool tests.
- `src/lib/agent/tools/index.ts` — import `./delegate.ts`.
- `src/lib/agent/tools/registry.ts` — add `delegate` to `CODE_TOOLS`; exclude it
  when `ctx.subtask` is set (no nesting).
- `src/lib/agent/tools/codeTabProfile.ts` — add `delegate` to `CODE_TAB_ONLY`.
- `src/lib/agent/tools/types.ts` — `ToolContext` gains
  `subtask?: { depth: 1 }` (set on a child's tools),
  `subtasksStartedThisTurn?: { count: number }` and
  `codeEffort?: string | null` (the session's effort, for children).
- `src/lib/agent/loop/context.ts` — `LoopContext` / `buildLoopContext` carry
  `subtask` and a fresh `subtasksStartedThisTurn: { count: 0 }`.
- `src/lib/agent/loop.ts` — `AgentLoopOptions` gains `subtask?`.
- `src/lib/agent/loop/toolCalls.ts` — pass both new fields into the inline
  `ToolContext`.
- `src/lib/agent/tools/code.ts` — `ensureCommandApproved`: in a read-mode
  child, a command `isReadOnlyCommand` accepts runs without asking; any other
  command is refused, not asked about.
- `src/lib/agent/tools/code.test.ts` — cases for the child command rule.
- `src/lib/agent/loop/parallelTools.ts` — add `delegate` to
  `PARALLEL_SAFE_TOOLS`.
- `src/lib/agent/loop/parallelTools.test.ts` — delegate batches with reads.
- `docs/guide/code-subtasks.md` (new) — the user-guide page.
- `src/lib/guide/guide.ts` — add `code-subtasks` to the index order after
  `code-sessions`.

## Steps

1. Export `prepareSystem` and `assemble` from `runCodeTurn.ts`. `prepareSystem`
   gains an optional `subtask?: { task: string }` argument passed straight to
   `buildCodeSystemPrompt`; without it, behaviour is unchanged. Add
   `codeEffort` to `AgentLoopOptions`, `LoopContext` and the inline
   `ToolContext`, set from `CodeTurnOptions.effort` in `runCodeTurn`.
2. In `system-prompt.ts`, add the `subtask` option. When set, the prompt starts
   with: you are a subtask of another agent, the task text, do only this, do not
   ask the user anything, finish with a plain-text report of what you found
   (file paths and line numbers, not file contents) under 4,000 characters.
   When not set and the tool list includes `delegate`, add a short section: use
   `delegate` for independent parts of a request that need reading many files;
   give each a complete, self-contained task; several calls in one response run
   at once; children cannot see this conversation.
3. Write `runSubtask(opts)` in `src/lib/code/runSubtask.ts`. Options:
   `sessionId`, `root`, `wslDistro`, `backend`, `effort`, `task`, `label`,
   `mode: 'read'`, `signal`, `runInSlot?: <T>(fn) => Promise<T>`,
   `requester: () => string`, `onToolStart`, `onToolProgress`, `onToolEnd`.
   It calls `prepareSystem` with `readOnly: true` and `subtask: { task }`, then
   runs `runAgentLoop` with the same option block `runCodeTurn` uses
   (`codeMode: true`, `shellMode: false`, `workingDir: root`,
   `codeSessionId: sessionId`, `codeReadOnly: true`, `interactive: true`,
   `streamToolRounds: true`, `subtask: { depth: 1 }`,
   `takeSteering: () => []`), with `maxIterations: 25` and no `codeWriteGuard`.
   The loop runs inside `runInSlot(fn)` when given, otherwise directly (the
   parent's slot is held and idle). It never calls `withInferenceSlot` itself.
   It collects steps through `newRunningStep` / `markStepDone` from
   `agent/steps.ts`. The report is the final text, cut at 4,000 characters with
   `\n\n[Report cut at 4,000 characters.]` appended. A cancelled run returns
   `outcome: 'stopped'` with whatever text was produced; a thrown error returns
   `outcome: 'failed'` and the error message.
4. Write `delegate.ts`. Schema: `task` (string, required), `mode` (enum `read`,
   required; phase 04 adds `write`, phase 05 adds `background`), `label`
   (short string for display). Category: `exec`. `displayLabel` is the label,
   or the first 60 characters of the task. `execute`:
   - refuse when `ctx.subtask` is set (defence in depth);
   - refuse when `ctx.subtasksStartedThisTurn.count >= 8`, telling the model to
     do the rest itself; otherwise increment the count;
   - call `runSubtask` with `ctx.runInSlot`, `ctx.signal`, `ctx.backend`,
     `ctx.codeSessionId`, `ctx.workingDir`, `ctx.wslDistro`,
     `ctx.requester`, and `ctx.codeEffort`;
   - return `toolResult` of `Subtask "<label>" (<outcome>, <n> tool calls):`
     followed by the report, or `toolResult(toolError(...))` on failure.
5. Register: add `delegate` to `CODE_TOOLS` and `CODE_TAB_ONLY`, and make
   `shouldIncludeCodeTool` drop it when `ctx.subtask` is set or
   `getSettings().codeSubtasks === 'off'`. `execute` re-reads the setting and
   refuses with "Subtasks are off (Settings → Code → Subtasks)." when it is
   off, in case it changed mid-turn. Any value other than `'off'` (including
   `'write'`, which phase 04 makes selectable) offers read mode only in this
   phase. Add it to
   `PARALLEL_SAFE_TOOLS` so consecutive delegate calls share a batch of at most
   `MAX_PARALLEL_TOOL_CALLS` (4). Slots follow from the existing code with no
   new rule: on a capacity-1 lane `toolCallConcurrency` is 1, so the batch runs
   its calls one after another and `ctx.runInSlot` is undefined; each child
   then runs directly in the parent's held, idle slot and never asks for a
   ticket. On a lane with capacity above 1 the lender lends the parent's slot
   to the first child and every other child queues for its own ticket, which
   the lane can grant.
6. In `code.ts` `ensureCommandApproved`, before the `codeReadOnly` branch: when
   `ctx.subtask` is set and `ctx.codeReadOnly` is true, a command that passes
   `checkCommandBoundary` and `isReadOnlyCommand` is approved; any other is
   refused with "A read-only subtask can only run commands that read (ls, cat,
   grep, git log…)." Read-mode children therefore never raise an approval
   prompt. The `codeReadOnly` session rule (ask about every command) is
   unchanged for ordinary read-only sessions.
7. Thread `subtask` and `subtasksStartedThisTurn` through `AgentLoopOptions`,
   `LoopContext`, `buildLoopContext` and the inline `ToolContext` in
   `toolCalls.ts`.
8. Add `codeSubtasks` to the settings type and defaults (`'read'`). In
   `CodeSection.svelte` add a Subtasks `<select>` with Off and Read only, one
   short line of copy ("Let the agent hand parts of a task to helper agents."),
   detail in a `title` tooltip. Add Subtasks to the Code section of
   `docs/guide/settings.md`.
9. Write `docs/guide/code-subtasks.md` (frontmatter `title`, `description`):
   what subtasks are, that the agent starts them itself, that they only read in
   this release, that Settings → Code → Subtasks turns them off, that they run at once only when Settings → Inference →
   Parallel streams (or the remote server) allows more than one stream, the 4 /
   8 limits, and what they don't do (write files, ask you questions, start
   their own subtasks). Under 6 KB.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
```

## Test plan

- `runSubtask.test.ts`: read-only flags and `maxIterations: 25` reach
  `runAgentLoop`; the loop runs inside a given `runInSlot` and directly when
  none is given; `withInferenceSlot` is never called; the report is cut at
  4,000 characters with the note; abort gives `stopped`, a throw gives `failed`.
- `delegate.test.ts`: refuses with `ctx.subtask` set; the ninth call in one
  turn is refused; the result names the label and outcome.
- `code.test.ts`: in a read-mode child, `git log` runs without a prompt and
  `npm install` is refused without a prompt; outside a child, a read-only
  session still asks about `git log`.
- `registry.test.ts`: `delegate` offered in the Code tab, not in Shell Code
  mode or chat, and not to a child.
- `registry.test.ts` / `delegate.test.ts`: with `codeSubtasks: 'off'` the tool
  is not offered, and a call that slips through is refused naming
  Settings → Code → Subtasks.
- `parallelTools.test.ts`: three delegate calls plan into one batch; five plan
  into batches of 4 and 1.
- `system-prompt.test.ts`: parent section present only with `delegate`; child
  framing present with `subtask`.
- Guide tests in `src/lib/guide/*.test.ts` pass with the new page.
- Manual: in a dev build with Parallel streams at 1, ask the Code agent to
  investigate three separate things in this repo; confirm three delegate steps
  run in turn and the answer uses their reports.

## Commit

`feat(code): delegate read-only subtasks to child agents`

## Rollback

Revert the commit. The tool, runner and prompt sections are additive; no stored
data changes shape, so sessions saved while it was live still load (their
delegate calls are ordinary tool messages).
