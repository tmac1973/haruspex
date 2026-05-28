# Phase 15: Shell Tab (Terminal Passthrough + LLM Troubleshooting Sidebar)

## Goal

Add a **Shell** tab to the main app, alongside Chat and Jobs, that gives the user a fully functional terminal *and* a one-click path from "this output looks wrong" to "ask the LLM about it." The user works in their normal shell. When they hit a problem, they click a button (or use a shortcut, or right-click → Send to LLM) and the LLM analyses the last command + its output, can research it on the web, and suggests next-step shell commands. Clicking a suggested command types it at the prompt but never auto-executes — the user always reviews and presses Enter.

This phase is about wiring up a new product surface, not refactoring the agent. It reuses the existing agent loop, the existing search backends, the existing tab shell, and the existing inference queue.

## Prerequisites

- Phase 14 (Jobs) is merged — the top-level `[ Chat | Jobs ]` TabBar (`src/lib/components/TabBar.svelte`, `src/lib/stores/activeTab.svelte.ts`) is the integration point.
- Existing agent loop (`src/lib/agent/loop.ts`, `runAgentLoop`) and tool registry (`tools/registry.ts`).
- `runEphemeralTurn` (`src/lib/agent/runEphemeralTurn.ts`) is the reference for "agent run with no persisted conversation row" — Shell's chat thread is in-memory, similar shape but with streaming back into a runes store rather than a callback-only sink.
- Existing web tools (`web_search`, `fetch_url`, `research_url` in `src/lib/agent/tools/web.ts`) and the `proxy_search` Tauri command — Shell agent reuses these unchanged. Search backend is whatever `settings.searchProvider` already points to (Brave / DuckDuckGo / Mojeek / SearxNG).
- Existing fs_read tools (`src/lib/agent/tools/fs-read.ts`) and the `fs_tools/path.rs` workdir resolver — Shell agent needs a path that bypasses workdir gating (see Design Decisions: Filesystem access).
- Existing inference queue (`src/lib/stores/inferenceQueue.svelte.ts`) — Shell agent runs go through it so they serialize with Chat and Jobs.
- Familiarity with `maintenance.md` sections on tool system, Tauri command registration, sidecar pattern (we are not adding a sidecar; PTYs live in-process), persistence, build gates, ESLint complexity gates.

## Deliverables

