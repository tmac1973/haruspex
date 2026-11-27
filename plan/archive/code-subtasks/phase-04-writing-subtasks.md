# Phase 04 — Writing subtasks in worktrees

**Depends on:** 01, 02, 03 · **Enables:** phase 05 (background writing
children), phase 06 (live test)

## Goal

With Settings → Code → Subtasks at Read and write, `delegate` takes
`mode: "write"`. A writing child works in its own worktree, made by phase 03
from a snapshot of the session's folder with dependencies linked. It edits
files and runs commands under the session's approval rules. When it finishes,
its changes are applied to the session's folder under the session's write
lease: directly when they apply cleanly, through a three-way merge when that is
clean, and otherwise left alone with the patch handed to the parent. The card
shows which files were applied, or the conflict. Folders that aren't git
repositories keep read-only subtasks only.

## Files touched

- `src/lib/components/settings/CodeSection.svelte` — add Read and write to the
  Subtasks dropdown.
- `src/lib/agent/tools/delegate.ts` — `mode` enum gains `write` when the
  setting is `'write'` and the session isn't read-only; worktree lifecycle and
  apply.
- `src/lib/agent/tools/registry.ts` — the schema for `delegate` is built per
  context (the `mode` enum depends on the setting and `codeReadOnly`), at the
  same place `CODE_TAB_DESCRIPTIONS` overrides `run_command`'s schema
  (`registry.ts` ~348).
- `src/lib/code/runSubtask.ts` — `mode: 'write'` and option
  `worktree: { root, linked }`: runs in the worktree root with writes allowed,
  its own write guard, and the parent's approvals.
- `src/lib/code/runCodeTurn.ts` — `prepareSystem`'s `subtask` argument carries
  `worktree`.
- `src/lib/code/subtask.ts` — `SubtaskState.mode` widens to `'read' | 'write'`;
  `status` gains `'approval'`; new `apply` field.
- `src/lib/code/subtaskApply.ts` (new) — per-session apply mutex and result
  text.
- `src/lib/code/subtaskApply.test.ts` (new).
- `src/lib/code/system-prompt.ts` — child framing for write mode; parent
  section mentions write mode.
- `src/lib/agent/tools/code.ts` — a child's `run_command` refuses
  `background`/`watch`; `askAboutCommand` calls `ctx.onApprovalWait`.
- `src/lib/agent/tools/types.ts` — `ToolContext` gains
  `onApprovalWait?: (waiting: boolean) => void`.
- `src/lib/agent/loop.ts`, `src/lib/agent/loop/context.ts`,
  `src/lib/agent/loop/toolCalls.ts` — carry `onApprovalWait`.
- `src/lib/components/code/SubtaskCard.svelte` — applied-files list,
  conflict notice, worktree path.
- `src/lib/stores/code.svelte.ts` — `deleteSession` calls
  `discardSessionSubtaskWorktrees`.
- `docs/guide/code-subtasks.md`, `docs/guide/settings.md` — Read and write.

## Steps

1. Setting: the dropdown offers Off, Read only, Read and write
   (`'off' | 'read' | 'write'`, already the type since phase 01).
2. Schema: `delegate`'s `mode` enum is `["read", "write"]` when
   `codeSubtasks === 'write'` and `!ctx.codeReadOnly`, else `["read"]`.
   `execute` re-checks both and refuses write mode with a one-line reason
   naming Settings → Code → Subtasks, or "This session is read-only."
3. Write-mode flow in `delegate.ts`:
   1. `createSubtaskWorktree(ctx.workingDir, ctx.codeSessionId,
      ctx.wslDistro)`. A "not in a git repository" error is returned to the
      model as "Write subtasks need a git repository; use mode read, or make
      the change yourself."
   2. `runSubtask({ mode: 'write', root: wt.root, … })`.
   3. Child stopped or failed: discard the worktree, apply nothing, set
      `apply: { status: 'discarded', files: [] }`, and report "Its changes
      were not applied."
   4. Done: `subtaskWorktreeDiff(wt.path, wt.base, ctx.wslDistro)`. An empty patch gives
      `apply: { status: 'none' }` and the worktree is discarded.
   5. Otherwise, inside the session's apply mutex (`subtaskApply.ts`,
      keyed by session id, so siblings finishing together apply one at a
      time in finish order): `ctx.codeWriteGuard.acquire()`. A refusal means
      another session holds the folder; retry every 2 s until it is free or
      the child's own signal aborts (its card's stop button, or the parent's
      signal, which is linked to it). An abort keeps the worktree, sets
      `apply: { status: 'kept', files, worktree: wt.path }`, and reports "Not
      applied: stopped while waiting for the folder. The changes are in
      <path>." Then
      `applySubtaskPatch(ctx.workingDir, patch, ctx.wslDistro)`.
   6. `Applied`: `ctx.codeWriteGuard.changed(files)`, discard the worktree,
      `apply: { status: 'applied', files }`. The tool result lists the files
      after the report.
   7. `Conflict`: keep the worktree, `apply: { status: 'conflict', files,
      worktree: wt.path, message }`. The tool result gives the message, the
      conflicted files, the worktree path, and the patch passed through
      `spillIfLarge` from `agent/tools/pty-exec.ts` (large patches spill to a
      file the parent can read). It tells the parent to apply the change by
      hand.
