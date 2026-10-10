# Phase 10 — The Code tab on Windows, through WSL

**Depends on:** 1–9 (all merged) · **Guide:** `code`, `code-sessions`,
`getting-started`, `settings` · **Follow-up:** native PowerShell folders are
#396 · **Tracking:** #413 (write "Part of #413" in commits, never "Closes")

This file is meant to be handed to Claude on a Windows machine as-is:
"implement `plan/code-tab/phase-10-windows-wsl.md`". It is self-contained.

## Goal

Ship the Code tab on Windows for projects that live **inside a WSL2 distro**
(`/home/<user>/proj` in Ubuntu, say). Every Code-tab feature — commands,
background processes, file tools, git and worktree forks, editor windows,
`open_in_shell`, leases and notices — runs against the distro, not against
Windows. Native Windows folders (`C:\…`) are refused with a pointer to #396.
Until this lands the tab is hidden on Windows (`codeTabAvailable`).

## Before you start (for the implementing session)

1. Read `CLAUDE.md`, `plan/code-tab/README.md`, `overview.md`, and the **As
   built** sections of every `phase-*.md` here — phases 2–9 are where the
   Unix-only assumptions below came from.
2. **Confirm the Decisions table with the user** (ask, one round, with the
   recommendations as defaults) before writing code. Record any change in it.
3. Work milestone by milestone (below), one branch + PR each, CI green
   (add the `windows-ci` label to every PR — the Windows job is opt-in).
4. House rules learned the hard way:
   - `node scripts/guide-check.mjs < /dev/null` (it reads stdin; hangs otherwise).
   - Never run Prettier on `docs/guide/*.md` (it pads tables → breaks
     `src/lib/guide/pages.test.ts` and the 6000-byte page limit); run
     `npx vitest run src/lib/guide` after any guide edit.
   - Run the Playwright suite (`npx playwright test --grep-invert visual`)
     after changing what a turn sends — fake-LLM scenarios match on it.
   - `./scripts/export-ipc-types.sh` after any Tauri command change.
   - Conventional Commits; PR titles' subject starts lower-case.

## Setting up the Windows machine

- Run `scripts/windows-setup.ps1` (elevated PowerShell): Git + Git Bash,
  Node LTS, Rust MSVC, VS 2022 C++ Build Tools, CMake, LLVM, Python, Vulkan
  SDK, WebView2, PowerShell 7, WSL2 (`wsl --install --no-launch`). Reboot.
- Launch Ubuntu once to create the Linux user. Inside it:
  `sudo apt install git build-essential` (+ the test project's toolchain,
  e.g. `python3`, `nodejs`). Optional: `systemd=true` in `/etc/wsl.conf`.
- In **Git Bash**, from the repo: `./scripts/dev-setup.sh` (builds or fetches
  sidecars, incl. the `x86_64-pc-windows-msvc` ones), then
  `npm run tauri dev`. `make` isn't installed by the script; run the npm
  commands directly.
- Make a test project inside the distro, e.g. `~/wsl-proj` with a git repo
  and a small Python or Node app.

## What already exists (reuse it)

| Need | Where |
|---|---|
| WSL distro list (v2 only, UTF-16 parsed) | `src-tauri/src/shell/catalog.rs` `enumerate_wsl` (private; reached via `shell_list_shells`) |
| Shell selection type | `src-tauri/src/shell/kind.rs` `ShellSelection::Wsl { distro }` (`wsl.exe -d <distro>`) |
| One-shot command in a distro | `src-tauri/src/code_tools/mod.rs` `build_shell_command` `Wsl` arm: `wsl.exe -d <d> --cd <cwd> -- bash -c <cmd>` |
| Linux path → Windows-reachable path | `src-tauri/src/fs_tools/absolute.rs` `require_absolute` (`/mnt/<d>/…` → `D:\…`; `/home/…` → `\\wsl.localhost\<distro>\home\…`), `display_path` back |
| WSL-aware fs tools | the `*_absolute` commands in `absolute.rs` (all take `wsl_distro`); grep/glob in `code_tools/search.rs` (`resolve_code_root`) |
| Hide console windows | `src-tauri/src/shell/platform.rs` `apply_no_window` |
| Shell integration inside WSL | `shell/pty.rs` `plan_wsl` (injects `haruspex.bash` via `--rcfile`); OSC 133/7 parsing is platform-agnostic, so `open_in_shell` completion detection works |
| Windows git path fix pattern | archived `plan/archive/phase-17-shell-tab-windows.md` |