- **User-testable**: Top-level TabBar reads `[ Chat | Jobs | Shell ]`. Click Shell → terminal renders, a real bash/zsh prompt appears, the user can run `ls`, `htop`, `vim`, `top`, `git log --oneline` — full TUI support. Resizing the window resizes the PTY.
- **User-testable**: Right-edge chat sidebar starts collapsed (just a thin rail with an icon). Click the rail → sidebar expands to ~33% width. Click again → collapses. State persists in settings.
- **User-testable**: In the terminal, the user runs `apt list --installed | grep python` (or any command that produces a recognizable error / interesting output). Click the **Submit to LLM** button in the terminal toolbar. The sidebar opens if collapsed. A new user message appears in the chat containing the last command + its output (captured via OSC 133 markers). The LLM responds, streaming, in the sidebar.
- **User-testable**: Highlight an arbitrary range of terminal text with the mouse → the Submit button switches to "Submit selection." Click it → the LLM receives exactly the selected range instead of the smart default.
- **User-testable**: Press the keyboard shortcut (default `Ctrl+Shift+L`) → same as clicking Submit. Right-click the terminal → context menu has **Send to LLM** entry that does the same.
- **User-testable**: The LLM's response contains one or more code blocks tagged as shell commands. Each renders as a clickable suggestion card with a label like `apt-get install python3-pip`. A risky pattern (e.g. `sudo`, `rm -rf`, `curl ... | sh`, `dd if=…`, writes under `/etc/`) renders with a red-bordered warning chip on the card.
- **User-testable**: Click a suggested command → the command is typed into the shell at the current prompt, cursor at end. The user can edit it before pressing Enter; the app never sends Enter on the user's behalf. The LLM can never execute a command directly.
- **User-testable**: Click a suggested command while there is already half-typed input at the prompt → a small modal asks **"Replace current input?"** with Yes / No. Yes clears the input (sends `Ctrl+U`) then types the suggestion. No leaves the prompt alone.
- **User-testable**: The LLM can call `web_search` and `fetch_url` (using the user's configured search provider) and `fs_read_text` against absolute paths anywhere on the filesystem (e.g. `/etc/nginx/nginx.conf`, `/var/log/syslog`) — without a workdir being set.
- **User-testable**: The LLM's system prompt includes captured session context: OS / distro / kernel (`uname`, `/etc/os-release`), shell name + version, current working directory at submit time, and the last N commands from the shell's history. The LLM gives distro-appropriate suggestions (apt on Debian, dnf on Fedora) without the user having to say which distro they're on.
- **User-testable**: A "New chat" button in the sidebar clears the chat thread but keeps the PTY session running.
- **User-testable**: Closing the app kills the PTY cleanly; the chat thread is not persisted (matches a real terminal).
- **User-testable**: While the Shell agent is running, the Chat tab's submit is gated behind the same inference queue (existing "waiting behind X" UI) — no double-allocation of the LLM.

---

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Terminal stack | **xterm.js (frontend) + portable-pty (Rust)**. PTY runs in-process inside the Tauri main, not as a sidecar. | Industry standard, full TUI support, cross-platform abstraction. No new sidecar to supervise; the PTY's lifetime is tied to the Shell tab's frontend lifetime + app lifetime. |
| Submit scope | **Smart default (last command + output) with manual selection override.** If the user has a text selection, submit that. Otherwise submit the region between the last two OSC 133 prompt markers. | Caller never has to remember a shell-integration hook to *get useful behavior*; selection is always available as an escape hatch when the marker isn't where they want it. |
| Submit triggers | **Toolbar button + keyboard shortcut (`Ctrl+Shift+L`) + right-click context menu.** | Discoverability for new users (button + context menu), speed for power users (shortcut). Shortcut deliberately uses Shift to avoid clashing with readline's `Ctrl+L` clear-screen. |
| Layout | **Collapsing right sidebar over the terminal.** Default state collapsed; persisted in settings. | Matches the user's first-stated instinct. Keeps the shell feeling like a shell; the chat is on-demand. |
| Sessions | **Single PTY per app launch.** No multi-tab in v1, but the store / IPC shape carries a `sessionId` from day one so multi-tab is additive later. | Matches scope from "start simple, plan for multi-tab later." Avoids designing a session-list UI. |
| Chat thread persistence | **In-memory only.** Killed on app close. No SQLite schema additions. | The PTY dies on app close anyway; a persisted chat thread without its shell state misleads. Mirrors how terminal scrollback persistence usually has no use without the live shell. |
| Chat thread scope | **One thread per shell session.** Each submit appends as a new user turn; previous submissions stay in context. "New chat" button clears the thread without restarting the PTY. | Gives the LLM cumulative troubleshooting context, which is the whole point. The 9B model's context is large enough to handle a single troubleshooting arc; the user can clear when they switch problems. |
| Agent tools | **Web tools (`web_search`, `fetch_url`, `research_url`) + fs_read tools (`fs_read_text`, etc.) with whole-system access.** No fs_write, no sandbox, no email. | The LLM's job is to read, research, and suggest. It must not write files (that's the user's call) and must not execute (security). Whole-system read is required because config files and logs live outside any project workdir. |
| Filesystem access for shell agent | **Bypass `resolve_in_workdir` for shell-mode fs_read invocations.** Done by giving the fs_read tools a context branch: when `ctx.shellMode === true`, send paths to a parallel set of Rust commands (`fs_read_text_absolute`, etc.) that accept absolute paths and skip workdir resolution. | The existing chat fs_read tools must stay workdir-restricted to preserve user trust there. Forking at the tool dispatch level keeps the change localized to a few files. (Implementation detail open: see Risks.) |
| Search backend | **Reuses `settings.searchProvider`.** Shell agent calls the same `proxy_search` Tauri command as `web.ts`. No new config, no new backend module. | Already implemented (`proxy/search.rs` covers Brave / DuckDuckGo / Mojeek / SearxNG). Adding a new backend just for Shell would duplicate code (`maintenance.md` §7). |
| Inference queue | **Shell agent acquires the existing `inferenceQueue` ticket.** Identity string `'shell'`. | Existing queue serializes llama-server load across consumers. The "waiting behind X" UI just works because it already renders consumer identity. |
| Suggested-command rendering | **Markdown-level convention: any fenced code block tagged `bash`, `sh`, or `shell` in the LLM's response is treated as a suggestion card.** Each card is clickable, has a copy button, and a "Paste into shell" action (the default click). | No new tool, no protocol change, no system-prompt-driven JSON format that the model gets wrong. The LLM already emits shell code in fenced blocks; we just augment the markdown renderer for the sidebar. |
| Paste mechanics | **Type at the current prompt position; never send Enter.** Implementation: write the command bytes (without trailing newline) to the PTY's master fd. The shell renders them as if the user typed them, including readline editing. | Closest to real terminal behavior. User keeps full control. No auto-execute path exists in code, so a bug can't accidentally introduce one. |
| Paste conflict | **Modal: "Replace current input?" Yes / No.** Detection: at the moment of click, ask the shell what's at the prompt (via the OSC 133 B / 133 C markers we track for command boundaries, plus our own typed-bytes counter since the last marker). If non-zero, prompt. | Avoids both data loss (the user's half-typed command) and silent prompt corruption. The user is making a deliberate choice. |
| Risky-command badges | **Static pattern list applied at render time.** Patterns include `sudo`, `rm -r`, `rm -rf`, `chmod -R`, `chown -R`, `dd if=`, `mkfs`, `> /etc/`, `>> /etc/`, `curl ... \| sh`, `wget ... \| sh`, `--no-preserve-root`, and fork bombs. A matched suggestion renders with a red-bordered warning chip naming the matched pattern ("sudo", "destructive write"). | Pure UI heuristic. No "are you sure" gate (would make legitimate sudo unusable for admin work); just a visual heads-up the user reads before pressing Enter. The list is intentionally short and obvious — false negatives are inevitable, the user is still the last line of defense. |
| Auto-context to LLM | **Captured at PTY spawn (OS/distro/kernel/shell version), refreshed per submit (cwd + recent history).** Bundled into a `<session-context>` block prepended to the system prompt for the Shell agent. | Avoids having the LLM ask "what distro?" every time. Cwd + history gives it enough situational awareness to make precise suggestions. Spawn-time context is cached; per-submit context is read from the shell each time. |
| Shell choice | **User's `$SHELL` with `/bin/bash` fallback.** The OSC 133 shell-integration hooks ship for bash and zsh in v1. fish / nu work as terminals but lose smart-default capture (user can still submit by selection). | Honors user preference. Covers the dominant Linux shell mix without writing four hook scripts in v1. |
| Initial cwd | **`$HOME`.** | Matches what opening a fresh terminal does. Independent of the app's workdir setting (which belongs to Chat/Jobs). |
| Platform | **Linux first, designed for cross-platform.** PTY backend, shell detection, and OSC 133 hook resolution all behind a `ShellPlatform` abstraction. macOS and Windows are future phases. | portable-pty already supports all three; the platform-specific work is shell selection, integration scripts, and risky-pattern lists. Keeping the abstraction now means no rewrite later. |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Main page (+page.svelte)                                             │
│  • TabBar:  [ Chat | Jobs | Shell ]                                  │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ ShellTab.svelte                                                      │
│  ┌──────────────────────────────────────┬──────────────────────────┐ │
│  │ <Terminal />                          │ <ChatSidebar />          │ │
│  │  • xterm.js host                      │  collapsing, default     │ │
│  │  • toolbar: Submit / New chat /       │  collapsed.              │ │
│  │    Session menu                       │  Renders the in-memory   │ │
│  │  • selection + OSC 133 tracking       │  chat thread with        │ │
│  │  • paste-suggestion API               │  <ChatMessage/> + custom │ │
│  │  • right-click menu                   │  shell-suggestion blocks │ │
│  └──────────────────────────────────────┴──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
                │                                       │
                ▼                                       ▼
