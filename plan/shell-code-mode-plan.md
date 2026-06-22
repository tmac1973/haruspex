# Shell-Assistant Code Mode — Implementation Plan

Merge the **Code tab** into the **Shell tab's assistant** behind a per-session
**Code** toggle. In Code mode the assistant gains the coding toolset (grep /
glob / read / write / edit / run) and a coding prompt, **runs its commands in
your real interactive PTY** (sharing your live shell state), and keeps the
Shell tab's existing strengths: the interactive terminal, auto-passback of
recent command output, and the "recommend → click Run" flow. The standalone
Code tab is removed.

This is an **experimental fork** — branch from the merged code-tab work (PR
#131 / `feat/code-tab`), since it reuses those tools (code_grep, code_glob,
fuzzy edit, run_command, the approval store, the code system prompt).

---

## Design decisions (settled)

| # | Decision | Choice |
|---|---|---|
| 1 | How the agent runs its own commands | **Drive the real PTY** (inject + capture via shell integration); fall back to one-shot `run_command` |
| 2 | User input while the agent's command runs | **Lock the terminal** (disable input, show "agent running…", Stop = Ctrl-C) |
| 3 | Commands that don't return (dev servers) | **Timeout → leave running ("background"), unlock, report "still running"** to the agent |
| 4 | Approval before agent commands run | **Risk-classifier gate** (auto-run safe; prompt risky; per-session allow-all + settings opt-out) |
| 5 | File-edit tools in Code mode | **On by default** (regardless of the Shell "allow write" setting) |
| 6 | The standalone Code tab | **Removed** in this change |
| 7 | PTY-vs-one-shot fallback | **Both**: auto-detect integration availability; plus a manual override setting |
| 8 | The header "thinking" toggle | **Per-session override, both modes**; initialized from the global Reasoning setting |
| — | Working directory | **Dropped** — fs/exec tools resolve against the PTY's live CWD (`shellCwd`), like the Shell assistant does today |

---

## What we reuse (grounded in the current code)

The Shell tab already contains the entire inject → wait → capture pipeline:

| Need | Existing primitive |
|---|---|
| Inject a command into the PTY | `shell_write` (`shell/mod.rs`) + `toBracketedPaste(cmd, execute=true)` (`shell/commandBlock.ts`) |
| Know when a command finished | monotonic `completed_total` from `output_end_total` via `shell_get_context` — poll until it increments (the **proven** pattern in `ShellPane.executeRunCommand`, ~400ms/60s) |
| Get a command's output + exit code + cwd | `CapturedRegion { commandLine, output, exitCode, cwd, truncated, pending }` via `shell_get_recent_commands` / `capture_recent_commands_with_pending` (includes the still-running command) |
| Risk gating | `classifyShellRisk` + the `codeCommandApproval` store + `CommandApprovalModal` (from the code-tab work) |
| Coding toolset | `code_grep`, `code_glob`, `run_command`, hardened `fs_read/write/edit` (already shell-CWD aware) |
| Coding prompt + reasoning/maxtokens plumbing | `buildCodeSystemPrompt`, the `thinkingEnabled` / `maxResponseTokens` loop overrides (already shipped) |
| Auto-passback | `formatRecentCommands` + `shell_get_recent_commands` in `shell.svelte.ts` |

**Build new:** the agent-driven PTY execution orchestration (inject → lock →
poll-to-completion → capture → timeout/abort handling), the terminal-lock
state, the combined Shell+Code tool-filter mode, and the assistant header
toggles. **Platform note:** shell integration is Linux/macOS only — on Windows
(or any session without integration) Code mode uses the one-shot fallback.

---

## STEP 1 — Combined Shell+Code mode in the tool layer

Today `shellMode` and `codeMode` are mutually exclusive in the filter
(`shouldIncludeTool` checks shellMode first). The Shell assistant in Code mode
is **both**: shell-style path resolution (live CWD, no project-root sandbox)
**plus** the code toolset.

1. **Filter precedence** (`tools/registry.ts`): check `codeMode` *before*
   `shellMode`, so a shell session with Code on exposes `CODE_TOOLS`.
2. **Shell-style dispatch in Code mode**: `code_grep` / `code_glob` use
   `ctx.shellCwd` as their root when `ctx.shellMode` (else `ctx.workingDir`);
   `fs_read/list` already branch to the `*_absolute` commands under shellMode.
