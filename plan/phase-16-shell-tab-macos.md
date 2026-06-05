# Phase 16: Shell Tab — macOS Port

## Goal

Bring the existing Phase 15 Shell tab (terminal passthrough + LLM troubleshooting sidebar)
to **macOS** with feature parity to Linux. The terminal, OSC 133 capture, auto-attach
context, suggested-command cards, and risk badges should all work the same way a Mac user
expects — zsh prompt by default, distro-appropriate (`brew`, not `apt`) suggestions, and the
sidebar reading a faithful picture of the host.

macOS is the *straightforward* port: `portable-pty` already opens a real PTY on Darwin, and
the existing `haruspex.zsh` / `haruspex.bash` integration scripts work essentially as-is. The
real work is (a) extracting a small platform abstraction so Windows (Phase 17) has a clean
seam to slot into, (b) replacing the Linux-only context capture (`/etc/os-release`, GNU tool
assumptions) with macOS equivalents, and (c) handling the macOS GUI-app `PATH` problem so the
shell the user gets inside Haruspex behaves like the one in Terminal.app.

This phase does **not** add new product surface. It widens the platform gate and fills in the
Mac-specific branches behind it.

## Prerequisites

- Phase 15 (`plan/phase-15-shell-tab.md`) is merged: `src-tauri/src/shell/` (`pty.rs`,
  `session.rs`, `integration.rs`, `context.rs`, `mod.rs`), the xterm.js frontend
  (`src/lib/components/shell/`), the shell store (`src/lib/stores/shell.svelte.ts`), and the
  integration scripts (`src-tauri/resources/shell-integration/haruspex.{bash,zsh}`).
- The non-Linux placeholder card in `ShellTab.svelte` and the `shell_platform_supported()`
  command in `shell/mod.rs:258` are the gate we are opening.
- A macOS dev machine (Apple Silicon and/or Intel) with Xcode command-line tools for building
  the Tauri bundle. zsh is the default login shell on macOS 10.15+; `/bin/bash` is Apple's
  frozen bash 3.2.
- Familiarity with `maintenance.md` sections on build gates, Tauri command registration,
  resource bundling, and the cross-platform abstraction note in Phase 15 Design Decisions
  ("Platform" row) and architecture diagram line ("`platform.rs` shell-binary detection").

## Deliverables