## What is Unix-only or wrong on Windows today

Grouped by area; each needs a change. (Line numbers are as of main
`3afc2ca` and will drift — search for the symbol.)

1. **No per-session distro.** The Code tab passes the Shell tab's *global*
   `settings.shellSelection` to `run_command_capture`
   (`src/lib/agent/tools/code.ts` `runHostCommand`) and grep/glob only get a
   distro in shell mode (`shellWslDistro`). On Windows today, Code commands
   would run in whatever the Shell picker last chose (PowerShell, WSL, or
   `cmd /C`).
2. **File tools.** The Code tab (`shellMode: false`) uses the workdir-relative
   fs commands → `resolve_in_workdir` (`fs_tools/path.rs`), which has no
   distro. A model path `/home/u/proj/x.ts` isn't `is_absolute()` on
   Windows and gets joined onto a `\\?\UNC\…` root, where `/` isn't a
   separator. Editor commands (`fs_tools/editor.rs`) use the same resolver.
3. **Session roots.** `code_session_create` / `code_session_set_root`
   (`db/code_sessions.rs`) `std::fs::canonicalize` → `\\?\C:\…` or
   `\\?\UNC\wsl.localhost\…`; `\\wsl$\` and `\\wsl.localhost\` spellings of
   one folder differ. No distro column. `code_folder_exists` is a plain
   `is_dir`.
4. **Background processes** (`code_tools/background.rs`): `code_bg_start`
   refuses on Windows; when enabled it would spawn `cmd /C`. Stop is
   `taskkill /T`, which kills only the `wsl.exe` relay — the Linux tree keeps
   running. Same for the one-shot runner's timeout/cancel
   (`kill_process_tree`). The orphan sweep matches the `wsl.exe` command line
   but killing it doesn't reach the distro. Tests are `#[cfg(unix)]`.
5. **Git** (`code_tools/git.rs`) runs host `git -C <dir>`. Over
   `\\wsl.localhost` that is slow, trips "dubious ownership", and
   `worktree add` writes *Windows* paths into `.git/worktrees/*/gitdir`,
   breaking the user's Linux git. `skills/origin.rs` `common_dir` and
   `skills_project_root` (AGENTS.md / repo trust) walk host paths too.
6. **Leases and notices** (`code_tools/folders.rs`, `db/code_notices.rs`,
   `src/lib/code/folders.ts`): keyed by host-canonical paths; the TS helpers
   join and compare with `/` (`absolutePath`, `relativeTo`, `rootsOverlap`).
7. **Editor windows** (`fs_tools/editor.rs`): `notify` uses
   `ReadDirectoryChangesW`, which doesn't see changes made inside Linux over
   9P; a failed watch is only `warn`-logged, so the window silently never
   reloads.
8. **`open_in_shell`** (`src/lib/shell/openForCommand.ts`): the new Shell tab
   spawns with the global selection, and a Linux `cwd` fails `is_dir` in
   `shell/pty.rs` and falls back to `USERPROFILE`. `kind.rs`'s WSL spec
   doesn't use `--cd`. The Shell's **Open in Code** sends only a cwd string
   (`code/bridge.ts` `openCodeAt`), no distro.
9. **Paths in the UI** (`src/lib/code/paths.ts` `relativeToRoot`): broken for
   any Windows root (verbatim prefixes collapse), so links and
   `open_in_editor` are refused. `CodeSessionHeader`'s `open_folder` gets a
   verbatim path.
10. **System prompt** (`src/lib/code/system-prompt.ts`): platform comes from
    the user agent; a WSL session needs its own line (Linux, distro name,
    Windows `PATH` leak of `*.exe`), and must not get the macOS bash 3.2 line.
11. **Console windows**: the Code tab's spawns (`run_command_capture`,
    `git.rs`, `background.rs`, `taskkill`) don't set `CREATE_NO_WINDOW` →
    console flashes. `wsl.exe`'s own errors are UTF-16 and come out garbled.
12. **Memory limit** (`command_scope.rs`): `systemd-run` is host-Linux only;
    nothing on Windows.
