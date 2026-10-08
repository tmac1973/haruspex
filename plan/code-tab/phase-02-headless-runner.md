# Phase 2 — Headless runner and background processes

**Depends on:** — · **Guide:** none yet (`no-docs`); the tab documents it in phase 5

## Goal

`run_command` works fully without a PTY: foreground through
`run_command_capture` (already does), and `background` / `watch` through a new
Rust-side process manager instead of `runInPtyBackground`.

## Foreground

Already correct when `ctx.shellSessionId == null`. Two additions:

1. **TTY-needed detection.** stdin is null, so `sudo` fails fast with
   `a terminal is required` / `a password is required`, and some tools print
   `not a tty` / `Inappropriate ioctl for device`. A small matcher in
   `code.ts` appends: *"This command needs an interactive terminal. Use
   open_in_shell to hand it to the user."* (The tool exists from phase 6;
   until then the note says to ask the user.) Matcher lives in
   `src/lib/code/ttyHint.ts` with tests over captured real outputs.
2. **Tool description** gets a code-tab variant (no "live interactive shell"
   wording). Description text is chosen by profile in phase 3.

## Background (`src-tauri/src/code_tools/background.rs`, new)

Split `code_tools.rs` (1.1k lines) into a `code_tools/` module first — pure move.

| Command | Behaviour |
|---|---|
| `code_bg_start { owner, cwd, command, memoryLimitPercent? }` | Spawns `bash -c` (same shell resolution as capture) in its own process group (unix only; Windows is phase 10), stdout+stderr → `<app_cache>/code-bg/<id>.log`. Returns `{ id, pid, log_path }`. |
| `code_bg_status { owner? }` | `[{ id, owner, command, pid, started_at, exit_code: Option }]` |
| `code_bg_tail { id, bytes }` | Last N bytes of the log |
| `code_bg_stop { id }` | SIGTERM the group, SIGKILL after 3s |
| `code_bg_stop_owner { owner }` | Used when a session closes / is deleted |

- `owner` is the code session id. The manager is a `Mutex<HashMap>` in app state;
  a reaper task `wait()`s each child and records the exit code.
- On app exit, stop everything (hook next to the sidecar shutdown).
- Register PIDs with `orphans.rs` so a crash's leftovers die on next launch.
- Log files are deleted when the process is stopped or the session deleted;
  capped at 5 MB each (truncate-front).

## Watch

Generalise `shell/backgroundWatch.ts`: a watch has either a PTY source (today)
or a `code_bg` source. For `code_bg`, poll `code_bg_status` instead of `.done`
sentinels. The completion handler is registered per owner, so the Code
session store (phase 4) gets its own follow-up turn, as the shell store does.

## Agent tools (`code.ts`)

- `run_command` with `background`/`watch` and no PTY → `code_bg_start`
  (owner = `ctx.codeSessionId`, new `ToolContext` field).
- New `command_output { id, bytes? }` → `code_bg_tail` + status line.
- New `command_stop { id }` → `code_bg_stop`.
- Both are `exec` category, so they inherit the Code-only filter.

## Tests

- Rust: start/status/tail/stop; exit code captured; group kill reaches a
  grandchild (`bash -c 'sleep 100 & sleep 100'`); stop_owner; log cap.
- TS: routing (no PTY → bg command), tty hint matcher, watch with bg source.

## Done when

A test harness can start a server in the background, read its output, get a
watch completion, and stop it, with no PTY involved.
