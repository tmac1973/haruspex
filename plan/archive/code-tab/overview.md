# Code Tab — Overview

## Goal

Make interactive coding a first-class place in Haruspex: a Code tab whose
sessions feel like a coding agent (pi, Claude Code), not a terminal with a chat
attached. Reuse the tools, checks and rendering we already have; build the
session model and the interface around them.

## History, and why this time is different

We shipped a Code tab in June 2026 (`plan/archive/haruspex-code-tab-plan.md`)
and removed it a day later (`408e44c`) in favour of Shell Code mode (#132,
`plan/archive/shell-code-mode-plan.md`), which ran the agent's commands in the
user's live terminal. That bet bought shared shell state but cost clarity:
commands appear in the user's terminal, input locks while the agent works, and
saved threads are keyed by cwd (`shell_code_sessions`), which never matched how
people think about a session.

The old tab's real gap was that it had **no way to reach a terminal**: a
`sudo` or a password prompt was a dead end. This plan closes that gap with
`open_in_shell` (phase 6), which hands one command to a Shell tab and reports
the result back. Everything else the old tab lacked — sessions, background
processes, detach, diffs — is now cheap because the Shell work built it.

## What is reused

| Need | Existing piece |
|---|---|
| One-shot command execution | `run_command_capture` (`src-tauri/src/code_tools.rs`): `bash -c` (else `sh`), timeout, process-tree kill, cancel, memory cap |
| Risk + boundary gating | `ensureCommandApproved` in `agent/tools/code.ts`, `classifyShellRisk`, `checkBoundary`, `codeCommandApproval` store + modal |
| Coding tools | `code_grep`, `code_glob`, hardened `fs_read_text` / `fs_edit_text` (fuzzy) / `fs_write_text`, lint, web research |
| Thread encoding | `shell/codeSession.ts` (moves to `code/session.ts`) |
| Rendering | `ChatMessage`, `SearchStep`, `ThinkingPanel`, `ContextGauge`, `AgentsMdBadge`, `SlashMenu` |
| Per-request model | `AgentLoopOptions.backend` (`BackendOverride`) + `reasoningEffort` |
| Inference queueing | `inferenceQueue.svelte.ts` / `inference_queue.rs` |
| Background completion turns | `shell/backgroundWatch.ts` (generalised in phase 2) |
| Editor | `editWorkdirFiles` → `FileEditorModal` (#350) |
| Tab strip + detach pattern | `ShellTabStrip`, `shell/windows.ts` |
| Open a shell at a folder | `createShellSession()` + `initialCwd` (`shell/fromChat.ts`) |
| Run-and-wait in a shell | `ShellPane.executeRunCommand`'s `completed_total` poll |

## Decisions (settled 2026-10-08)

| # | Question | Decision |
|---|---|---|
| 1 | How the tab runs commands | **One-shot bash** via `run_command_capture`. No PTY. `cd`/env don't persist between calls. |
| 2 | Commands that don't exit | **`background: true` / `watch: true`** on the Rust side: the process lives in its own group, logs to a file, can be tailed and stopped, and is killed when its session closes or the app exits. Shown as a "running" chip. |
| 3 | sudo / password prompts | **`open_in_shell`, wait and report back.** Opens a Shell tab at the session's folder with the command pre-typed (not run). The turn waits; on completion the exit code + output tail are the tool result. A one-shot command that fails for want of a TTY says to use it. |
| 4 | Editor | **Both:** paths in the transcript open the editor; the agent has a non-blocking `open_in_editor`. |
| 5 | Several sessions with work at once | **Queue** through `inferenceQueue`; the waiting session shows "queued". Tools may overlap. |
| 6 | Session ↔ folder | **Fixed at creation.** The folder is the project root and boundary for the session's life. |
| 7 | Undo / checkpoints | **Later.** Filed as a follow-up issue in phase 9. |
| 8 | Old Shell Code-mode threads | **Dropped.** `shell_code_sessions` is deleted in phase 8, no import. |
| 9 | Shell toggle names | **Read-only / Full access**, lock icon. |
| 10 | v1 pi features | **All four:** inline diffs, steering messages, per-session model, fork from message. |
| 11 | Browsing sessions | **Sidebar + sub-tabs:** sidebar lists saved sessions grouped by folder; open ones are sub-tabs. |
| 12 | What Full access keeps | **The tools, not the coding prompt.** Terminal-run commands, edits, grep/glob, approvals; shell assistant prompt; no saved threads; plus an "Open in Code" button. |
| 13 | Platforms | **Linux + macOS first; Windows last (phase 10, done), WSL only.** PowerShell/cmd support is #396. |
| 14 | Per-session model | **Backend + reasoning effort.** The local model stays global — swapping it restarts llama-server under every session. |
| 15 | Detach mid-turn | **Blocked while running.** Idle sessions detach by save → close → reopen; the database is the source of truth. |
| 16 | Settings home | **New Settings → Code**; the "Code mode" block leaves Settings → Shell. |
| 17 | Delivery | **Stacked phase branches**, one PR each. |

## Invariants

- **A session is identified by its id, never its cwd.** Nothing keys on a path.
- **The database is the source of truth** for a session's thread. The thread is
  written after every turn (power-loss rule from `codeSession.ts`), so detach,
  restart and crash recovery are all "load by id".
- **A session is open in at most one window.** Opening it elsewhere focuses the
  owner (phase 7).
- **The boundary check runs before every shortcut**, auto-approve included —
  unchanged from `ensureCommandApproved`. The session folder is the boundary.
- **Background processes never outlive their session.** Closing the tab, deleting
  the session, or quitting the app kills the process group; `orphans.rs` reaps
  leftovers on next launch.
- **`open_in_shell` never runs a command on its own.** The user presses Enter.
- **The Code tab never imports the shell store**, and vice versa, except through
  the narrow bridges in phases 6 and 8 (`openShellForCommand`, `openCodeAt`).

## Non-goals

- A terminal inside the Code tab. If a user needs one, `open_in_shell` or the
  Shell tab is the answer.
- Swapping the local model per session.
- Checkpoints / undo (follow-up).
- Running multiple sessions' inference truly in parallel (llama-server slots).