┌──────────────────────────────────────┐   ┌────────────────────────────┐
│ stores/shell.svelte.ts               │   │ shell-agent driver          │
│  • PTY state, ANSI buffer, marker    │   │ (shell/runShellTurn.ts)     │
│    ring, captured session context    │   │  • Reuses runAgentLoop      │
│  • messages (in-memory)              │   │  • shellMode flag on ctx    │
│  • submit(scope) action              │   │  • streams into store       │
│  • sidebar open/closed state         │   │  • acquires inferenceQueue  │
└──────────────────────────────────────┘   │    ticket as 'shell'        │
                │                          └────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Rust: src-tauri/src/shell/                                           │
│  • pty.rs       portable-pty wrapping (spawn, write, resize, kill)   │
│  • session.rs   Session struct, stdin/stdout pumps, event emit       │
│  • integration.rs OSC 133 parser, prompt-marker ring                 │
│  • context.rs   capture os-release / uname / shell version           │
│  • platform.rs  shell-binary detection + integration-script picker   │
│  • mod.rs       Tauri commands                                        │
│                                                                       │
│ Tauri commands:                                                       │
│   shell_spawn(cols, rows) -> SessionId                               │
│   shell_write(session_id, bytes)                                     │
│   shell_resize(session_id, cols, rows)                               │
│   shell_kill(session_id)                                              │
│   shell_get_context(session_id) -> SessionContext                    │
│   shell_get_last_command(session_id) -> CapturedRegion               │
│   shell_get_recent_history(session_id, n) -> string[]                │
│                                                                       │
│ Events emitted to frontend (Tauri event):                            │
│   shell://output    { session_id, bytes }                            │
│   shell://exit      { session_id, code }                             │
│                                                                       │
│ Shell-integration hooks (shipped as resources):                      │
│   resources/shell-integration/haruspex.bash                          │
│   resources/shell-integration/haruspex.zsh                           │
│   (emit OSC 133 A / B / C / D markers + OSC 7 cwd updates)           │
│                                                                       │
│ New fs_read commands for shell mode (absolute paths, no workdir):    │
│   fs_read_text_absolute(path)                                         │
│   fs_read_pdf_absolute(path)                                          │
│   fs_list_dir_absolute(path)                                          │
│   (paths must still be valid utf-8 and exist; we don't add an        │
│   allow-list — the agent runs as the app user and can already        │
│   read whatever the user can read from a real shell.)                │
└──────────────────────────────────────────────────────────────────────┘
```

### How submit flow lands a user turn

```
user clicks "Submit to LLM"
  └─ Terminal.svelte resolves submit scope:
       has selection? → use the selected text
       else → invoke shell_get_last_command(sessionId)
  └─ refresh per-submit context: shell_get_context(sessionId)
                                  shell_get_recent_history(sessionId, 10)
  └─ shellStore.appendUserMessage({ captured, context })
  └─ runShellTurn(shellStore) — wrapper around runAgentLoop
       ├─ acquire inferenceQueue ticket 'shell'
       ├─ build LoopContext with shellMode=true and shell tools
       └─ stream assistant text + tool calls into shellStore.messages
  └─ ChatSidebar re-renders; suggestion blocks become clickable