- **User-testable**: On macOS, the top-level TabBar reads `[ Chat | Jobs | Shell ]` and Shell
  opens a working terminal at a `zsh` prompt (the user's `$SHELL`). `ls`, `vim`, `htop`, `top`,
  `git log --oneline`, full-screen TUIs, and window-resize-resizes-PTY all work — same as Linux.
- **User-testable**: A Mac user whose login shell is bash gets a bash prompt with OSC 133
  capture working (Apple bash 3.2 honors the `DEBUG`-trap approach the existing `haruspex.bash`
  uses).
- **User-testable**: Commands on a `PATH`-sensitive setup work. Tools installed via Homebrew
  (`/opt/homebrew/bin` on Apple Silicon, `/usr/local/bin` on Intel) and via the user's rc files
  are on `PATH` inside the Haruspex shell — i.e. the GUI-app minimal-`PATH` problem is solved, so
  `brew`, `node`, `python3` etc. resolve the same as in Terminal.app.
- **User-testable**: The auto-attach `<session-context>` reports macOS correctly: `os = "macos"`,
  a human distro string like `macOS 14.5 (23F79)` from `sw_vers`, the Darwin kernel from
  `uname -r`, the shell name + version, hostname, cwd, and recent history from
  `~/.zsh_history` / `~/.bash_history`. The LLM suggests `brew install …` (not `apt`) without
  being told the platform.
- **User-testable**: Suggested-command risk badges fire on macOS-relevant destructive patterns
  (`sudo`, `rm -rf`, `rm -rf /`, `diskutil eraseDisk`, `> /etc/…`, `curl … | sh`) — the existing
  list plus a couple of macOS additions.
- **User-testable**: Closing the app kills the PTY cleanly (no orphaned `zsh`/`bash` under the
  app process); restart-shell works.
- **Internal**: A `ShellPlatform` abstraction exists so that shell-default selection, the
  integration-script picker, context capture, and history paths each have a single, clearly
  platform-branched implementation — the seam Phase 17 (Windows) plugs into without touching
  Linux/macOS code paths.

---

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Scope | **Feature parity with Linux, no new product surface.** Widen the gate; fill Mac branches. | Phase 15 already designed for cross-platform ("Platform" Design Decision). macOS is the low-risk validation of that design before Windows stresses it. |
| Shells supported | **zsh + bash, reusing the existing `haruspex.zsh` / `haruspex.bash` scripts unchanged where possible.** fish/nu remain terminal-only (selection-based submit) as on Linux. | zsh is the macOS default; Apple's bash 3.2 supports the `DEBUG`-trap + `PROMPT_COMMAND` approach already in `haruspex.bash`. Covers the dominant Mac shell mix with zero net-new hook scripting. |
| Default shell + fallback | **`$SHELL` → `/bin/zsh` fallback** (Linux falls back to `/bin/bash`). Done by making the fallback platform-specific. | macOS guarantees `/bin/zsh`; `/bin/bash` exists but is the frozen 3.2 and is *not* the platform default. A wrong fallback would surprise Mac users. |
| GUI-app `PATH` | **Spawn the interactive shell as a login shell on macOS** (`-l` for zsh/bash) so `/usr/libexec/path_helper` and the user's `.zprofile`/`.zshrc` populate `PATH`. | macOS GUI apps inherit a minimal `launchd` `PATH` (no `/opt/homebrew/bin`). Terminal.app launches login shells; matching that is the only way `brew`-installed tools resolve. This is the single biggest behavioral gotcha of the Mac port. See Risks for the login-shell × `--rcfile` interaction. |
| Context capture | **`sw_vers` for the OS string, `uname -r` for the kernel, drop the `/etc/os-release` path on macOS.** `distro_id = "macos"`, `distro_name = "macOS"`, `distro_version = ProductVersion`. | `/etc/os-release` does not exist on macOS; `sw_vers -productVersion` / `-buildVersion` is the canonical source. Keeps the `SessionContext` shape identical so the frontend/system-prompt code is untouched. |
| Hostname | **Reuse `$HOSTNAME` → `hostname` command**, already cross-platform; optionally prefer `scutil --get ComputerName` for the friendly name. | `hostname` exists on macOS and returns the right thing; the existing `context::hostname()` works as-is. `scutil` is a nicety, not required. |
| History paths | **Unchanged** — `~/.zsh_history`, `~/.bash_history`, `$HISTFILE` honored first. The existing zsh extended-history parser already handles `: <ts>:<dur>;<cmd>`. | Mac zsh uses the same extended-history format the parser in `context.rs` already handles. No change needed. |
| Platform abstraction | **Introduce `shell/platform.rs`** (foreshadowed in the Phase 15 architecture diagram) exposing `default_shell()`, `login_args(shell)`, `capture_os() -> (os, distro_id, distro_name, distro_version)`, and `platform_supported()`. Linux and macOS implementations behind `#[cfg(target_os = …)]`. | Phase 15 left `platform.rs` as a planned-but-uncreated seam. Creating it now — with two real implementors — proves the abstraction before Windows (which has the most divergent branch) lands in Phase 17. |
| Platform gate | **`shell_platform_supported()` returns true for `linux` and `macos`.** Replace the Linux-only placeholder copy; the placeholder remains only for Windows until Phase 17. | The xterm/PTY path is validated on Mac in this phase, so the gate opens. |
| Risk patterns | **Existing list + macOS additions** (`diskutil eraseDisk`, `diskutil apfs deleteContainer`, `> /etc/`, `launchctl … remove`). Keep it short, same philosophy as Phase 15. | The list is a visual heads-up, not a gate. A couple of Mac-destructive verbs round it out; the user is still the last line of defense. |
| Audio/cpal guards | **Validate (don't assume) the audio defensive guards on macOS** as a checklist item, since the Phase 15 placeholder called them out as unvalidated outside Linux. | The Shell tab itself doesn't use audio, but the placeholder text tied platform support to "audio guards validated." Confirm STT/TTS sidecars and `cpal` init don't panic on macOS as part of opening the gate, or scope a follow-up. |
| Code signing / hardened runtime | **Confirm PTY spawn + child processes work under the notarized, hardened-runtime bundle**; add entitlements only if a real failure appears. | Spawning child processes and opening PTYs is allowed under the default hardened runtime; no `com.apple.security.*` entitlement is normally required. Verify on a signed build rather than pre-emptively adding entitlements. |

---

## Architecture Overview

Nothing in the frontend data flow changes. The diff is concentrated in the Rust `shell/`
module, behind a new `platform.rs`:

```
src-tauri/src/shell/
  platform.rs   ← NEW. Cfg-gated per-OS:
                    default_shell() -> String           (linux: /bin/bash, macos: /bin/zsh)
                    login_args(shell_path) -> Vec<String> (macos: ["-l"], linux: [])
                    capture_os() -> OsInfo               (linux: os-release, macos: sw_vers)
                    platform_supported() -> bool         (linux || macos)
  pty.rs        ← fallback shell now comes from platform::default_shell();
                  SpawnPlan gains login args from platform::login_args()
  context.rs    ← SessionContext::capture() calls platform::capture_os()
                  instead of the inlined parse_os_release(); history paths unchanged
  mod.rs        ← shell_platform_supported() delegates to platform::platform_supported()
  session.rs    ← unchanged (login args flow through SpawnPlan.args)
  integration.rs← unchanged (OSC 133 parser is platform-agnostic)

resources/shell-integration/
  haruspex.zsh  ← unchanged (validate BSD base64 behavior)
  haruspex.bash ← unchanged (validate Apple bash 3.2 + BSD base64)

src/lib/components/shell/ShellTab.svelte
  ← placeholder copy updated to "Windows only" wording (macOS now supported)
```

### The login-shell × `--rcfile` interaction (the one subtle bit)

On Linux, `haruspex.bash` injects via `bash --rcfile <wrapper>` (non-login, sources
`~/.bashrc`). On macOS we *also* want login behavior so `PATH` is populated by `path_helper`
and `~/.zprofile`/`.zprofile`. These two needs must compose:

- **zsh**: login zsh reads `.zprofile`/`.zlogin` from `ZDOTDIR`; interactive reads `.zshrc`.
  The existing plan already overrides `ZDOTDIR` and writes a `.zshrc` that sources the real
  one. For login behavior on macOS, spawn `zsh -l` and ALSO drop a `.zprofile` / `.zlogin`
  into the temp `ZDOTDIR` that sources the user's real `~/.zprofile` (so `path_helper` and the
  user's login `PATH` setup run). Our OSC 133 hook stays in the `.zshrc` (interactive).
- **bash**: `bash -l --rcfile <wrapper>` — a login bash reads `~/.bash_profile` /
  `~/.profile`, *not* the `--rcfile`, but `--rcfile` is honored for the interactive rc. The
  wrapper must source the user's login profile too (best-effort) so `PATH` is right. Spike
  this in 16b; if the interaction is fiddly, the fallback is to seed `PATH` from a one-shot
  `zsh -lc 'echo $PATH'` / `path_helper` probe at spawn time and pass it via `cmd.env`.

This is the only genuinely Mac-specific design wrinkle; everything else is a value swap.

---

## Sub-phases

Each sub-phase ends at a user-testable (or test-covered) state. Run full build gates
(`maintenance.md` §13) at the end of each.

### 16a — Platform abstraction extraction (no behavior change on Linux)

Goal: create the seam, prove Linux still behaves identically.

- Add `src-tauri/src/shell/platform.rs` with `#[cfg(target_os = "linux")]` and
  `#[cfg(target_os = "macos")]` modules exposing: `default_shell() -> String`,
  `login_args(shell_path: &str) -> Vec<String>`, `capture_os() -> OsInfo` (struct holding
  `os`, `distro_id`, `distro_name`, `distro_version`), and `platform_supported() -> bool`.
- Move the Linux `/etc/os-release` parsing out of `context.rs` into the linux branch of
  `platform::capture_os()`. `SessionContext::capture()` calls `platform::capture_os()`.
- `pty::resolve_shell_with_override` fallback now returns `platform::default_shell()` instead
  of the hardcoded `/bin/bash`.
- `shell_platform_supported()` in `mod.rs` delegates to `platform::platform_supported()`
  (still linux-only until 16d).
- Tests: existing `context.rs` / `pty.rs` tests still pass; add a `platform` test asserting
  the linux default shell and os capture match prior behavior.

**Done when**: Linux behavior is byte-for-byte unchanged (terminal, context badge, history),
`cargo test` + `cargo clippy` green, and the new abstraction compiles with a stub/`unimplemented`-free
macOS branch.

### 16b — macOS shell defaults, login `PATH`, integration injection

Goal: a Mac user gets the right shell with a correct `PATH` and OSC 133 capture.

- Implement the macOS branch of `platform::default_shell()` (`/bin/zsh`) and
  `platform::login_args()` (`["-l"]`).
- Thread `login_args` into the spawn path: `SpawnPlan` (or `Session::spawn`) appends the login
  flag so the shell launches as a login shell on macOS. Verify it composes with the existing
  `--rcfile` (bash) / `ZDOTDIR` (zsh) injection per the "login-shell × `--rcfile`" note above.
- For zsh on macOS, extend `plan_zsh` to also write a `.zprofile`/`.zlogin` into the temp
  `ZDOTDIR` that sources the user's real login files, so `path_helper`/`~/.zprofile` run.
- Validate `haruspex.zsh` and `haruspex.bash` on macOS: confirm BSD `base64` (no GNU flags) and
  Apple bash 3.2 emit the OSC 133 `A/B/C/D` + OSC 7 markers correctly. Patch the scripts only
  if a real incompatibility surfaces (e.g. BSD `base64` line-wrapping — `tr -d '\n'` already
  guards this; verify).

**Done when**: on a Mac, opening Shell gives a zsh prompt where `which brew`, `node -v`, and a
`pyenv`/`nvm`-managed binary all resolve; the marker badge in the sidebar shows integration
loaded and completed commands incrementing; a bash-login user gets the same.

### 16c — macOS context capture

Goal: the auto-attach context describes macOS faithfully.

- Implement `platform::capture_os()` for macOS using `sw_vers` (`-productName`,
  `-productVersion`, `-buildVersion`): `os = "macos"`, `distro_id = "macos"`,
  `distro_name = "macOS"` (or `ProductName`), `distro_version = ProductVersion`. Keep
  `uname -r` for `kernel` (Darwin version).
- Confirm `read_recent_history` works for `~/.zsh_history` (extended-history parser already
  handles macOS zsh) and `~/.bash_history`.
- Add the macOS-relevant risk patterns to `src/lib/shell/risky-commands.ts`
  (`diskutil eraseDisk`, `diskutil apfs delete*`, `launchctl … remove`).

**Done when**: `shell_get_context` on a Mac returns a sane `os/distro/kernel/shell_version`,
the sidebar's context badge reads e.g. `macOS 14.5 · zsh 5.9 · Darwin 23.x`, and a test prompt
yields `brew`-flavored suggestions.

### 16d — Open the gate + polish

Goal: ship-ready macOS Shell tab.

- `platform::platform_supported()` returns true for `macos`. Update the `ShellTab.svelte`
  placeholder so it only shows on Windows (reword: "Windows support is the next stop…").
- Validate the audio/cpal defensive guards on macOS (STT/TTS sidecars start or degrade
  gracefully; no panic) — the Phase 15 placeholder tied platform support to this. Scope a
  follow-up if anything is unsafe rather than blocking the Shell tab.
- Build and smoke-test a signed/notarized bundle: confirm PTY spawn + child processes work
  under the hardened runtime; add entitlements only if a concrete failure appears.
- Orphan check: the Phase 15 `Drop`-kills-PTY smoke test runs on macOS too (spawn N PTYs,
  assert no orphaned `zsh` via `pgrep`).
- Docs: update `README.md` (Shell tab is now Linux + macOS), `maintenance.md` Shell section
  (note `platform.rs`, the login-shell `PATH` handling, where Mac-specific branches live),
  and the Phase 15 "Out of Scope → macOS" line to point here.

**Done when**: build gates green on macOS and Linux, the Shell tab works end-to-end on a Mac
(terminal + submit + suggestions + risk badges + restart), and no previously-clean file gains
warnings.

---

## Risks / Open Questions

- **Login shell × injection composition.** The `-l` login flag interacting with `--rcfile`
  (bash) and `ZDOTDIR` (zsh) is the highest-uncertainty piece. Spike in 16b. Fallback: skip
  `-l` and instead seed `PATH` by probing `zsh -lc 'echo $PATH'` (or `path_helper -s`) once at
  spawn and passing it via `cmd.env("PATH", …)`. Less elegant but robust and fully contained
  in `session.rs`.
- **BSD vs GNU coreutils in the integration scripts.** `haruspex.bash`/`haruspex.zsh` may
  assume GNU `base64`. macOS ships BSD `base64` (different wrap/flags). `tr -d '\n'` already
  neutralizes wrapping, but verify the encode output is identical to what the OSC 133 parser
  expects. Apple bash 3.2 lacks some bash 4+ features — confirm the `DEBUG` trap path doesn't
  rely on any.
- **GUI-app minimal `PATH`.** If the login-shell approach fails for some shell, Homebrew tools
  won't resolve and the Mac port feels broken. This is the must-get-right item; the `PATH`-probe
  fallback above de-risks it.
- **Hardened runtime / notarization.** Spawning a PTY and child processes should be fine under
  the default hardened runtime, but Gatekeeper/notarization quirks only show on a signed build,
  not in `tauri dev`. Test the actual bundle in 16d.
- **Audio guards.** The Phase 15 placeholder coupled "platform supported" to validated audio
  guards. The Shell tab doesn't need audio, so don't let an unrelated STT/TTS issue block it —
  but do confirm the app doesn't panic on macOS audio init, or scope it out explicitly.
- **`sw_vers` / `uname` absence.** Extremely unlikely on a real Mac, but `capture_os()` must
  degrade to `os = "macos"` with `None` distro fields rather than panic, mirroring the Linux
  `parse_os_release` "returns nothing" path.

---

## Out of Scope (Explicitly Deferred)

- **Windows.** Separate plan: `plan/phase-17-shell-tab-windows.md`.
- **fish / nu first-class capture on macOS.** Terminal-only with selection submit, same as
  Linux. A `haruspex.fish` hook is a future cross-platform follow-up if there's demand.
- **macOS-specific UI chrome** (e.g. native traffic-light integration, menu-bar items for the
  shell). The tab looks the same on every platform.
- **Multi-shell tabs / session list.** Inherited Phase 15 deferral; unchanged here.
- **`scutil`-friendly hostname.** Nice-to-have; `hostname` is sufficient for v1.
- **Per-distro/per-shell `PATH` customization UI.** The login-shell behavior is automatic; no
  setting is added.

---

## Test Prompts (smoke at the end of 16d, on a Mac)

1. *"What version of macOS am I on and is my Xcode up to date?"* → context reports macOS
   version from `sw_vers`; agent may suggest `xcode-select`/`softwareupdate`.
2. *"Install ripgrep."* → expect a `brew install ripgrep` suggestion card (not `apt`), clickable
   to paste.
3. *"`brew` isn't found in my terminal but works in Terminal.app — why?"* → validates the
   `PATH` fix actually worked (ideally `brew` *does* resolve here, making the question moot —
   that's the success signal).
4. *"Find the largest files in my home directory."* → `du`-style suggestion; click pastes;
   user presses Enter.
5. *(Negative)* *"Erase my external disk."* → agent suggests `diskutil eraseDisk …` — verify it
   renders with the destructive warning chip.
