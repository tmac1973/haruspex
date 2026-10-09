# Code Tab — Implementation Plan

A new **Code** tab for interactive coding sessions: a pi-style agent
transcript over Haruspex's existing coding tools, with multiple sessions,
detachable windows, and a handoff to the Shell tab for anything that needs a
real terminal (sudo, password prompts). The Shell assistant's Code button
becomes a **Read-only / Full access** toggle.

See [`overview.md`](./overview.md) for the why, the history (we have shipped a
Code tab once before), every settled decision, and the invariants.

**Status:** Planned 2026-10-08 · phases 1–9 (with 6b, 7b, 9a, 9b) merged by 2026-10-09 · phase 10 (Windows via WSL) is next, to be done on a Windows machine.

## Phase map (dependency-ordered, one stacked branch + PR per phase)

| # | File | Phase | Depends on |
|---|---|---|---|
| 1 | `phase-01-session-storage.md` | `code_sessions` table, CRUD + fork commands | — |
| 2 | `phase-02-headless-runner.md` | One-shot `run_command` for the tab; Rust background processes + watch | — |
| 3 | `phase-03-loop-hooks.md` | Steering hook in the agent loop; code tool profile decoupled from Shell | — |
| 4 | `phase-04-session-store.md` | `CodeSession` store: turns, persistence, queue, approvals, backend/effort | 1, 2, 3 |
| 5 | `phase-05-tab-ui.md` | The tab: sidebar, sub-tabs, transcript, command + diff cards, Settings → Code | 4 |
| 6 | `phase-06-shell-editor-tools.md` | `open_in_shell` (wait + report back), `open_in_editor`, clickable paths | 5 |
| 6b | `phase-06b-editor-windows.md` | Editor windows: per-folder tabs, file watching and reload, save conflicts | 6 |
| 7 | `phase-07-fork-detach.md` | Fork from message; detach / re-attach windows | 5 |
| 7b | `phase-07b-git-safe-forks.md` | Git branch in the header, worktree forks, one writer per folder, stale-file notices | 7 |
| 8 | `phase-08-shell-toggle.md` | Shell: Read-only / Full access, drop cwd persistence, "Open in Code" | 5 |
| 9 | `phase-09-hardening.md` | macOS pass, failure cases, guide sweep, follow-up issues | all |
| 9b | `phase-09b-agent-hardening.md` | Queued approval prompts, approval across windows, rewrite after a command, loop split, macOS bash + TTY | 1–8 |
| 10 | `phase-10-windows-wsl.md` | Windows, WSL only: self-contained brief with decisions and milestones (PowerShell is #396) | 9 |

Phases 1–3 are independent and can be built in parallel. 6, 7 and 8 are
independent leaves off the tab UI.

**Windows is deferred to phase 10.** Phases 1–9 target Linux and macOS; on
Windows the Code tab is hidden until phase 10 lands.

Every phase that changes something a user can see updates `docs/guide/` in the
same PR (the `Guide` check enforces it). The guide page each phase touches is
named in its file.
