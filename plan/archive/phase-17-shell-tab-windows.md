# Phase 17: Shell Tab — Windows Port (PowerShell + WSL2)

## Goal

Bring the Shell tab (terminal passthrough + LLM troubleshooting sidebar) to **Windows**,
supporting the shells Windows developers actually use: **PowerShell 7+ (`pwsh.exe`)**,
**Windows PowerShell 5.1 (`powershell.exe`)**, and **WSL2 distros** (bash/zsh running inside
the Linux distro). CMD is explicitly out.

Windows is the hard port. Three things diverge sharply from Linux/macOS:

1. **Multiple shells, multiple kinds.** A native Windows shell (PowerShell, ConPTY) and a
   Linux-inside-Windows shell (WSL, launched via `wsl.exe`) are fundamentally different beasts.
   The user needs a **shell picker** (net-new UI) that enumerates what's installed and lets
   them choose.
2. **PowerShell has no `--rcfile`/`ZDOTDIR`.** OSC 133 shell integration is injected by loading
   the user's `$PROFILE` and then dot-sourcing a new `haruspex.ps1` that wraps the `prompt`
   function and uses PSReadLine to emit the `133;A/B/C/D` markers.
3. **WSL context lives inside the distro, not on the host.** The Rust backend runs on Windows,
   but for a WSL session the OS/distro/kernel/cwd/history the AI should see come from *inside*
   the distro — captured by bridging through `wsl.exe`.

This phase builds on the `ShellPlatform` abstraction introduced in Phase 16 (macOS). It adds a
Windows branch plus a new concept the other platforms didn't need: a **shell catalog** (the set
of selectable shells/distros) and a **session kind** (PowerShell vs WSL) that picks the right
integration and context strategy.

## Prerequisites

- Phase 15 (`plan/phase-15-shell-tab.md`) and Phase 16 (`plan/phase-16-shell-tab-macos.md`) are
  merged. In particular Phase 16's `src-tauri/src/shell/platform.rs` abstraction
  (`default_shell`, `login_args`, `capture_os`, `platform_supported`) is the seam this phase
  extends.
- `portable-pty` uses **ConPTY** on Windows — it can spawn `pwsh.exe`, `powershell.exe`, and
  `wsl.exe` as PTY children. No new PTY crate.
- The single-string `shellBinary` setting (`src/lib/stores/settings.ts:194`) and the existing
  `shell_override: Option<String>` param on `shell_spawn`/`shell_restart` are the selection
  plumbing we generalize into a shell-catalog + selected-shell-id model.
- A Windows 10/11 dev machine with: `powershell.exe` (always present), optionally `pwsh.exe`
  (PowerShell 7+, separately installed), and at least one WSL2 distro (`wsl --install`).
- Familiarity with Windows shell-integration prior art: VS Code's terminal shell integration
  and Microsoft's Windows Terminal PowerShell OSC 133 snippet (the reference implementation for
  wrapping `prompt` + PSReadLine to emit `133` markers).

## Deliverables

- **User-testable**: On Windows, the TabBar reads `[ Chat | Jobs | Shell ]` and Shell opens a
  working terminal. The default shell is `pwsh.exe` if installed, else `powershell.exe`. `dir`,
  `git log --oneline`, a full-screen TUI (e.g. `htop` under WSL, or `Get-Process | Out-Host`),
  and window-resize-resizes-PTY all work via ConPTY.
- **User-testable**: A **shell picker** in the terminal toolbar lists every supported shell and
  every installed WSL distro (e.g. `PowerShell 7`, `Windows PowerShell`, `Ubuntu`, `Debian`).
  Shells/distros that aren't installed appear **greyed-out** with a hint
  (`Install PowerShell 7`, `No WSL distros found`). Picking one restarts the session as that
  shell.
- **User-testable**: In PowerShell (7+ or 5.1), OSC 133 capture works: after running a command,
  "Submit to LLM" captures the last command + output. The user's existing `$PROFILE`
  customizations (prompt, modules, aliases) still load.
- **User-testable**: In a WSL2 distro, the existing `haruspex.bash` / `haruspex.zsh` integration
  drives OSC 133 capture, and the auto-attach context reports the **distro's** OS/kernel/shell
  (e.g. `Ubuntu 22.04 · bash 5.1 · Linux 5.15-WSL2`) and a Linux cwd — not the Windows host.
- **User-testable**: Suggested-command suggestions are platform-aware: PowerShell sessions get
  PowerShell/`winget`-flavored suggestions; WSL sessions get `apt`/`dnf`-flavored ones. Risk
  badges fire on both PowerShell-destructive (`Remove-Item -Recurse -Force`, `Format-Volume`,
  `Set-ExecutionPolicy`, `reg delete`) and the inherited Linux patterns (inside WSL).
- **User-testable**: Closing the app kills the PTY cleanly — including the `wsl.exe` host
  process and (best-effort) the in-distro shell. Restart-shell and shell-switching work.
