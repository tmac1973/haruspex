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