4. `runSubtask` write mode: `codeReadOnly: false`; `workingDir` is the worktree
   root. The child gets its own `CodeWriteGuard` whose `acquire` always
   returns null, since the worktree is private. It keeps the parent's
   `codeSessionId` (so "Allow for this session" and `codeAutoApprove` apply),
   and its `requester` returns `<session title> · subtask "<label>"`, so
   approval prompts name the child. Its `onApprovalWait` sets the card's
   status to `approval` (a new `SubtaskState.status` value, shown as "Waiting
   for your approval") while `askAboutCommand` waits, and back to `running`
   after. The card's stop button stays available while it waits; stopping
   aborts the child's signal, which denies the pending prompt. The prompt itself is the existing command-approval modal, which is
   mounted app-wide, so it appears whether or not the parent's turn is still
   running. Only the child whose `run_command` is waiting is blocked; its
   siblings and the parent's batch carry on. `buildCodeSystemPrompt`'s
   `subtask` option gains `worktree?: { root: string; linked: string[] }`,
   passed through `prepareSystem`. With it, the prompt framing adds: you are working
   in a separate copy of the project at `<root>`; your changes are applied for
   you when you finish; dependency folders `<linked>` are shared, so don't
   install, upgrade or delete in them; don't commit.
5. `code.ts`: when `ctx.subtask` is set, `run_command` with `background` or
   `watch` is refused: "Subtasks can't leave processes running; run it in the
   foreground."
6. `SubtaskState` gains `apply?: { status: 'none' | 'applied' | 'conflict' |
   'discarded' | 'kept'; files: string[]; worktree?: string; message?: string }` and
   the `write` mode. `SubtaskCard` shows "Applied N files" with the list in a
   collapsible, or "Didn't apply: conflict in …" with the worktree path and a
   copy-path button; "Not applied" for `discarded`; "Kept in <path>" for
   `kept`. The compact (web) card shows the same one line.
7. `deleteSession` in `stores/code.svelte.ts` calls
   `discardSessionSubtaskWorktrees(root, id, wslDistro)` after
   `closeSession`, so worktrees kept for conflicts go with the session.
8. Prompt: the parent's `delegate` section adds: use `write` for changes that
   touch different files from each other and from what you are editing; each
   writer starts from the folder as it is now; check the applied files
   afterwards.
9. Guide: write subtasks, where they work, how changes come back, what a
   conflict means, that the kept worktree is removed with the session, and
   that they need a git repository.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
cd src-tauri && cargo test
```

## Test plan

- `delegate.test.ts` (extend, with `subtaskGit.ts` mocked):
  - write mode is absent from the schema with the setting at `'read'` and in a
    read-only session;
  - a non-git folder gives the git sentence;
  - a clean run applies, calls `changed(files)` and discards;
  - an empty patch gives `none`;
  - a conflict keeps the worktree and returns the path and patch;
  - stopped and failed runs discard without applying;
  - a refused lease retries, then applies once it is free.
- `subtaskApply.test.ts`: two children finishing together apply one after the
  other.
- `runSubtask.test.ts`: write mode passes `codeReadOnly: false`, the worktree
  root, the always-null guard, and a requester naming the subtask.
- `code.test.ts`: background and watch are refused in a child;
  `onApprovalWait` is called with true then false around a prompt.
- `SubtaskCard.test.ts`: applied and conflict states render.
- Manual: in a dev build on a scratch repo, with Subtasks at Read and write,
  ask for two edits to different files and confirm both land. Then ask for two
  edits to the same function and confirm one conflict, with the folder holding
  only the other change. Delete the session and confirm
  `<repo>-worktrees/.subtasks` is empty.

## Commit

`feat(code): subtasks that write, in their own worktrees`

## Rollback

Revert the commit. The setting value `'write'` may remain in saved settings;
phase 01's code treats any value other than `'off'` as read-only subtasks, so
it is safe. Leftover `.subtasks` worktrees can be removed with
`git worktree remove --force` or `git worktree prune` after deleting the folder.