- **Internal**: `shell/platform.rs` gains a Windows branch; a new shell-catalog
  (enumerate installed shells + WSL distros) and session-kind concept route spawn, integration,
  and context capture correctly.

---

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Shells supported | **`pwsh.exe` (PS 7+), `powershell.exe` (Windows PowerShell 5.1), and WSL2 distros (bash/zsh inside).** No CMD. | The set the user requested. PowerShell covers native Windows with a real OSC 133 story; WSL covers the Linux-dev workflow and reuses the existing hook scripts almost verbatim. CMD has no usable shell-integration and low value. |
| Default shell + fallback | **`pwsh.exe` if present, else `powershell.exe` 5.1** (always in-box). Detection at startup. | Most Windows devs prefer PS 7, but it isn't installed by default; 5.1 guarantees a working first run. |
| Shell picker (catalog) | **Enumerate all installed shells + all WSL distros and show them in a toolbar picker; the user chooses.** Uninstalled/known shells render **greyed-out with an install hint** rather than being hidden. | The user asked for full enumeration with disabled entries. Discoverable (a user without PS 7 learns it exists) and honest (a user with three WSL distros can pick the right one — the chosen "enumerate all, user picks" answer for WSL). |
| WSL distro selection | **List every distro via `wsl.exe -l -v`; default to the WSL default distro; user can pick any.** | Chosen answer: full per-distro enumeration, not default-only. `-l -v` gives name + state + WSL version so we can show only running-capable WSL2 distros and mark the default. |
| Session kind | **A `ShellKind` enum: `PowerShell { exe }` or `Wsl { distro }`.** Spawn, integration injection, and context capture branch on it. | PowerShell and WSL need entirely different injection and context strategies. Modeling the kind explicitly keeps each branch self-contained and makes the picker → spawn mapping trivial. |
| PowerShell integration | **Ship `haruspex.ps1`. Launch so the user's `$PROFILE` loads first, then dot-source ours**, which wraps the `prompt` function + uses PSReadLine to emit OSC 133 `133;A/B/C/D` and `OSC 7` cwd. | Chosen answer: "Load user `$PROFILE`, then ours." PowerShell has no `--rcfile`; the idiomatic injection is `pwsh -NoExit -Command ". 'C:\…\haruspex.ps1'"` — profiles load (not `-NoProfile`), then our script dot-sources and wraps. Mirrors VS Code's approach. |
| PowerShell capture mechanism | **Wrap `prompt` (emit `133;A` prompt-start, `133;D;<exit>` for the previous command) + a PSReadLine `AcceptLine` handler / `PSConsoleHostReadLine` to emit `133;B` command-start and `133;C;cl=<b64>` with the command line.** Works on both PSReadLine 2.0 (ships with 5.1) and newer (pwsh). | This is the established Windows Terminal / VS Code technique. Both PowerShell flavors ship a compatible PSReadLine; degrade to prompt-only markers if a key handler can't be installed (capture still works, command-line echo just falls back to scrape). |
| WSL integration | **Reuse `haruspex.bash` / `haruspex.zsh` unchanged, executed inside the distro.** Inject by translating the resource path to a WSL path and launching `wsl.exe -d <distro> -- <shell> --rcfile <wslpath>` (bash) or via `ZDOTDIR` (zsh). | The OSC 133 parser and hook scripts are already platform-agnostic Linux scripts; inside the distro they "just work." The only new work is the host→WSL path bridge (`wsl.exe wslpath -u`, or reference via `/mnt/c/…`). |
| WSL context capture | **Probe inside the distro through `wsl.exe`.** `wsl -d <distro> -- uname -r`, `cat /etc/os-release`, read `~/.bash_history`/`~/.zsh_history` inside the distro; cwd is the Linux path from OSC 7. | Chosen answer: "Probe inside the distro." The AI must see the environment the commands actually run in. This reuses the *logic* of the Linux `capture_os`/history parsing, executed over a `wsl.exe` bridge instead of direct file reads. |
| PowerShell context capture | **Windows host info**: `os = "windows"`, version from `cmd /c ver` or the registry (`CurrentBuild`/`DisplayVersion`), PowerShell version from `$PSVersionTable`, cwd from OSC 7, history from PSReadLine's `(Get-PSReadLineOption).HistorySavePath`. | For a native PowerShell session the host *is* the environment. PSReadLine's history file is the PowerShell analog of `~/.bash_history`. |
| Selection model migration | **Generalize the single `shellBinary` string into a selected-shell descriptor** (`{ kind, exe?, distro? }`) plus the live-enumerated catalog. Keep `shell_override` working for Linux/macOS by mapping the legacy string through. | The picker needs more than one string. Keep the change additive: Linux/macOS still resolve a path; Windows resolves a `ShellKind`. |
| Path translation for fs_read in WSL | **Out of scope for v1; documented limitation.** The shell-mode `fs_read_*_absolute` commands read the **Windows** filesystem. For WSL sessions, in-distro files are reachable only via `\\wsl$\<distro>\…` or `/mnt/c`. Flag this; don't silently mis-read. | Bridging fs_read through `wsl.exe` is a sizable sub-feature. The AI can still read Windows-side files and can *suggest* commands the user runs in-distro; reading arbitrary in-distro files via the tool is a follow-up. Surfacing the limitation beats a confusing half-implementation. |
| Risk patterns | **Existing Linux list (applies inside WSL) + PowerShell additions**: `Remove-Item -Recurse -Force` / `rm -r* -fo*`, `Format-Volume`, `Clear-Disk`, `Set-ExecutionPolicy`, `reg delete`, `Stop-Computer`/`Restart-Computer`, `diskpart`. | Same visual-heads-up philosophy as Phase 15 — **and now a safety control**: post-#132 `classifyShellRisk` also gates Code-mode `run_command` approval (`tools/code.ts` `ensureCommandApproved`), so a PowerShell-destructive command the list *doesn't* match auto-runs the agent unprompted. PowerShell verbs are distinct enough to need their own entries; WSL sessions reuse the Linux list. |
| One-shot `run_command` shell (Code mode) | **Route the one-shot fallback through the selected `ShellKind`** (`pwsh -Command` / `powershell -Command` / `wsl -d <distro> -- bash -c`), not the current hardcoded `cmd /C`. | `code_tools.rs::build_shell_command` hardcodes `cmd /C`; the Code-mode model emits PowerShell cmdlets or WSL bash, never CMD. For WSL it's doubly wrong — it runs on the Windows host and the Linux `cwd` fails `is_dir()`. `run_command_capture` must take the shell selection (thread `ShellKind` through, same seam as `kind.rs`). |
| Code mode in WSL sessions | **v1: restrict the file tools** (`code_grep`/`code_glob`/`fs_edit_text`/`fs_write_text`) for WSL sessions — they resolve against `shellCwd`, a *Linux* path the Windows-side Rust tools can't walk. PTY `run_command` still works (runs in-distro). Bridging the fs tools through `\\wsl$\<distro>\…` is a follow-up. | This is the same root cause as the `fs_read`-in-WSL limitation but far worse in Code mode: grep/glob/edit silently target a non-existent Windows path. Surfacing/limiting beats a confusing half-broken agent. |
| Code-mode system prompt | **`ShellKind`-aware**: PowerShell variant (cmdlets, `$env:`, no venv-activate, PS-appropriate non-interactive flags) vs the existing Unix/WSL variant. | `buildShellCodeSystemPrompt` hardcodes Unix idioms (venv activation, `--no-pager`/`CI=1`, avoid `less`/`vim`/`top`). Correct for WSL (Linux), wrong for PowerShell. Mirror how `buildShellSystemPrompt` already adapts suggestions per distro. |
| Process teardown | **Kill the ConPTY child (the `wsl.exe`/`pwsh.exe` process) on session drop; for WSL, accept that the in-distro shell is reaped when the `wsl.exe` relay exits.** | `wsl.exe` is a relay to the distro's init-managed process. Killing the relay ends the interactive session; WSL's own lifecycle handles the rest. Document that long-running in-distro background jobs are not our responsibility (same as a real terminal). |
| Audio/cpal guards | **Validate on Windows** (same checklist item as macOS Phase 16) before opening the gate. | The Phase 15 placeholder tied platform support to validated audio guards; confirm no panic on Windows audio init or scope a follow-up. |

