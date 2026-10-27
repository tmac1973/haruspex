# Phase 03 — Give the slot back at once while waiting on the user

**Depends on:** phase 02 (the loop's `HeldSlot`, `toolUsesModel`, the
end-of-tools reacquire, the guide sentences) · **Enables:** closes step 1 of
#696

## Goal

A tool that stops to ask the user something gives the turn's slot back the
moment it asks, rather than 5 seconds later: a command, sandbox run, MCP call,
skill or memory write, file overwrite, email send or YouTube upload awaiting
approval, or an `ask_user_question` / MCP elicitation / task-cancel question.
A person can take hours to answer; until then other conversations, sessions
and jobs use the model. The slot comes back the way phase 02 takes it back:
when the tool batch ends, at the front of the queue.

## Files touched

- `src/lib/agent/tools/types.ts`: `releaseSlot?: () => void` on
  `ToolContext`.
- `src/lib/agent/tools/_helpers.ts`: `waitOnUser(ctx, ask)`.
- `src/lib/agent/loop/toolCalls.ts`: pass `releaseSlot` into the tool
  context, except in a batch with a model-using tool.
- Call sites, each wrapped in `waitOnUser`:
  - `src/lib/agent/tools/code.ts`: `askCommandApproval` in
    `askAboutCommand` (its context is `opts.ctx`).
  - `src/lib/agent/tools/sandbox.ts`: `askApproval`.
  - `src/lib/agent/tools/mcp.ts`: `askMcpApproval` in `resolveApproval`,
    which gains a `ctx: ToolContext` parameter passed by its caller; and the
    elicitation `ctx.askUser`.
  - `src/lib/agent/tools/skillsWrite.ts`: both `askSkillApproval` calls.
  - `src/lib/agent/tools/memoryWrite.ts`: `askMemoryApproval`.
  - `src/lib/agent/tools/youtube-upload.ts`: `askYoutubeUpload`.
  - `src/lib/agent/tools/email-compose.ts`: `askEmailReview`.
  - `src/lib/agent/tools/fs-write.ts`: `askFileConflict` in
    `resolveWritePathInteractive`. `WriteOptions` gains
    `releaseSlot?: () => void`, filled from `ctx.releaseSlot` in
    `writeOptions(ctx)`, and the call becomes
    `opts.releaseSlot?.(); const choice = await askFileConflict(relPath);`.
  - `src/lib/agent/tools/_saveGenerated.ts`: its `resolveWritePathInteractive`
    call passes `{ askBeforeOverwrite: true, releaseSlot: ctx.releaseSlot }`,
    so a picture, song or clip saved over an existing file in Chat releases
    too.
  - `src/lib/agent/tools/user-question.ts`: the `ask(...)` call (where `ask`
    is `ctx.askUser ?? askUserQuestion`).
  - `src/lib/agent/tools/tasks.ts`: its `ctx.askUser`.
- `src/lib/agent/tools/waitOnUser.test.ts` (new): the guard and the helper's
  tests.
- `docs/guide/chat-conversations.md`, `docs/guide/code.md`: extend phase
  02's sentences.

## Steps

1. **Context hook.** Add to `ToolContext`:
   `/** Give the turn's inference slot back now, while the tool waits on the
   user. The loop takes it back when the tool batch ends. */ releaseSlot?: ()
   => void;`.