13. **Boundary check** (`src/lib/shell/boundary.ts`): protected paths are
    Windows-form; a WSL command naming `/mnt/c/Users/<u>/AppData/…` isn't
    caught, and `~` expands to the Windows home.
14. **Windows CI is already red** on Code-tab tests:
    `code_tools::git::tests::status_reports_the_branch_and_changes` (git
    returns `C:/…`, test expects `\\?\C:\…`) and
    `db::tests::code_session_root_can_be_pointed_at_another_folder`
    (`\\?\C:\…` vs `C:\Users\RUNNER~1\…`; also fails on macOS:
    `/private/var` vs `/var`).
15. **Unrelated bug found on the way:** `make_asset` in the Code tab calls
    `resolveShellPath(path, ctx.shellCwd)` with a null `shellCwd` and the
    global distro — fix in passing.

## Decisions (recommendations — confirm with the user first)

Confirmed with the user on 2026-10-09: every recommendation below stands
as written.

| # | Question | Recommendation |
|---|---|---|
| 1 | How a session stores where it is | **`wsl_distro` column + Linux root** (`/home/tim/proj`). Canonicalize *inside* the distro (`wsl.exe -d <d> -- realpath -e <path>`), never with `std::fs::canonicalize`. NULL distro = a host session (Linux/macOS today). One canonical form ends `\\?\` / `wsl$` aliasing and keeps prompts, links, git and keys natural. |
| 2 | The folder picker on Windows | Distro dropdown + Linux path field with **Browse…** that accepts an Explorer pick of `\\wsl.localhost\<d>\…` or `\\wsl$\<d>\…` and splits it into distro + path. A plain `C:\…` is refused ("Native Windows folders are coming later — #396"). `/mnt/c/…` inside a distro: allowed with a one-line "slow: files are on Windows" note. |
| 3 | The tab gate | `codeTabAvailable` becomes a cached async probe: Windows → at least one WSL2 distro (expose `enumerate_wsl` through a small command); others unchanged. Tab bar, `mainTabs` and the persisted active tab handle "not known yet" at startup. Open in Code follows the same gate. |
| 4 | Threading the distro | `ToolContext.wslDistro` (and `CodeTurnOptions`), from the session. Every Code-tab call passes it: `run_command_capture` (as `ShellSelection::Wsl`), `code_bg_*`, grep/glob, fs tools, editor commands, git, leases, `code_folder_exists`. **Stop reading the global `shellSelection` in the Code tab** (also a latent bug on Linux). |
| 5 | File-tool route | A Rust **`CodeRoot { distro: Option<String>, root }`** with `resolve(rel_or_abs)`: does the `..` / containment check on the *Linux* path lexically, then maps through `require_absolute` for the actual I/O. Used by the Code tab's fs, editor and search commands (new commands or an optional `distro` arg on the existing ones). Re-prove the escape checks over 9P (symlinks resolve inside the distro: `realpath` when needed). |
| 6 | Killing commands in WSL | Run every distro command under `setsid` and print the pgid first (`setsid bash -c 'echo $$; exec …'` style). Timeout/cancel/stop: `wsl.exe -d <d> -- kill -TERM -- -<pgid>`, then `-KILL` after 3 s. Store distro + pgid in `BgProcess` and the orphan registry; "alive" via `kill -0 -- -<pgid>`. `stop_all` on exit: one `wsl.exe` per distro with all pgids. |
| 7 | Background logs | Keep piping through `wsl.exe` to host `<app_cache>/code-bg/<id>.log` (the cap, tail and watch code is unchanged). Verify the Linux side survives the relay ending only when we kill it. |
| 8 | Editor watcher for WSL files | `notify::PollWatcher` (≈2 s) for distro roots; the save-time hash conflict check stays the real guard. In-distro `inotifywait` is a later improvement. A failed watch shows a quiet "Live reload unavailable" note instead of only logging. |
| 9 | Git | Run inside the distro: `wsl.exe -d <d> --cd <linux root> -- git …` with env set via `env VAR=…` in the command. `GitStatus.repo_root` and worktree paths are Linux paths, compared as strings in the session's (distro, path) space. "Git installed" is checked per distro. Worktrees go beside the repo inside the distro. |
| 10 | `open_in_shell` / Open in Code | Add a per-request `selection` + `cwd` override to the Shell spawn (`ShellCommandRequest`, `createShellSession`, `Terminal.svelte`), and `--cd <linux path>` in `kind.rs`'s WSL spec — without touching the global picker. The Shell's Open in Code sends `{ distro, cwd }` when the Shell tab is a WSL tab. |
| 11 | Memory limit in WSL | None in v1; Settings → Shell → Memory limit says it applies to Linux and macOS hosts only. (Later: in-distro `systemd-run --user --scope` when the distro has systemd.) |
| 12 | Boundary check | For WSL sessions add the `/mnt/<d>/…` spellings of the app's protected dirs; `~`/`$HOME` mean the distro home. Note WSL2 NAT: `localhost` in the distro isn't the host's loopback unless mirrored networking is on. |
| 13 | Repo trust / AGENTS.md key | Key WSL repos as `wsl:<distro>:<linux root>`; `skills_project_root` / `common_dir` learn the distro (run `git rev-parse` in the distro). Same key from the Shell tab's WSL sessions. |
| 14 | Console windows and wsl.exe output | `apply_no_window` (tokio `creation_flags(CREATE_NO_WINDOW)`) on every Code-tab spawn; set `WSL_UTF8=1` on `wsl.exe` calls so its own errors decode. |
| 15 | CI | Milestone 0 fixes the two red tests (compare canonicalized on both sides, or strip verbatim prefixes `dunce`-style). WSL integration tests: `#[ignore]` + run on the self-hosted Windows PC (`scripts/ci-runner/`), since hosted runners have no distro; unit-test the pure parts (path mapping, pgid parsing, UNC parsing) everywhere. |