---

## Architecture Overview

```
┌─ Frontend ──────────────────────────────────────────────────────────────┐
│ ShellTab.svelte                                                          │
│  • NEW: <ShellPicker/> in the toolbar — lists catalog entries, greys     │
│    out uninstalled ones, restarts session on pick.                       │
│  • placeholder card removed on Windows (gate now open)                   │
│  • Run/Paste already strip comment-only lines + inject via bracketed     │
│    paste (commandBlock.ts) — verify against PowerShell/PSReadLine        │
│    (see Risks: "Suggested-command injection on PowerShell")              │
│ Terminal.svelte                                                          │
│  • attachSession() calls shell_mark_ready after wiring the output        │
│    listener + onData — preserve this on the ConPTY path (see note below) │
│ stores/shell.svelte.ts                                                    │
│  • selectedShell: { kind, exe?, distro? }; catalog: ShellCatalogEntry[]  │
└──────────────────────────────────────────────────────────────────────────┘
                  │  invoke('shell_list_shells')  → catalog
                  │  invoke('shell_spawn', { selection })
                  ▼
┌─ Rust: src-tauri/src/shell/ ────────────────────────────────────────────┐
│ platform.rs   ← Windows branch added (default_shell, platform_supported) │
│ catalog.rs    ← NEW. enumerate_shells():                                 │
│                   - pwsh.exe / powershell.exe presence (PATH + known      │
│                     install dirs)                                         │
│                   - WSL distros via `wsl.exe -l -v` (name, default, v2)   │
│                   returns Vec<ShellCatalogEntry { id, label, kind,        │
│                     installed, install_hint }>                            │
│ kind.rs       ← NEW. ShellKind { PowerShell{exe} | Wsl{distro} };         │
│                   maps a selection id → spawn command + args + env        │
│ pty.rs        ← spawn command/args now come from ShellKind, not just a    │
│                  path; SpawnPlan extended for ps1 / wsl injection         │
│ winps.rs      ← NEW. PowerShell injection: build the `-NoExit -Command    │
│                  ". 'haruspex.ps1'"` invocation                           │
│ wsl.rs        ← NEW. WSL bridge: wslpath translation, build               │
│                  `wsl -d <distro> -- bash --rcfile <wslpath>`, and         │
│                  context probes (uname/os-release/history via wsl.exe)    │
│ context.rs    ← capture branches on ShellKind: host (PowerShell) vs       │
│                  in-distro probe (WSL)                                     │
│ integration.rs← unchanged (OSC 133 parser already platform-agnostic;      │
│                  haruspex.ps1 emits the same 133 markers)                  │
│ session.rs    ← spawn-path unchanged for Windows except routing through    │
│                  ShellKind; preserves the post-Phase-15 output-replay      │
│                  handshake (shell_mark_ready) — matters most on ConPTY     │
│ mod.rs        ← shell_spawn/shell_restart take a selection; NEW           │
│                  shell_list_shells command; platform_supported → +windows; │
│                  hosts the shell_mark_ready command (post-Phase-15)        │
│                                                                            │
│ resources/shell-integration/                                              │
│   haruspex.ps1  ← NEW. wraps prompt + PSReadLine → OSC 133 + OSC 7        │
│   haruspex.bash / haruspex.zsh ← reused inside WSL distros, unchanged     │
└──────────────────────────────────────────────────────────────────────────┘
```