```

### Click-to-paste flow

```
user clicks a SuggestedCommand card
  └─ shellStore.requestPaste(commandText)
       └─ if (currentPromptInputLength === 0): write commandText to PTY
       └─ else: open PasteConflictModal
            ├─ Yes → write Ctrl+U then commandText
            └─ No  → no-op
```

`currentPromptInputLength` is tracked by counting bytes the user has typed since the last OSC 133 B (prompt-end) marker, minus bytes consumed by `\b`, `\x15` (Ctrl+U), etc. Worst-case the heuristic is off and the modal fires when it shouldn't — better than silently corrupting the line.

---

## Sub-phases

Each sub-phase ends at a user-testable state (per `plan/refactor-plan.md`'s convention). Run the full build gates (`maintenance.md` §13) at the end of each sub-phase.

### 15a — PTY backend + bare terminal (no LLM)

Goal: get a real terminal running in a new tab.

- Add `portable-pty` to `src-tauri/Cargo.toml`. Add `xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links` to `package.json`.
- Create `src-tauri/src/shell/` module per the architecture diagram. Implement `shell_spawn`, `shell_write`, `shell_resize`, `shell_kill`. Stream stdout to the frontend via `shell://output` events. Register commands in `lib.rs` using full module paths (`maintenance.md` §6).
- Add `Shell` to the activeTab union (`activeTab.svelte.ts`) and the TabBar (`TabBar.svelte`).
- Create `src/lib/components/shell/ShellTab.svelte` and `Terminal.svelte`. xterm.js mounts on `onMount`, calls `shell_spawn`, wires output events back into the terminal, sends keystrokes via `shell_write`, calls `shell_resize` on size changes.
- Kill the PTY on tab unmount and app close.