2. **Loop.** In `toolCalls.ts`, `runCall` takes the batch's
   `usesModel` result. In `executeTool`'s context it passes `releaseSlot:
   ctx.slot && !batchUsesModel ? () => ctx.slot?.release() : undefined`. A
   batch with a model-using tool never releases. On a parallel lane the first
   `research_url` / `delegate` child borrows the parent's slot without a
   ticket (`createSlotLender`), and releasing it then would let the gate
   admit another turn while the child still uses the slot.
3. **Helper.** In `_helpers.ts`:
   ```ts
   /** Ask the user something, giving the turn's slot back while they decide. */
   export function waitOnUser<T>(ctx: ToolContext, ask: () => Promise<T>): Promise<T> {
   	ctx.releaseSlot?.();
   	return ask();
   }
   ```
   It releases before asking, so the slot is free for as long as the prompt
   is up. A user who answers within a second gets the slot back at the end of
   the batch, at the front of the queue; on a quiet lane that is immediate.
4. **Call sites.** Wrap each ask listed under Files touched, e.g.
   `choice = await waitOnUser(opts.ctx, () => askCommandApproval({...}))` in
   `code.ts`, and `const answer = await waitOnUser(ctx, () => ask(...))` in
   `user-question.ts`. In `code.ts` the `onApprovalWait` calls stay where
   they are, and the helper sits inside the existing `try`. `fs-write.ts`
   reaches no `ToolContext` at the ask, so it calls `opts.releaseSlot?.()`
   directly, as above.
5. **Not covered, on purpose.**
   - `askRepoTrust` (`skills/project.ts`, through `trustedProjectRoot`) runs
     while a Code turn is set up, before `withInferenceSlot`, so it holds no
     slot.
   - `delegate`'s foreground children run in their parent's slot with no
     `HeldSlot` of their own, so their `releaseSlot` is undefined. A child
     that asks (it may only read, so this is rare) keeps the parent's slot,
     which belongs to the parent's `delegate` call.
   - The Code tab's hand-off to a Shell tab (**Waiting for you in Shell N**)
     waits inside the command tool and is covered by phase 02's 5-second
     release.
6. **Guard test.** `waitOnUser.test.ts` reads every non-test
   `src/lib/agent/tools/*.ts` (`import.meta.glob(..., { query: '?raw' })`). For
   each line that calls `askCommandApproval(`, `askApproval(`,
   `askMcpApproval(`, `askSkillApproval(`, `askMemoryApproval(`,
   `askYoutubeUpload(`, `askEmailReview(`, `askUserQuestion(` or
   `ctx.askUser(`, it asserts that the line, or the one before it, contains
   `waitOnUser(`. Two special cases: in `user-question.ts` the call is
   `ask(`, so the test also requires `waitOnUser(` within the two lines
   before `ask(`; in `fs-write.ts`, `askFileConflict(` requires
   `releaseSlot` on the line before; and every `resolveWritePathInteractive(`
   call outside `fs-write.ts`'s definition must have `writeOptions(ctx)` or
   `releaseSlot` within its next three lines. The helper's own tests check that
   `releaseSlot` is called before `ask`, and that a context without
   `releaseSlot` just asks.
7. **Guide.** In `docs/guide/chat-conversations.md`, extend phase 02's
   sentence so it also names the first conversation waiting for you to
   approve something or answer a question. In `docs/guide/code.md`, change
   phase 02's "while a tool runs over a few seconds." to "while a tool runs
   over a few seconds or waits for you." Both stay single sentences, and
   `code.md` stays under 6,000 bytes (about 5,970 after this; check with
   `wc -c`).

## Build gate

- `npm run check`, `npm run lint` (no new warnings), `npm run format:check`,
  `npm run test`
- the `Guide` check passes

## Test plan

- `waitOnUser.test.ts`, as in step 6.
- `toolCalls.test.ts`: a tool that calls `ctx.releaseSlot()` at once gives
  `release` immediately (no 5 s wait, fake timers) and `reacquire` at the end
  of the batch. A later `release` from the 5 s timer is a no-op on the fake.
  In a batch with `research_url`, `ctx.releaseSlot` is undefined.
- `fs-write` test: an overwrite prompt calls `releaseSlot` first; the same
  through `_saveGenerated`.
- `mcp` test: `resolveApproval` with a context releases before asking.
- Existing tests for `code.ts`, `sandbox.ts`, `mcp.ts`, `skillsWrite.ts`,
  `memoryWrite.ts`, `youtube-upload.ts`, `email-compose.ts`, `fs-write.ts`,
  `user-question.ts` and `tasks.ts` still pass; a context without
  `releaseSlot` behaves as before.
- **Live, dev build, local llama-server, Settings → Inference → Parallel
  streams at 1:**
  - A Code session asks to run a risky command (`rm -rf ./tmp-test`) without
    Auto-approve. While **Run this command?** is open, a Chat conversation
    answers. After **Allow once**, the Code turn continues.
  - In Chat, ask for something that makes the model call
    `ask_user_question`. While the question is open, a second conversation
    answers.
  - Stop a Code turn while its approval is open: the prompt goes away, the
    turn ends, and no ticket for it is left in the queue snapshot.

## Commit

```
feat(agent): give the inference slot back while a tool waits on the user

Phase 03 of plan/release-slot-during-tools (#696).
```

## Rollback

Revert the commit. Waits on the user then fall back to phase 02's 5-second
release, which still frees the slot, only later.
