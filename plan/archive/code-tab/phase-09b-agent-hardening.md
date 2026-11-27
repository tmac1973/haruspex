# Phase 9b — Agent and tool hardening

**Depends on:** 1–8 · **Guide:** `code.md` · **Built beside:** 9a (failure
cases and the session UI, `phase-09-hardening.md`)

## Goal

Fix what phases 4–8 left in the agent and its tools: approval prompts that
collide, an approval lost on a window move, a write guard too strict for a
coding loop, a loop module past its size limit, and two macOS gaps.

## Scope

1. **Queued approval prompts.** The command approval modal held one prompt,
   so a second session asking at once got a tool error. Queue them FIFO,
   name who is asking, and drop a stopped turn's prompt from the queue.
   Check the other approval stores for the same problem.
2. **Session approval survives window moves.** "Allow for this session"
   (`code:<id>`) lived in the window's store and reset on detach or
   re-attach.
3. **Repeat-write guard in Code sessions.** A second full write to one file
   in a turn is refused (chunked writes lose their start). In a Code session,
   allow it once a command has run since the first write.
4. **Split `agent/loop/iteration.ts`** (1,837 lines) into cohesive modules,
   as a pure refactor.
5. **macOS:** a prompt line steering away from bash-4 features (bash 3.2),
   and macOS sudo's and other common no-TTY phrasings in the TTY hint.

## As built

- **Queue:** `stores/approvalQueue.svelte.ts` `createApprovalQueue<Req,
  Res>()`: `ask(request, { signal, abortResult })`, `current()`, `size()`,
  `resolve(result)`. An abort removes the entry wherever it is and settles it
  with `abortResult`; an already aborted ask never shows. Module state, so
  each webview (main, `/code/[id]`, `/shell/[id]`) has its own queue and
  modal; no window waits behind another's prompts.
- **Command approval** (`codeCommandApproval.svelte.ts`) uses it:
  `askCommandApproval({ command, reasons, requester, signal })`, abort →
  `deny`. `getQueuedCommandApprovals()` counts those behind the shown one.
  `CommandApprovalModal` shows "Asked by **X** · N more waiting".
- **Requester:** `ToolContext.requester?: () => string` (read when the
  prompt opens, since a session is named mid-turn), threaded through
  `AgentLoopOptions` / `LoopContext`. Code: `Code · <sessionLabel>` from a
  new `CodeTurnOptions.title` getter; Shell: the tab's name
  (`ShellTurnOptions.name`).
- **Skill approval** moved onto the same queue: Chat and Shell turns can
  both write skills, and it already took a signal. **Not changed:** memory,
  MCP and sandbox approval keep a single slot. Their tools are Chat-only
  (hidden in Shell mode, absent from the Code profile), and their callers
  pass no signal, so queueing them means plumbing `ctx.signal` and
  rewriting `sandboxApproval.test.ts`'s "rejects a second ask" case; left
  for when a second consumer appears.
- **Approval carry-over:** in the claim handoff (`code/claims.ts`
  `Handoff.approved?`), not in Rust. `handOffSession` reads
  `isSessionApproved` before `dispose` resets it; `openSession` re-applies
  it when the claim's handoff says so. Closing a tab still ends it. No
  change to `code/windows.ts`.
- **Rewrite rule:** `ToolContext.filesRewritableThisTurn` (the loop makes a
  fresh set per turn, beside `filesWrittenThisTurn`). `run_command`'s
  one-shot path calls `noteCommandRan(ctx)` in a Code session, copying the
  written set into it; a successful write removes its path again, so each
  rewrite needs a fresh command. `resolveWritePathInteractive` takes
  `rewritable` in its options; `writeOptions(ctx)` passes it for Code
  sessions only. Background starts don't count. Chat and the Shell are
  unchanged.
- **Split:** `iteration.ts` keeps `runIteration` and re-exports its old
  exports; `context.ts`, `modelCall.ts`, `recovery.ts`, `finalAnswer.ts`,
  `forcedFinal.ts`, `toolCalls.ts`, `steeringQueue.ts`, `heuristics.ts`.
  Moved by line range with `export` added, no other change; loop tests
  untouched. Lint: the file-length warning goes (80 → 79 warnings overall).
- **macOS:** `code/system-prompt.ts` `isMacOS(userAgent)` (the user agent,
  as `codeTabAvailable` reads the platform) and `BuildCodePromptOpts.macOS`
  for tests. The TTY matcher already caught both macOS sudo messages; tests
  now name them, and it gains `must have a tty`, `ssh_askpass`, `stdin is
  not a terminal`, `input is not from a terminal`, `could not read
  Username/Password for`, and `/dev/tty … Device not configured`.