**Done when**: switching to Shell shows a bash prompt; the user can run `ls`, `vim foo.txt`, `htop` and exit cleanly; resizing the window resizes the shell.

### 15b — OSC 133 shell integration + context capture

Goal: the app knows where commands start and end, and knows about the environment.

- Ship `resources/shell-integration/haruspex.bash` and `haruspex.zsh`. Hooks emit OSC 133 A (prompt start), B (prompt end / command start), C (command output start), D (command end) and OSC 7 (cwd). Sourced automatically on PTY spawn by injecting `source /path/to/haruspex.bash` into a temp rcfile pointed at by `--rcfile`, or by exporting `ZDOTDIR` for zsh.
- In `shell/integration.rs`, parse the marker bytes out of the output stream as it flows by. Maintain a ring of `{ marker, byte_offset_in_session_buffer, cwd_at_time }`.
- Capture session context at spawn in `shell/context.rs`: read `/etc/os-release`, `uname -a`, the shell binary and `--version`. Cache on the Session.
- Implement `shell_get_last_command` (returns text between the two most recent A markers, plus the command and output ranges), `shell_get_context`, `shell_get_recent_history` (reads `HISTFILE` for bash/zsh).
- Frontend: track text selection in xterm.js (`onSelectionChange`). Toolbar Submit button title flips between "Submit last command" and "Submit selection" depending on selection state.

**Done when**: a button click prints the captured region into a debug overlay; selection-vs-default behavior is correct; the captured `SessionContext` matches what `uname -a; cat /etc/os-release; echo $SHELL` produces.

### 15c — Shell-mode fs_read tools

Goal: the agent can read any file the user can read.

- Add Rust commands `fs_read_text_absolute`, `fs_read_pdf_absolute`, `fs_list_dir_absolute` to `fs_tools` (probably as a new sub-module `fs_tools/absolute.rs` to keep the workdir-relative ones untouched). They skip `resolve_in_workdir` and just open the path directly. Return clear errors for missing / unreadable paths.
- In `tools/fs-read.ts`, change the existing fs_read tool registrations to check `ctx.shellMode`. When true, dispatch to the `_absolute` Rust commands; when false, behave exactly as today. The schema description gets a small "(filesystem access is unrestricted when used from the Shell tab)" note.
- Extend `LoopContext` with `shellMode?: boolean` (default false).
- Tests: `fs-read.test.ts` covers both branches; the absolute path branch reads `/etc/os-release` and asserts a non-empty body.

**Done when**: a unit test for the Shell agent loop (no UI) can call `fs_read_text` on `/etc/os-release` and get its contents back. The Chat tab fs_read tools still refuse absolute paths outside the workdir.

### 15d — Shell agent driver + chat sidebar (LLM end-to-end)

Goal: clicking Submit produces a streaming LLM response.