### Post-Phase-15 note: the spawn→attach output-replay handshake

Since this plan was written, `Session::spawn` gained an **output-replay buffer**: PTY
output is buffered until the frontend calls the new `shell_mark_ready` command (from
`Terminal.svelte`'s `attachSession`, once the `shell://output` listener and the xterm
`onData` reply path are both wired), then flushed. This fixed a race where a shell's
startup terminal query was emitted into the spawn→attach gap and lost. The mechanism is
platform-agnostic and **every Windows session (PowerShell and WSL) inherits it** by
going through `Session::spawn` — there's no per-shell work, but the ConPTY path must not
regress it. It is *especially* relevant on Windows: ConPTY emits a burst of cursor /
resize / redraw output the instant the child attaches, so buffering-until-ready is what
keeps that startup burst from being dropped before xterm is listening.

### PowerShell injection (the new integration path)

```
shell_spawn(selection = PowerShell{ pwsh.exe })
  └─ winps::build_invocation():
       exe  = pwsh.exe (or powershell.exe)
       args = ["-NoExit", "-Command", ". 'C:\…\resources\shell-integration\haruspex.ps1'"]
       (NO -NoProfile → user $PROFILE loads first, then our dot-source runs)
  └─ ConPTY spawns it; haruspex.ps1:
       - saves any existing `prompt` function, defines a new one that:
           emits ESC]133;D;<lastExit>BEL  (end of previous command)
           emits ESC]133;A BEL            (prompt start)
           emits ESC]7;file://host/<cwd>  (cwd)
           calls the saved prompt
           emits ESC]133;B BEL            (command start)
       - installs a PSReadLine handler to emit ESC]133;C;cl=<base64 cmdline> BEL
         when a line is accepted
```

### WSL injection + context (reuse Linux, bridge through wsl.exe)

```
shell_spawn(selection = Wsl{ "Ubuntu" })
  └─ wsl::build_invocation():
       translate resource dir → WSL path (wsl -d Ubuntu wslpath -u 'C:\…'  or /mnt/c/…)
       exe  = wsl.exe
       args = ["-d", "Ubuntu", "--", "bash", "--rcfile", "<wslpath>/haruspex-bashrc"]
              (zsh: pass ZDOTDIR via WSLENV / -e env …)
  └─ ConPTY spawns wsl.exe; inside the distro haruspex.bash emits the same OSC 133 markers
  └─ context::capture (Wsl) probes through wsl.exe:
       wsl -d Ubuntu -- uname -r
       wsl -d Ubuntu -- cat /etc/os-release
       wsl -d Ubuntu -- cat ~/.bash_history   (tail N)
       → SessionContext { os:"linux", distro:"ubuntu", kernel:"…-WSL2", … }
```

---

