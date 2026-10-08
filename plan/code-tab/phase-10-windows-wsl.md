# Phase 10 — Windows, WSL only

**Depends on:** 9 · **Guide:** `code.md` (Windows section), `getting-started.md`

## Goal

Ship the Code tab on Windows for projects that live **inside a WSL distro**.
Native Windows folders (PowerShell / cmd) are out of scope and tracked as a
follow-up issue. Until this phase lands, the tab is hidden on Windows.

## Scope

- **Gate:** on Windows the tab appears only when at least one WSL distro is
  installed (reuse the Shell's WSL detection in `src-tauri/src/shell/wsl.rs`).
  No distro → tab hidden, as in phases 1–9.
- **Session root is a distro + Linux path.** Migration adds
  `wsl_distro TEXT` to `code_sessions` (nullable; always NULL off Windows).
  The new-session dialog lists distros and accepts a Linux path; a picked
  `\\wsl.localhost\<distro>\…` / `\\wsl$\<distro>\…` folder is converted to
  distro + path. A plain Windows path is refused with one sentence pointing
  at the follow-up.
- **Tools:** `shellWslDistro(ctx)` in `code.ts` returns the session's distro in
  the Code tab too (today it does only in shell mode), so `run_command_capture`,
  `code_grep` / `code_glob` and the fs tools take their existing WSL route
  (`ShellSelection::Wsl`, `resolve_code_root`).
- **Background processes:** start through `wsl.exe -d <distro> --cd <root> --
  setsid bash -c …` and record the Linux-side pgid (echoed first on the log).
  Killing `wsl.exe` doesn't reach the Linux tree, so stop runs
  `kill -TERM -- -<pgid>` (then `-KILL`) inside the distro. Logs live in the
  distro's `/tmp`, tailed through `wsl.exe`. Orphan reaping does the same.
- **`open_in_shell`:** opens a WSL shell tab for the same distro at the root
  (the Shell tab's Windows/WSL support from phase 17 of the shell plans).
- **Boundary checks:** re-test against the Windows path gotchas in memory —
  verbatim `\\?\` canonicalization defeating `..` checks, and Unix-absolute
  paths failing `is_absolute()` on the Windows side.

## Verification

Windows CI is opt-in: label the PR `windows-ci` and push again. Hand-test on a
real Windows machine with Ubuntu under WSL: start a session, edit, run, start
a background dev server, stop it, sudo via `open_in_shell`, detach.

## Follow-up (filed now)

PowerShell / cmd support for native Windows folders: tmac1973/haruspex#396.