- Create `src/lib/shell/runShellTurn.ts`. Models `runEphemeralTurn` but writes streaming chunks into the shell store's `messages` array instead of into a callback. Acquires the existing `inferenceQueue` ticket with consumer `'shell'`.
- Create `src/lib/stores/shell.svelte.ts` with `messages`, `sidebarOpen`, `submit(scope)`, `newChat()`, `pendingPaste`.
- Build the system prompt fragment in `src/lib/shell/system-prompt.ts`: include the captured `SessionContext`, current cwd, recent history, and the rules ("you may suggest shell commands inside fenced bash code blocks; the user — not you — decides whether to run them"). Mount it via the existing system-prompt composition pattern (`src/lib/agent/system-prompt.ts`).
- Create `ChatSidebar.svelte`. Reuse `ChatMessage.svelte` for rendering. Wire the Submit button in the toolbar to `shellStore.submit(scope)`. Add keyboard shortcut handler (`Ctrl+Shift+L`) at the ShellTab level.
- Right-click context menu on the terminal: one entry, "Send to LLM," that calls `shellStore.submit(scope)`.

**Done when**: a real LLM round-trip works end-to-end with web search, fs_read, and prose suggestions visible in the sidebar.

### 15e — Suggested-command cards + click-to-paste + risk badges

Goal: low-friction paste, never auto-execute.

- Create `src/lib/shell/markdown-shell.ts` — markdown post-processor or custom renderer hook for `markdown.ts` that turns any fenced code block tagged `bash`, `sh`, or `shell` inside the Shell sidebar into a `<SuggestedCommand>` component. (Markdown rendering elsewhere unchanged.)
- Create `SuggestedCommand.svelte` — code block + copy button + paste-into-shell button. Default click on the block paste-into-shells (matches the "click → paste" answer); the copy button is a tertiary action.
- Create `src/lib/shell/risky-commands.ts`. Returns `{ matched: boolean, reasons: string[] }` for a command string. Patterns per Design Decisions. `SuggestedCommand.svelte` renders a `<RiskChip />` per reason at the top of the card.
- Implement the paste action: `shellStore.requestPaste(text)` → checks the typed-bytes counter (tracked in `integration.rs` between OSC 133 B and the next OSC 133 C, exposed as a `shell_get_prompt_input_length` command, or tracked frontend-side from what the user has typed) → either writes bytes to PTY or opens `PasteConflictModal.svelte`. The modal uses `Modal.svelte` + `ModalButton.svelte` (`maintenance.md` §9).
- "Yes, replace" path writes `\x15` (Ctrl+U, kill-line) followed by the command bytes. Never writes `\n`.

**Done when**: clicking a `bash`-tagged code block from the LLM types its content at the prompt; risky commands show a red chip; modal fires when there's already input.

### 15f — Settings + polish

Goal: ship-ready.

- Add `ShellSection.svelte` under `components/settings/`. Fields: shell binary path (default = detected `$SHELL`), submit shortcut (read-only display in v1; customization deferred), sidebar default state. Mount from `settings/+page.svelte` per `maintenance.md` §8.
- Add the matching settings fields to the settings store (`src/lib/stores/settings.ts`): `shellBinary?: string`, `shellSidebarDefaultOpen: boolean`.
- Document the Shell tab in `README.md` (one paragraph + screenshot) and update `maintenance.md` to add a "Shell tab" section under §11a Jobs explaining: PTY lifecycle, OSC 133 dependency, shellMode tool flag, where to add a new risky-pattern.
- Final pass on ESLint complexity — break any file that crosses 400 LOC or any function over 80 LOC (the gates in `maintenance.md` §14).

**Done when**: build gates green, no new warnings in previously-clean files, Settings → Shell section is functional.

---

## Risks / Open Questions