## Interaction with Code Mode (PR #132)

This plan was written **before** the Shell-assistant **Code mode** merged (PR #132,
`bb7eef6`). Code mode adds a per-session **Code** toggle to the Shell assistant that swaps in a
coding toolset (`code_grep`, `code_glob`, hardened `fs_read/write/edit`, and `run_command`) and a
coding system prompt. It matters here because **Code mode and this Windows port share one
switch**: `shell_platform_supported()`.

- The **Code** toggle lives in `shell/ChatSidebar.svelte`, only reachable when the Shell tab is —
  i.e. when `platform_supported()` is true. So Windows Code mode is unreachable until **17e** opens
  the gate.
- `run_command` (`tools/code.ts`) picks **PTY-driven** vs **one-shot** execution via `shouldUsePty`
  (`tools/pty-exec.ts`), which in the default `'auto'` mode returns `shell_platform_supported()`.
- The **PTY path** (`runInPty`) relies entirely on the OSC 133 capture this phase builds:
  `shell_get_context.completed_total` ticking, `shell_get_recent_commands`, bracketed-paste
  injection (`toBracketedPaste(cmd, true)`), and Ctrl-C abort via `shell_write('\x03')`.
- The **one-shot fallback** (`code_tools.rs::run_command_capture`) already has a Windows branch —
  but it hardcodes `cmd /C` (see the new "One-shot `run_command` shell" decision row).

**Net effect: the instant 17e flips `platform_supported()` to include Windows, Code mode's
PTY `run_command` turns on alongside the tab.** That makes the following non-optional for this
phase, not follow-ups:

1. **Sequencing.** Do **not** open `platform_supported()` before integration lands (17c/17d). If
   the gate opens while a Windows shell has no OSC 133 markers, Code-mode `'auto'` will PTY-drive
   against a marker-less shell → `completed_total` never increments → *every agent `run_command`
   times out*. The existing 17a recommendation (keep the gate closed until 17e) already covers
   this — but note it now also governs Code mode, so the coupling is load-bearing.
2. **PTY `run_command` is a done-criterion of 17c/17d**, not just the manual terminal. The
   "Suggested-command injection on PowerShell" risk (multi-line bracketed paste + trailing-CR
   executes, `#` comment stripping) applies identically to the agent's `run_command`, since it
   injects through the same `toBracketedPaste(cmd, true)` path. Verifying the manual Run button
   covers both — confirm with an agent-driven command too.
3. **One-shot fallback must run in the selected shell** (new decision row): `cmd /C` is wrong for
   PowerShell and WSL. Until that lands, set the expectation that Windows Code mode = PTY-only
   (one-shot is broken), matching `shell-code-mode-plan.md`'s "Windows PTY integration (Phase 17)"
   line — this phase is where that one-shot becomes shell-correct.
4. **Risk gate** (new note on the Risk-patterns row): `classifyShellRisk` now gates the *agent's*
   command approval, so the PowerShell additions are a safety control, not cosmetic badges.
5. **System prompt** (new decision row): `buildShellCodeSystemPrompt` is Unix-flavored; add a
   PowerShell variant.
6. **WSL file tools** (new decision row): `code_grep`/`code_glob`/`fs_edit_text` resolve against a
   Linux `shellCwd` the Windows-side Rust tools can't walk — restrict them for WSL sessions in v1.