## Milestones (one PR each, in order)

0. **CI green on Windows (and macOS).** Fix the two failing tests (item 14).
   No feature change. Label `windows-ci`.
1. **Session location.** Migration: `code_sessions.wsl_distro`. Rust
   `CodeRoot` + in-distro `realpath`; UNC ↔ (distro, Linux path) parser;
   `code_session_create` / `set_root` / `code_folder_exists` take a distro.
   Picker (decision 2). Gate probe (decision 3) — tab still behind a dev
   flag until milestone 5 so main never ships a half-working tab.
2. **Commands.** Thread `wslDistro` (decision 4); one-shot runner via the
   session's distro; `setsid` + pgid kill (decision 6); background processes
   and the orphan registry (decisions 6–7); `CREATE_NO_WINDOW` + `WSL_UTF8`
   (decision 14); boundary (decision 12); system-prompt WSL line (item 10);
   memory-limit wording (decision 11). Fix `make_asset` (item 15).
3. **Files.** `CodeRoot.resolve` for fs tools, grep/glob and editor commands
   (decision 5); `paths.ts` / `folders.ts` helpers in (distro, Linux path)
   space (items 6, 9); `PollWatcher` for distro roots (decision 8); leases
   and notices keyed by (distro, path).
4. **Git and trust.** Git in the distro (decision 9), worktree forks beside
   the repo in the distro, branch control; repo trust / AGENTS.md key
   (decision 13).
