# Phase 11 — The Code tab on native Windows folders (PowerShell)

**Depends on:** 10 (merged) · **Issue:** #396 (write "Part of #396" in
commits) · **Guide:** `code-windows`, `code`, `settings`

## Goal

A Code session in an ordinary Windows folder (`C:\Users\tim\proj`), with
PowerShell as the agent's shell. Phase 10 refuses such folders ("coming
later (#396)") and only allows projects inside a WSL distro; both should
work side by side, chosen per session.

## What already works on a Windows host folder

Checked on the Windows box before writing this:

- **File tools.** `resolve_in_workdir` canonicalizes to `\\?\C:\…`, and Rust
  joins a model's `src/x.ts` onto that correctly (`/` becomes `\`; `..` is
  refused lexically). Edits keep a file's CRLF and BOM (`fuzzy.rs`).
- **Editor windows.** `notify` watches NTFS natively; the window fix in #442
  covers opening them.
- **Git.** Host git (Git for Windows); `code_tools::git::Place::Host`. The
  Windows CI job runs the git tests.
- **Shell tab with PowerShell**, its integration (`haruspex.ps1`, OSC 133),
  and a per-tab shell selection (`initialSelection`, phase 10).
- **Job objects** (`sidecar_process.rs`) for killing a process tree.
- **Console windows** hidden on every Code-tab spawn (phase 10).
- **Leases and notices** key a host folder by its canonical path.

## What is missing or wrong

1. **Session roots** are stored as `\\?\C:\…` (`std::fs::canonicalize`), and
   that spelling reaches the prompt, links, the sidebar and git.
2. **The picker** refuses a native folder (`wsl::resolve_location`), and the
   Code tab is hidden on Windows without a WSL distro.
3. **Commands.** A Code-tab command in a host folder on Windows runs
   `cmd /C` (`default_shell_command`): the model writes bash or PowerShell.
   PowerShell needs UTF-8 output, a real exit code (`$LASTEXITCODE`), and no
   progress bars in captured output.
4. **Stop and timeouts** use `taskkill /T` (fine for host processes, unlike
   `wsl.exe`), but a child that escaped the tree survives. **Background
   processes** refuse on Windows without a distro. **Memory limit** has no
   Windows mechanism.
5. **System prompt** assumes bash (or WSL); a PowerShell variant is needed.
6. **TTY hint**: the "needs a terminal" detection knows `sudo`; Windows needs
   elevation (`Start-Process -Verb RunAs`, `gsudo`, `sudo` on Windows 11 24H2).
7. **Whole-file writes** (`fs_write_text`) write LF; rewriting a CRLF file
   flips every line in git.
8. **`open_in_shell`** opens the global picker's shell; a native session
   needs a PowerShell tab at its folder. **Open in Code** from a PowerShell
   tab is refused today (#396 note).
9. **Boundary**: `$env:USERPROFILE` / `%APPDATA%` / `~` expansion exists;
   check drive-relative paths (`C:foo`) and `\\?\` spellings.

## Decisions (recommendations — confirm with the user first)

Confirmed with the user on 2026-10-10: every recommendation below stands.

| # | Question | Recommendation |
|---|---|---|
| 1 | The agent's shell | **PowerShell 7 (`pwsh`) when installed, else Windows PowerShell 5.1.** Not `cmd`. The prompt names which (5.1 has no `&&`). |
| 2 | How a session stores a native folder | `wsl_distro = NULL` and the root **without** the verbatim prefix (`C:\Users\tim\proj`, dunce-style). Local drives only in v1; network shares (`\\server\share`) refused. |
| 3 | Stop, timeout, memory limit | **A Job object per command** (one-shot and background), `KILL_ON_JOB_CLOSE`: Stop/timeout terminate the job (the whole tree, escaped children included); if Haruspex dies, Windows kills the job with it. The memory limit is the job's `JobMemoryLimit` — Windows gets it natively. |
| 4 | Running PowerShell | `pwsh -NoLogo -NoProfile -NonInteractive -Command`, with a prelude: UTF-8 output, `$ProgressPreference='SilentlyContinue'`, and the exit code from `$LASTEXITCODE` (or 1 when `$?` is false). |
| 5 | The picker | One **Location** dropdown: **This PC (Windows)** first, then each WSL distro. Windows → the native folder picker or a typed `C:\…` path. The Code tab shows on every Windows machine. |
| 6 | Line endings | A whole-file write that **replaces** a CRLF file keeps CRLF; new files are LF (as today). |
| 7 | Elevation | The TTY hint treats `Start-Process -Verb RunAs`, `gsudo` and `sudo` as needing the user, and `open_in_shell` hands them to a PowerShell tab. |
| 8 | Milestones behind a flag | The native option stays behind a dev-build flag until the last milestone, as phase 10 did. |

## Milestones (one PR each)

1. **Location.** Store native roots un-verbatim (migration: rewrite existing
   `\\?\` roots); `resolve_location` accepts a local Windows folder; picker
   (decision 5) behind the dev flag; the tab shows on every Windows machine.
2. **Commands.** PowerShell one-shot (decisions 1, 4), Job objects for
   one-shot and background (decision 3) with the memory limit, background
   processes enabled on Windows, system-prompt variant, TTY hint (decision 7).
3. **Files, git, editor.** Verify on native paths and fix what leaks `\\?\`
   (links, sidebar, git `repo_root` as `C:/…`); CRLF rewrite (decision 6);
   boundary (item 9).
4. **Hand-offs, then enable.** `open_in_shell` to a PowerShell tab at the
   folder; Open in Code from a PowerShell tab; remove the flag; guide.

**Found in milestone 2:** the Microsoft Store's PowerShell 7 (reached through
the `WindowsApps` alias, or its real path) is a packaged app, and Windows
starts it outside our Job object: no tree kill, no memory limit. The agent
therefore uses a pwsh from an MSI, winget or zip install, and Windows
PowerShell 5.1 when the Store's is the only one (`catalog::agent_powershell`).
The Shell tab is unaffected.

Unlike phase 10, most of this runs on GitHub's Windows runner, so it can be
tested in CI, not only with `#[ignore]` tests on the box.

## Hand tests (on the Windows box, after milestone 4)

1. New session → This PC → `C:\Users\tim\proj` (typed and picked): the
   header, sidebar and prompt show `C:\Users\tim\proj`, never `\\?\`.
2. Edits and commands: `$PSVersionTable`, `Get-ChildItem`, a failing
   command's exit code; a CRLF file edited and rewritten stays CRLF.
3. Stop a long command, and a background server (`python -m http.server`):
   gone from Task Manager. Quit Haruspex with one running: gone.
4. Memory limit: a command over it is stopped and reported.
5. Git branch control and a worktree fork in a native repo.
6. `open_in_shell` for an elevated command: a PowerShell tab at the folder.
   Open in Code from a PowerShell tab.
7. A WSL session and a native session side by side.

## Out of scope

- `cmd` as the agent's shell.
- Network shares as project folders.
- Running Haruspex itself elevated.