These fold into the sub-phases below (17c/17d done-criteria + a Code-mode line in 17e's tests).

---

## Sub-phases

Each sub-phase ends at a user-testable state. Run full build gates (`maintenance.md` §13) at the
end of each. (Windows build gates: `cargo test`/`clippy`/`fmt` on the Windows target plus the
frontend gates.)

### 17a — Windows PTY baseline + platform gate plumbing (PowerShell only, no integration)

Goal: a bare PowerShell terminal in the tab on Windows.

- Add the Windows branch to `platform.rs`: `default_shell()` returns `pwsh.exe` if resolvable
  on `PATH`/known install dir else `powershell.exe`; `platform_supported()` includes `windows`
  (gate stays closed in the frontend until 17e, or open it now behind a feature check — your
  call; recommend opening at 17e after integration lands).
- Verify `portable-pty` ConPTY spawns `powershell.exe`/`pwsh.exe` and streams output; keystrokes
  and resize work. No integration injection yet (passthrough `SpawnPlan`).
- Map the legacy `shell_override` string through so existing Linux/macOS behavior is untouched.

**Done when**: on Windows, Shell opens a PowerShell prompt; `dir`, `git status`, resize all work;
Linux/macOS unaffected.

### 17b — Shell catalog + picker UI

Goal: enumerate and select shells/distros.

- `src-tauri/src/shell/catalog.rs`: `enumerate_shells()` →
  `Vec<ShellCatalogEntry { id, label, kind, installed, install_hint }>`. Detect `pwsh.exe` /
  `powershell.exe` (PATH + `%ProgramFiles%\PowerShell\7`, `System32\WindowsPowerShell`); parse
  `wsl.exe -l -v` for WSL2 distros (name, default marker, version filter to v2). On non-Windows,
  return the single native shell so the picker is harmless cross-platform.
- New `shell_list_shells` Tauri command. `shell_spawn`/`shell_restart` accept a selection
  (`{ kind, exe?, distro? }`) instead of just `shell_override`; add `kind.rs` to map a selection
  → spawn command.
- Frontend: `<ShellPicker/>` in the terminal toolbar (driven by `shell_list_shells`). Installed
  entries selectable; uninstalled known shells greyed-out with `install_hint`. Picking restarts
  the session via `shell_restart`. Persist the last selection in settings (generalize
  `shellBinary` → selected-shell descriptor).

**Done when**: the picker lists PowerShell 7 / Windows PowerShell / each WSL distro with correct
installed/greyed state; picking Windows PowerShell vs WSL Ubuntu actually launches the right
shell.

### 17c — PowerShell OSC 133 integration

Goal: capture works in PowerShell, user profile preserved.

- Ship `resources/shell-integration/haruspex.ps1`: wrap `prompt` to emit `133;A`, `133;D;<exit>`,
  and `OSC 7` cwd; install a PSReadLine handler for `133;B` and `133;C;cl=<base64>`. Degrade to
  prompt-only markers if the key handler can't be installed.
- `winps.rs`: build `pwsh -NoExit -Command ". '<resource>\haruspex.ps1'"` (and the
  `powershell.exe` equivalent). Profiles load first (no `-NoProfile`), then our dot-source runs.
- Confirm the existing `integration.rs` parser ingests the PowerShell-emitted markers unchanged
  (same `133` codes, BEL-terminated).
- PowerShell context capture in `context.rs`: `os="windows"`, build/version from registry or
  `cmd /c ver`, `$PSVersionTable` for shell version, PSReadLine history path for recent history.
- **Code mode (PR #132):** add the PowerShell variant of `buildShellCodeSystemPrompt`
  (cmdlets / `$env:` / PS non-interactive flags, no venv-activate framing). Add the PowerShell
  risk patterns to `risky-commands.ts` (also gates `run_command` approval). Verify the PTY
  `run_command` path on PowerShell: bracketed-paste injection executes, `completed_total` ticks,
  output + exit code come back, Ctrl-C abort works. Route the one-shot fallback through
  `pwsh -Command` / `powershell -Command` instead of `cmd /C`.

**Done when**: in both pwsh and powershell.exe, run a command → "Submit to LLM" captures the last
command + output; the user's custom prompt/aliases still load; the context badge reads e.g.
`Windows 11 23H2 · PowerShell 7.4`. **Code mode:** toggling Code on in a PowerShell session lets the
agent grep → read → edit → `run_command` (PTY) → see output; a destructive cmdlet prompts for
approval; the one-shot fallback (force via the `codeCommandExec` setting) runs PowerShell, not CMD.

### 17d — WSL2 integration + in-distro context

Goal: WSL sessions capture and contextualize correctly.

- `wsl.rs`: translate the resource dir to a WSL path (`wsl -d <distro> wslpath -u`), build
  `wsl -d <distro> -- bash --rcfile <wslpath>` and the zsh `ZDOTDIR` variant (via `WSLENV`/
  `-e env`). Reuse `haruspex.bash`/`haruspex.zsh` unchanged.
- WSL context capture: probe `uname -r`, `/etc/os-release`, and history *inside* the distro via
  `wsl.exe`; report a Linux cwd from OSC 7. `SessionContext` reflects the distro, not the host.
- Risk patterns: confirm the inherited Linux list applies for WSL sessions; add the PowerShell
  additions (`Remove-Item -Recurse -Force`, `Format-Volume`, `Set-ExecutionPolicy`, `reg delete`,
  `Clear-Disk`, `diskpart`, `Stop-Computer`) to `risky-commands.ts`, gated/labeled appropriately.
- Document the fs_read-in-WSL limitation (tool reads Windows FS; in-distro files via `\\wsl$`/
  `/mnt` only) in `maintenance.md` and the system-prompt note.
- **Code mode (PR #132):** route the one-shot fallback through `wsl -d <distro> -- bash -c` (the
  current `cmd /C` runs on the Windows host with a Linux `cwd` that fails `is_dir()`). Verify PTY
  `run_command` works in-distro (the reused `haruspex.bash` markers drive capture). **Restrict the
  Code-mode file tools** (`code_grep`/`code_glob`/`fs_edit_text`/`fs_write_text`) for WSL sessions —
  they root at the Linux `shellCwd` the Windows-side Rust tools can't walk; gate them off with a
  clear "in-distro files aren't reachable from the tool yet" message rather than letting them
  silently mis-target. The existing Linux/WSL `buildShellCodeSystemPrompt` variant is correct here.

**Done when**: launching WSL Ubuntu gives a bash prompt with OSC 133 capture; the context badge
reads e.g. `Ubuntu 22.04 · bash 5.1 · Linux …-WSL2`; submitting yields `apt`-flavored suggestions.
**Code mode:** the agent's `run_command` runs in-distro (PTY, or one-shot via `wsl … bash -c`); the
restricted file tools refuse cleanly with the limitation message.

### 17e — Open the gate + teardown + polish

Goal: ship-ready Windows Shell tab.

- `platform_supported()` includes `windows`; remove the placeholder card on Windows
  (it now only renders on… nothing — both platforms supported; delete or repurpose).
- Process teardown: ConPTY child (`pwsh.exe`/`wsl.exe`) is killed on session drop; add a Windows
  orphan smoke test analogous to the Linux one (spawn N, assert no orphaned `pwsh`/`wsl` relays).
  Extend the orphan test with a Code-mode case: a timed-out/cancelled `run_command` reaps its
  process tree (`run_command_cancel` → `taskkill /F /T` for the one-shot path; Ctrl-C for PTY).
- **Code mode (PR #132):** confirm `codeCommandExec` `'auto'` resolves to PTY on Windows once
  integration is live (and to the shell-correct one-shot when forced); document per-`ShellKind`
  resolution in the Shell settings docs.
- Validate audio/cpal guards on Windows (no panic; STT/TTS start or degrade) — same checklist as
  Phase 16.
- Default-shell + missing-shell UX: confirm pwsh→5.1 fallback, greyed entries with hints
  (`Install PowerShell 7`, `No WSL distros found`), and that selecting a now-missing persisted
  shell falls back gracefully.
- Docs: `README.md` (Shell tab now Linux/macOS/Windows), `maintenance.md` Shell section (catalog,
  ShellKind, PowerShell injection, WSL bridge, fs_read-in-WSL limitation), and update the Phase 15
  "Out of Scope → Windows" line to point here.

**Done when**: build gates green on Windows (and unaffected on Linux/macOS); PowerShell and WSL
sessions both work end-to-end (terminal + submit + suggestions + risk badges + restart + switch);
no previously-clean file gains warnings.

---

## Risks / Open Questions

- **PowerShell `prompt`-wrapping fragility.** Users with heavy custom prompts (oh-my-posh,
  Starship, custom `prompt` functions) may re-define `prompt` *after* our dot-source, clobbering
  the markers — or we may clobber theirs. Mitigation: dot-source *after* `$PROFILE` (so we wrap
  the final prompt) and save/call the prior `prompt`. If a custom prompt still wins, degrade to
  PSReadLine-only `133;B/C` capture (command boundaries without prompt-start) rather than breaking
  the prompt. Spike against oh-my-posh + Starship in 17c.
- **PSReadLine version differences.** 5.1 ships PSReadLine 2.0; pwsh ships 2.2+/2.3. The
  key-handler API for emitting `133;C` differs subtly. Test on both; fall back to `prompt`-only
  markers where the handler API isn't available.
- **WSL path bridging.** `--rcfile` needs a *Linux* path. `wslpath -u` requires a round-trip
  through `wsl.exe` at spawn (latency + failure mode if the distro is stopped). Alternative:
  reference the script via `/mnt/c/…` (works only if the resource lives on a fixed drive). Spike
  both in 17d; prefer `wslpath` with a `/mnt` fallback.
- **WSL zsh `ZDOTDIR` propagation.** Passing `ZDOTDIR` into the distro needs `WSLENV` or
  `wsl -e env ZDOTDIR=…`. Confirm the env actually lands in the interactive zsh. If flaky, copy a
  bootstrap `.zshenv` into the distro `$HOME` temporarily, or fall back to bash-style sourcing.
- **WSL context probe latency.** Each `wsl.exe -- …` probe spins the distro relay (can be
  hundreds of ms on a cold distro). Capture once at spawn and cache (the existing
  `SessionContext` is spawn-time-cached anyway); avoid per-submit re-probes for the static fields.
- **fs_read in WSL.** Documented limitation, not solved here. If users need the agent to read
  in-distro files, that's a follow-up (bridge `fs_read_*_absolute` through `\\wsl$` or `wsl.exe cat`).
- **ConPTY quirks.** ConPTY reflows/rewrites output differently from a Unix PTY (cursor
  repositioning, resize redraw). xterm.js handles it, but full-screen TUIs under PowerShell may
  render imperfectly. Validate `Get-Process | Out-Host -Paging`, `vim` under WSL, and resize.
- **ConPTY startup burst × the output-replay buffer.** ConPTY emits a redraw/cursor burst
  immediately on child attach — the very output the `shell_mark_ready` replay buffer exists to
  catch. Confirm the buffer flushes correctly on the ConPTY path (xterm renders a clean first
  prompt, no lost/garbled startup output) for both PowerShell and `wsl.exe` children. If ConPTY
  itself issues a Device-Attributes-style query at startup, the same wired-before-flush ordering
  must answer it — validate the first prompt appears without a multi-second stall.
- **Suggested-command injection on PowerShell.** Run/Paste inject suggested commands via
  bracketed paste (`ESC[200~…ESC[201~`, from `commandBlock.ts`) plus comment-line stripping.
  PSReadLine supports bracketed paste, but verify: (a) a multi-line block pastes as one editable
  buffer and the trailing CR executes it (vs. running only the first line), (b) PowerShell
  comments (`#`) are stripped the same way shell comments are — `stripCommandComments` keys on a
  leading `#`, which matches PowerShell line comments, so this should hold, but confirm. WSL
  bash/zsh behave as on Linux. **Post-#132 this path is also how the Code-mode agent's
  `run_command` injects** (same `toBracketedPaste(cmd, true)`), so the same verification covers the
  agent — but confirm the agent case explicitly (it injects without a human in the loop).
- **`wsl.exe` absent / WSL not enabled.** `enumerate_shells` must treat a missing `wsl.exe` or
  "no distros" as zero WSL entries (greyed "No WSL distros found"), never an error that breaks the
  picker.
- **Default-shell drift.** If the persisted selection points at a now-uninstalled shell (user
  removed pwsh, deleted a distro), spawn must fall back to the default and surface a non-fatal
  notice rather than failing to open the tab.
- **Code signing / SmartScreen.** Unsigned Windows builds trip SmartScreen; PTY/child-spawn
  itself is unrestricted. Signing is a packaging concern, not a Shell-tab blocker — note it.

---

## Out of Scope (Explicitly Deferred)

- **CMD (`cmd.exe`).** No usable OSC 133 story; excluded by decision.
- **fs_read against in-distro WSL files.** Tool reads the Windows filesystem; in-distro reads are
  a documented limitation / future follow-up.
- **Code-mode file tools in WSL (`code_grep`/`code_glob`/`fs_edit_text`/`fs_write_text`).** Same
  root cause as above — they root at the Linux `shellCwd`. v1 restricts them for WSL sessions
  (PTY `run_command` still works in-distro); bridging via `\\wsl$\<distro>\…` is a follow-up.
- **Git Bash / MSYS2 / Cygwin shells.** Not in the supported set; may be added later if there's
  demand (they're closer to the WSL/bash path than to PowerShell).
- **Nushell / other PowerShell-adjacent shells.** Terminal-only via selection submit if launched
  manually; no first-class integration.
- **Per-distro `PATH`/env customization UI.** The WSL session inherits the distro's normal login
  environment; no setting is added.
- **Bridging Windows↔WSL path translation in suggestion cards.** Suggested commands are pasted
  verbatim; we don't rewrite Windows paths to `/mnt/c` or vice-versa.
- **Multi-shell tabs / session list.** Inherited Phase 15 deferral; the picker switches the single
  session, it doesn't open parallel ones.

---

## Test Prompts (smoke at the end of 17e, on Windows)

1. *(PowerShell)* *"What Windows version am I on and how much free disk do I have?"* → context
   reports Windows build/version; agent suggests `Get-PSDrive`/`Get-Volume`.
2. *(PowerShell)* *"Install ripgrep."* → expect a `winget install …` (or `scoop`/`choco` if
   detected) suggestion card, clickable to paste; never auto-executed.
3. *(PowerShell, negative)* *"Delete this whole folder and everything in it."* → agent suggests
   `Remove-Item -Recurse -Force …` — verify the destructive warning chip renders.
4. *(WSL Ubuntu)* *"Update all my packages."* → context reports Ubuntu; agent suggests
   `sudo apt update && sudo apt upgrade`; `sudo` chip renders.
5. *(WSL Ubuntu)* *"My `cargo build` failed — what's wrong?"* (after a build error) → submit by
   selection over the error; agent gives a concrete fix. Confirms capture + in-distro context.
6. *(Picker)* Switch from Windows PowerShell to PowerShell 7 to WSL Debian via the toolbar picker
   → each restarts cleanly with the right prompt and context badge; a machine without pwsh shows
   it greyed with "Install PowerShell 7".
7. *(Code mode, PowerShell)* Toggle **Code** on, "format the JSON in config.json and tell me if
   the build passes" → agent greps/reads, `fs_edit_text`s, then `run_command`s the build in the
   live PTY (visible in scrollback, output + exit code returned); a destructive cmdlet would prompt
   for approval.
8. *(Code mode, WSL Ubuntu)* Toggle **Code** on, "run the tests" → `run_command` executes in-distro
   via the PTY and the result comes back; the file tools cleanly report the in-distro limitation
   rather than mis-targeting the Windows filesystem.