- **OSC 133 hook injection.** Bash + zsh both have mechanisms (`--rcfile`, `ZDOTDIR`) but they also load the user's normal rc files. We need to source ours *after* the user's so prompt overrides don't clobber the markers. zsh requires writing a one-line `.zshrc` in `ZDOTDIR` that sources the real `~/.zshrc` then our hook. Bash's `--rcfile` replaces `~/.bashrc`, so our injected file must source it explicitly. Both are well-trodden patterns (VS Code's terminal does this) but worth a dedicated spike in 15b.
- **Filesystem access route.** Two implementation choices for the "shell mode bypasses workdir" requirement:
  - **(A)** parallel Rust commands `*_absolute` (chosen in this plan for clear surface area)
  - **(B)** pass an `absolute: bool` argument to the existing commands and branch in `resolve_in_workdir`
  Choice B is fewer files but couples the chat-restricted commands to an "unrestricted" code path that could leak via a future bug. Choice A keeps the audit surface explicit. Revisit if `_absolute` parity becomes a maintenance burden.
- **Typed-bytes tracking.** Detecting whether the prompt is empty before paste is heuristic. If the user's shell prompt redraws (e.g. `oh-my-zsh` `vi-mode` indicators move the cursor), the count can drift. Mitigations: (i) reset the counter on every OSC 133 B; (ii) treat any `\r` / `\n` as a reset. If this proves unreliable we can fall back to always prompting on paste (degrades UX, never destroys input).
- **Search backend rate limits.** The Brave free tier (2k/month) is shared with Chat and Jobs. Heavy Shell-tab use during a long troubleshooting session could exhaust it quickly. No mitigation needed in this phase — surface the existing quota errors clearly and document. Users on SearxNG (self-hosted) have no quota.
- **Risky pattern false negatives.** The pattern list is short on purpose. We will not catch obfuscated forms (`sudo`, base64-piped `eval`s, etc.). The user always presses Enter. Documented limitation, not a bug.
- **fish / nu users.** Smart-default capture won't work without an OSC 133 hook. Plan documents this; selection-based submit covers them. Hooks for fish (`fish_prompt`) can be added in a follow-up phase if there's demand.
- **Process leaks.** A panicking PTY thread must not orphan the bash process. `session.rs` must own the PTY master in a `Drop` that calls `kill_process_on_port`-style cleanup. Smoke test: spawn 100 PTYs in a tight loop in `cargo test`, assert no orphans via `pgrep`.

---

## Out of Scope (Explicitly Deferred)

- **Multi-shell tabs within Shell view.** The store carries `sessionId` but the UI is single-session. Phase-15.x or a later phase can add the tab strip.
- **Persisted shell-troubleshooting history.** No SQLite tables. If users ask for "remember my last 5 troubleshooting sessions," that's a future phase.
- **Shell auto-execute of suggestions.** Will not be added. The architecture has no code path from the LLM to the PTY write that bypasses a user click.
- **fs_write from the Shell agent.** The Shell agent suggests; the user runs. If the user wants the model to write a file, they can switch to the Chat tab where fs_write is wired up.
- **macOS and Windows.** Designed for cross-platform via `ShellPlatform` abstraction; implementation is a future phase.
- **Per-tab shortcut customization.** Submit shortcut is fixed at `Ctrl+Shift+L` in v1.
- **Sub-agent / deep research mode in Shell.** `research_url` is available but the "deep research" flag from Chat is not surfaced in Shell. The expected interactions are short and iterative.
- **Job integration.** A Job that runs a shell command is out of scope; jobs use the LLM tool surface, not the Shell tab's PTY.

---

## Test Prompts (smoke at the end of 15f)

1. *"List all installed Python packages and tell me which ones are out of date."* → expect web tool use or `apt`/`pip` suggestions; suggestion cards clickable.
2. *"My nginx config has a syntax error, can you find it?"* → agent reads `/etc/nginx/nginx.conf` via fs_read absolute, points to the line.
3. *"What does this error mean?"* (after a `cargo build` failure with a long error) → submit by selection over the error block; agent gives a concrete fix suggestion.
4. *"Find the largest files in /var/log."* → agent suggests `du -h /var/log | sort -h | tail`; click pastes; user presses Enter.
5. *(Negative)* *"Delete all my temp files."* → agent suggests `rm -rf` — verify it renders with the destructive warning chip.
