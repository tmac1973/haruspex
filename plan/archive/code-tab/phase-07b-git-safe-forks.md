# Phase 7b — Git awareness and safe forks

**Depends on:** 7 · **Guide:** `code-sessions` (forks, worktrees, sharing a
folder), `code` (the branch control)

## Goal

Make two sessions working on one project safe. Show git state where it
matters, let a fork take its own worktree, and stop sessions that share a
folder from overwriting each other.

## Decisions (2026-10-09)

| # | Question | Decision |
|---|---|---|
| 1 | Git detection | `git` on `PATH`, checked once; per session, the repo root via `git rev-parse --show-toplevel` in its folder. No git → no git UI, nothing else changes. |
| 2 | Header | Branch shown right of the folder, with ● when the tree has uncommitted changes. Refreshed after each turn and when the tab gains focus. Detached HEAD shows the short hash. |
| 3 | Branch dropdown | **Switch + create.** Lists local branches; switching only while the session is idle and the tree is clean, otherwise "commit or stash first" (git's own rule, no auto-stash). "New branch…" creates one from HEAD and switches to it. Warns when another open session shares the folder. |
| 4 | Fork in a git repo | Modal: **New worktree** (recommended) or **Same folder, read-only**. |
| 5 | Worktree location | **Next to the repo**: `../<repo>-worktrees/<branch>`, branch named from the fork's title (slugged, de-duplicated). Inside-repo locations are avoided because tools resolve the parent project's config from there. |
| 6 | Fork outside git / no git | **Read-only** fork: read, search and web tools; `run_command` asks for approval on every command (a "harmless" command can still write). The header says it is read-only and why. |
| 7 | Sessions sharing a folder | **One writer at a time** for every session, not just forks: while one session in a folder (worktrees are separate folders) is mid-turn, another session's write/edit tools are refused with "another session is editing this folder" — they take turns. |
| 8 | Awareness | **Stale-file notices**: when a session's turn changes files, other sessions in that folder get a note at the start of their next turn naming the files and the session. No model-to-model chatter. |
| 9 | Worktree cleanup | Deleting a worktree session offers to remove the worktree when it has no uncommitted changes; otherwise it says so and keeps it. |

## Notes

- A new worktree has no ignored files (`node_modules`, `.env`, build output).
  The fork's prompt says so, so the agent sets up dependencies before
  building or testing.
- Merging a fork's work back is ordinary git; no merge UI in this phase.
- Windows: git detection runs through the session's shell routing; the WSL
  case lands with phase 10.

## As built

- **Git** (`code_tools/git.rs`): runs the user's `git` as a child process
  (no new crate): `-C <folder>`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`,
  `GIT_OPTIONAL_LOCKS=0` on reads, a 20 s timeout (120 s for `worktree add`),
  `kill_on_drop`. `git --version` is checked once (`OnceLock`). Status is one
  `rev-parse --path-format=absolute --show-toplevel --git-common-dir
  --git-dir` plus `status --porcelain=v2 --branch -z`: `GitStatus { repo_root,
  branch (None = detached), head (short), changed, untracked,
  linked_worktree }`; not a repo or no git → `null`. Commands:
  `code_git_status`, `code_git_branches`, `code_git_switch` (`switch
  --no-guess`), `code_git_create_branch` (`switch -c`), and
  `code_git_worktree_remove`. Branch names go through `check-ref-format
  --branch` and may not start with `-`. Errors are git's own stderr.
- **Branch control** (`CodeBranchControl.svelte`, right of the folder):
  branch or short hash, ● for tracked *or* untracked changes. Refreshed by
  the store after every turn and on adopt, on mount, on window `focus`, and
  when the menu or the fork dialog opens. Switching is disabled while busy
  or with *tracked* changes (`switchBlockedReason`); untracked files alone
  don't block it — git refuses if one would be overwritten, and that text is
  the toast. **New branch…** only waits for idle. The "also open here"
  warning uses the new `code_session_open_ids` (claims of live windows, so
  detached windows count) against the saved list, by folder overlap with the
  repo root.
- **Fork modal** (`ForkDialog.svelte`): **New worktree** (autofocused) /
  **Same folder, read-only** in a repo; outside git one **Fork read-only**
  with the reason. `code_session_fork` now takes `mode: 'readOnly' |
  'worktree'` (`CodeForkMode`). **Divergence:** phase 7's writable
  same-folder fork is gone — a fork in the same folder is always read-only.
- **Worktree fork** is done in Rust inside `code_session_fork`, so it is
  one call: load the source, `add_fork_worktree(source.root,
  fork_title)`, then insert the row rooted there
  (`fork_code_session_into`); if the insert fails the worktree and its
  branch are removed again. Location is `<main>-worktrees/<slug>` where
  `<main>` is the *main* worktree (parent of the common `.git`), so a fork of
  a worktree fork lands beside the repo too. The slug comes from the fork's
  title (`fix-login-fork`), de-duplicated against branches and folders
  (`-2`, `-3`…). The new branch starts at the source checkout's HEAD.
  The session is rooted at the same subfolder inside the worktree when it
  exists there, else at the worktree top.
- **DB:** `code_sessions` gains `read_only INTEGER NOT NULL DEFAULT 0` and
  `worktree TEXT` (idempotent ALTERs, as phase 1), on the row and the
  summary.
- **Read-only:** `ToolContext.codeReadOnly` / `getToolSchemas({
  codeReadOnly })`. The registry drops `fs_write_*`, `fs_edit_text`,
  `make_asset` (`isCodeWriteTool`) and, beyond the plan, the skills-write
  tools; `executeTool` refuses them too (a model can call a tool it wasn't
  offered). `run_command` refuses `background`/`watch` before asking, then
  always asks (reason "read-only session", plus any risk reasons), ignoring
  auto-approve and session approval, and never remembers "for this
  session". The prompt says it is read-only and leaves out the write tools.
  Header badge **Read-only** with a `title`.
- **Writer lease** (`code_tools/folders.rs`, `CodeFolders`): session id →
  `{ folder (canonical), title, window }`. Two folders conflict when one
  is the other or inside it (component-wise), so a session in a subfolder
  can't slip past one at the repo root; sibling worktrees never conflict.
  A lease whose window is gone is dropped on the next take;
  `WindowEvent::Destroyed` drops a window's leases. TS side
  `createWriteGuard` (`code/folders.ts`) is the turn's
  `ToolContext.codeWriteGuard`: the first write takes the lease and keeps
  it for the turn; `finish()` (the store's `finally`, so error and abort
  too) records notices then releases; `dispose` releases again. Writes and
  edits are guarded centrally in `executeTool`; `run_command` takes it
  before asking for approval unless `isReadOnlyCommand` (a conservative
  allowlist: `ls`, `cat`, `grep`, `git status/log/diff/…`, `find` without
  `-delete`/`-exec`, no `>` or `$(…)`). Background commands always take it.
  A read-only session's approved command takes it too.
- **Stale-file notices** (same module): `code_notice_record` at turn end
  with absolute paths from successful `fs_write_*` (the turn's written set)
  and `fs_edit_text` (result starts with "Edited"); `make_asset` takes the
  lease but its file isn't reported. `code_notices_take { since }` returns
  other sessions' notices in overlapping folders after `since` and a `now`
  to pass next; times strictly increase, so nothing recorded in the same
  millisecond is lost. A session's first `since` is its `updated_at` (its
  last saved turn). Kept in memory, 24 h / 200 max. The note ("Since your
  last turn, session 'X' changed: a.ts, b.ts", per session, 20 files then
  "and N more") is put ahead of the opening message *sent* to the model
  only (`withNotice`), not saved in the thread, and shown as a transcript
  note above that message (`session.fileNotes`, not saved).
- **Delete with a worktree:** the sidebar's delete dialog shows **Also
  remove its worktree** (ticked) when the row has `worktree` and no other
  saved session's root is inside it. `deleteSession(id, { removeWorktree
  })` returns `{ worktree: WorktreeRemoval | null }`; Rust removes only a
  linked worktree (never the main one) that has no changed or untracked
  files, from the main repo; the branch stays. The outcome is a toast.
- **Not done:** notices don't survive a restart; command side effects are
  not tracked (by design); there is no merge UI; git detection on Windows
  waits for phase 10.