5. **Shell handoffs, then enable.** Per-request shell selection + `--cd`
   (decision 10); `open_in_shell` and Open in Code both ways. Remove the
   dev flag: the tab appears on Windows when a WSL2 distro exists. Guide:
   `code` / `code-sessions` (Windows section, what isn't supported),
   `getting-started` and `code.md`'s "Not on Windows yet" line, `settings`
   (memory limit); `docs/maintenance.md`'s Windows/WSL section.

## As built

Milestones 0–5 shipped as #426, #427, #430, #433, #435 and the milestone 5
PR. What differs from the decisions above, and what the box taught us:

- **Never kill a `wsl.exe` relay.** `taskkill /T` on one, and later a plain
  `taskkill /F` on one whose distro was still booting while another
  `wsl.exe` started beside it, left the WSL service failing every call
  (`Wsl/Service/E_UNEXPECTED`) until `wsl --shutdown`. Reproduced only under
  parallel load on a cold distro; bisected on the box. Now
  `wsl::GroupState`: a stop signals the Linux group when it is known, and
  otherwise marks the command so whoever reads the group kills it on
  arrival. The relay ends on its own; the runner waits at most 30 s for it
  and WSL children are never `kill_on_drop`.
- **Decision 6 details:** every distro command is `wsl.exe -d <d> --exec
  setsid -w bash -c <wrapper> haruspex <cmd> <cwd>`. `--exec`, not `--`
  (which re-parses the joined arguments in the distro's shell). The wrapper
  `cd`s itself: `wsl.exe --cd` silently runs in `/` when the folder is gone.
  The group id is the first stderr line (`wsl::PgidReader`). The stop and
  sweep scripts run under bash: dash's `kill -- -<pgid>` is "Illegal
  number". A cancelled WSL command reports exit 128+n, so `killed` comes
  from a cancel flag too.
- **Decision 5 as built:** no `CodeRoot` struct. A WSL session hands the
  workdir-relative fs commands its root as `\\wsl.localhost\<d>\…`
  (`ioRoot`/`fsWorkdir`), and `resolve_in_workdir` sends such a workdir to
  `wsl::resolve_in_share`, which checks the Linux path lexically. Windows
  does **not** follow Linux symlinks on the share at all (not even inside
  the project), so a path goes to the distro's `realpath -m` only when a
  symlink is in the way ("file not found", OS error 2, means its folder is
  real). A bare Linux workdir is refused on Windows: it used to become
  `C:\home\…`, and writes created it.
- **Leases and notices** key a WSL folder as `wsl:<distro>:<path>` (Rust
  `folders::key`, TS `rootsOverlap` with distros).
- **Decision 8:** `notify::PollWatcher` every 2 s for share folders;
  `EditorFile.live` shows "Live reload unavailable" for a folder that can't
  be watched, on every platform.
- **Decision 9:** `code_tools::git::Place` (`Host` / `Wsl(distro)`); the
  `Path` functions stay as test wrappers. Worktree `.git` files name Linux
  paths.
- **Decision 13:** trust key `repoKey(root)` = `wsl:<distro>:<linux root>`.
  The skills code reads the repo through the share, so it needed no distro.
  A Shell tab on a WSL distro finds its repo the same way now (it found
  none before).
- **Decision 10:** `ShellSession.initialSelection` and Terminal's
  `selection` prop; `--cd <linux cwd>` is added in `shell::spawn_session`
  (not in `kind.rs`). Open in Code sends the distro when the shell's cwd is
  a Linux path.
- **`WSL_UTF8`:** `wsl.exe -l -v` prints UTF-8 when `WSL_UTF8=1` is set in
  the user's environment; the distro list now decodes either, or the tab
  would never appear for them.
- The Code tab shows on Windows when `code_wsl_distros` finds a distro
  (`probeCodeTab`, from the root layout); the dev-build flag is gone.
- Guide: new `code-windows` page; `docs/testing.md` says how to run the
  `#[ignore]` WSL tests.

## Hand tests (on the Windows box, after milestone 5)

1. Fresh install with WSL but no distro: no Code tab. Install Ubuntu, restart:
   the tab appears.
2. New session → pick Ubuntu + `~/wsl-proj` (typed, and again via Browse… on
   `\\wsl.localhost\Ubuntu\home\…`): same session root both ways. `C:\temp`
   is refused with the #396 note.
3. Ask for an edit and a command: the diff card and command card are right;
   `uname -a` reports Linux; no console window flashes.
4. A long command, then Stop: the process is gone inside the distro
   (`ps -ef` in a WSL terminal). A background dev server: Output and Stop
   work; quit the app → it's gone in the distro.
5. Branch control, a worktree fork (appears beside the repo *inside* the
   distro; `git worktree list` in Linux is clean), delete with worktree.
6. Editor window: edit a file in `vim` inside WSL → the editor reloads
   within a few seconds; save conflicts still ask.
7. `sudo apt update` through `open_in_shell`: a WSL Shell tab opens at the
   project folder with the command typed; the result comes back.
8. Open in Code from a WSL Shell tab: the session lands in the same distro
   and folder.
9. Two sessions in one folder: one writer at a time; stale-file notices.
10. Detach a session; everything above still works from its window.

## Out of scope

- Native Windows folders and PowerShell (#396).
- Running Haruspex itself inside WSL (WSLg) — this is the Windows build
  driving a distro.
- A memory limit inside WSL (decision 11, later).