3. **Writes on in Code mode**: `shellAwareWriteText` / `shellAwareEditText`
   currently require `shellMode && shellAllowWrite` to take the absolute path.
   Change the condition to `(shellMode && shellAllowWrite) || codeMode` so Code
   mode can edit against the live CWD regardless of the Shell write setting.
4. **Thread the PTY session id**: add `shellSessionId?: number` to
   `ToolContext` (the run tool needs it to inject/capture). Populated from the
   active shell session at turn start.
5. **`run_command` working dir**: in shell+code mode it targets `ctx.shellCwd`.

**Tests:** code mode inside a shell session exposes exactly `CODE_TOOLS`;
`code_grep`/`code_glob` root = shellCwd; fs_write/fs_edit dispatch absolute
even with `shellAllowWrite` off; `exec` still absent from plain Chat/Shell.

**End state:** the registry understands the combined mode; nothing drives it yet.

---

## STEP 2 — PTY-driven command execution

Make `run_command` (category `exec`) execute in the live PTY when it can, and
fall back to the one-shot capture otherwise.

### 2a. Execution orchestration (TS, reusing existing IPC)
Mirror `ShellPane.executeRunCommand`, but agent-oriented and inside the tool:

1. Resolve `ctx.shellSessionId`; if absent, integration unsupported
   (`shell_platform_supported() === false`), or the manual override forces
   one-shot → **fall back** to `run_command_capture` with `cwd = ctx.shellCwd`.
2. `classifyShellRisk(command)` → if risky and not auto-approved, `askCommandApproval`
   (reuse `codeCommandApproval`; deny returns a denial result).
3. **Lock the terminal**: set a per-session `agentPtyBusy` flag (Step 2c).
4. Snapshot `completed_total` (`shell_get_context`).
5. `shell_write(toBracketedPaste(command, true))`.
6. Poll `completed_total` (~250ms) until it increments (command done) or the
   timeout fires. Honor `ctx.signal`: on abort, send Ctrl-C (`shell_write('\x03')`)
   and return an aborted result.
7. **Done** → `shell_get_recent_commands(1)` → format `Exit {code} (cwd …)\n{output}`,
   middle-truncated past ~16KB with the overflow spilled to a temp file
   (reuse `truncateCapturedOutput` + `code_write_overflow`).
8. **Timeout** → fetch the *pending* region (`capture_recent_commands_with_pending`),
   return "Command still running in your terminal after Ns — output so far: …".
   Leave it running and **unlock**. (See risk note on foreground job-control.)
9. Always clear `agentPtyBusy` (unlock) in a `finally`.

Use the Code-tab `codeRunCommandTimeoutSecs` setting for the timeout.

### 2b. Fallback wiring (decision #7 = both)
- **Auto**: at turn start, probe `shell_platform_supported()` + whether the
  session has live integration markers; cache on the turn. Per-command safety
  net: if the poll never sees completion *and* no output was captured (garbled
  integration), fall back to one-shot for that command and note it.
- **Manual**: a Settings toggle — "Run agent commands in the terminal (PTY)"
  vs "one-shot capture" — that forces a mode.

### 2c. Terminal lock (decision #2)
- Add `agentPtyBusy` reactive state to `ShellSession`.
- `Terminal.svelte`: when busy, swallow `onData` keystrokes (or detach the xterm
  input handler) and show an overlay/indicator; a **Stop** control sends Ctrl-C
  via `shell_write` and cancels the agent turn.

**Tests:** PTY path injects bracketed-paste + polls + formats the captured
region (mocked IPC); unsupported platform / manual override → one-shot path;
abort sends `\x03`; timeout returns the pending "still running" result.

**End state:** the run tool drives the PTY (with graceful fallback); still inert
until a turn sets `codeMode`.

---

## STEP 3 — Assistant Code toggle, per-session thinking, coding prompt

1. **Header controls** (`shell/ChatSidebar.svelte`): next to "New Chat", add a
   **Code** toggle and a **Think** toggle (pill buttons like the chat research
   toggle). Both are per-`ShellSession` state.
2. **ShellSession state**: `codeMode: boolean` (default off) and
   `thinkingEnabled: boolean` (initialized from the global Reasoning setting at
   session creation; decision #8). `resetSessionApproval()` when Code mode flips
   off, and when the session's CWD changes project roots (best-effort).
3. **`runShellTurn` extensions**: pass through `codeMode`, `codeAutoApprove`
   (from settings), `thinkingEnabled` (session override), and
   `maxResponseTokens` (16384 when thinking on, else default) — the loop already
   accepts all of these from the code-tab work. When `codeMode`, set
   `codeMode: true` on the loop options (keep `shellMode: true` too, so fs tools
   stay CWD-aware); `shellCwd` continues to carry the live directory.
4. **Prompt**: build the coding system prompt when `codeMode`, else the existing
   shell prompt. Adapt `buildCodeSystemPrompt` into a shell variant: no "project
   root" framing — "you are working in the user's interactive shell at {cwd}",
   commands run in their real terminal (shared venv/env), keep the scratchpad
   convention. Reuse the auto-passback of recent commands in both modes.
5. **Approval modal** stays mounted globally (`CommandApprovalModal`); the
   manual "Run" button flow is unchanged and coexists.

**Tests:** toggling Code mode swaps the tool set + prompt for that session;
the Think toggle flips the per-session reasoning override (verified through the
existing `getChatTemplateKwargs` / `getSamplingParams` override tests);
chat-mode shell turns are unchanged.

**End state:** the Shell assistant has full Code-tab functionality.

---

## STEP 4 — Remove the Code tab

1. Delete `CodeView.svelte`, `stores/code.svelte.ts`, `code/runCodeTurn.ts`,
   `code/system-prompt.ts` (after extracting the prompt into the shell variant),
   the `code` `TabBar` entry, `activeTab` `'code'`, the `+page.svelte` branch,
   and the `CodeSection` settings category.
2. **Move Code settings into Settings → Shell** (or rename it "Shell & Code"):
   `codeAutoApprove`, `codeRunCommandTimeoutSecs`, the PTY-vs-one-shot override.
   Keep `codeThinkingEnabled`? No — superseded by the per-session toggle; drop
   it (or repurpose as the default the session initializes from).
3. Keep the shared pieces: `code_grep`/`code_glob`/`run_command` tools,
   `codeCommandApproval` + `CommandApprovalModal`, the fuzzy edit, the loop
   overrides. F2/F3 routing already covers the shell session — drop the `code`
   branch added for the tab.
4. Update/remove the code-tab tests; keep the tool/loop/settings tests.

**End state:** Code lives only as the Shell-assistant toggle; one tab fewer.

---

## STEP 5 — Verification

- Full `cargo` + `vitest` suites green; `cargo fmt`/`clippy`, `npm run check`,
  ESLint, Prettier clean.
- Manual smoke on a real repo **in a shell with a venv activated**: toggle Code
  on, ask it to grep → read → edit → **run the tests in the terminal** and
  confirm (a) the command appears in your scrollback, (b) it uses the activated
  venv (the whole point of PTY-driving), (c) output + exit code come back to the
  assistant, (d) the terminal is locked during the run, (e) a risky command
  prompts, (f) a dev server times out and is reported "still running", (g)
  Stop/Ctrl-C interrupts, (h) on a non-integrated shell it falls back to
  one-shot.

---

## Key risks & open points

1. **PTY capture reliability is the whole bet.** Agent commands with heavy ANSI
   (TUIs, progress bars, pagers like `less`) may capture messily even with
   `render_terminal()`. Mitigations: the auto one-shot fallback; advise the
   prompt to prefer non-interactive flags (`--no-pager`, `CI=1`); per-command
   fallback when capture looks empty/garbled.
2. **"Background on timeout" is shallow in v1.** A timed-out command is still
   **foreground** in the PTY, so the agent can't run another command until it
   ends or is interrupted. v1: report "still running", unlock, let the user
   decide; the agent should stop or wait. True job-control (Ctrl-Z + `bg`, or
   appending `&` for known-daemon commands) is a follow-up.
3. **Interleaving / focus.** Locking input prevents the user clobbering the
   command, but selection/scroll should still work. Confirm the lock doesn't
   trap the user if a turn errors (always clear in `finally`; Stop always frees).
4. **`cd` persistence.** Because commands run in the live PTY, an agent `cd`
   persists for subsequent commands and the user — a feature, but the prompt
   should be explicit that directory changes are real and sticky.
5. **Single-command-at-a-time.** The loop serializes tool calls, so only one PTY
   command runs at once; fine. But the agent must not assume parallelism.

---

## Out of scope (future)

- Job-control backgrounding of long-running commands (dev servers) with
  start/poll/kill — overlaps the original plan's "background jobs" phase.
- Windows PTY integration (Phase 17) — Code mode there is one-shot only.
- Streaming partial command output into the assistant mid-run (v1 returns the
  captured region once the command completes/times out).
