# Phase 6 — `open_in_shell` and `open_in_editor`

**Depends on:** 5 · **Guide:** `code.md` (both tools, the Open in Shell
button), `shell.md` (tabs opened by the Code tab)

## `open_in_shell` (agent tool + command-card button)

Args: `{ command: string, reason?: string }`.

1. Boundary check as for `run_command` (the command still runs in the session
   folder). No risk-approval prompt — the user is about to see the command and
   press Enter themselves, which *is* the approval.
2. Bridge: `src/lib/code/shellBridge.ts` exports a handler slot the shell store
   registers on load (`registerShellCommandOpener`), so the Code store never
   imports the shell store. The handler:
   - creates a shell session (`createShellSession()`), `initialCwd = root`,
     name `"<session title> · sudo"` (or the command's first word);
   - waits for the PTY + shell integration to be ready;
   - pastes the command **without Enter** (`toBracketedPaste(cmd, false)`);
   - switches the main window to the Shell tab (always a new tab there, even
     when the Code session is detached — the detached window raises the main
     one);
   - polls `completed_total` as `ShellPane.executeRunCommand` does, then reads
     the region from `shell_get_recent_commands`;
   - resolves `{ exitCode, output (tail, truncated as run_command), cwd }`,
     or `{ closed: true }` if the tab is closed first.
3. While waiting, the session status is `waiting-shell` and the transcript
   shows "Waiting for you in Shell N — press Enter there" with a *Go to shell*
   link and *Cancel*. Cancel / Stop abort the wait (the shell tab stays).
4. If the user edits the command before running it, the result reports the
   command that actually ran (from the captured region), so the agent knows.
5. Shells without integration (e.g. fish without the hook): the paste
   still happens, but completion can't be detected — resolve immediately with
   "Opened in Shell N; ask the user for the result." Only offered where the
   Shell tab works at all (`shell_platform_supported()`).

The command card's *Open in Shell* button calls the same handler but doesn't
wait — it's the user's own action, not a tool call.

## `open_in_editor` (agent tool)

Args: `{ paths: string[], reason?: string }`. Resolves each against the
session root, refuses anything outside it, calls `editWorkdirFiles({ workdir:
root, files, title })` **without awaiting** the save, and returns at once
("Opened N files in the editor"). The tool is for "have a look at this", not
for waiting on user edits — if the agent needs the user's edits, it asks.

## Clickable paths

In `CodeTranscript`, file paths in tool cards (read/edit/write/grep hits) and
`path:line` in assistant markdown open the editor at that file. Paths outside
the root are not linked. Extend `markdown.ts`'s link handling with a
`code-path` rule active only in the Code transcript.

## Tests

Bridge: paste-without-enter, completion → result, tab closed → closed result,
abort; no-integration fallback. `open_in_editor` refuses out-of-root paths and
doesn't await. TTY hint (phase 2) now names the real tool.

## Done when

The agent hits a sudo command, the TTY hint suggests `open_in_shell`, the
user lands in a Shell tab at the right folder with the command typed, enters
their password, and the agent continues with the result.

## As built

- Bridge: `code/shellBridge.ts` holds the opener slot plus a per-session wait
  channel (`reportShellWait` / `setShellWaitListener`), so neither the tool nor
  the Code store touches the shell store. The shell side is
  `shell/openForCommand.ts` (dependency-injected; the shell store registers it
  on load).
- Waiting: poll `boundSessionId` until the pane spawns the PTY (15 s), then
  `marker_total > 0` (5 s; none means no integration → "ask the user"), paste
  with `toPtyPaste(cmd)` (no Enter), then poll `completed_total` past the
  pre-paste count and read the newest non-pending region. Closed = the PTY
  stops answering `shell_get_context` or `shell://exit` fires for it. A
  detached tab keeps being followed by PTY id.
- The new tab keeps its default "Shell N" name (the plan's
  "<title> · sudo" would not match the "Waiting for you in Shell N" text).
- Cancel (transcript) aborts only the wait; the tool returns "the user stopped
  waiting". Stop aborts the turn. Both leave the tab open.
- Boundary: `checkCommandBoundary` was split out of `ensureCommandApproved`; a
  boundary hit still asks (attended), but no risk prompt.
- Platform gate: `shell/platformSupport.ts` caches `shell_platform_supported`;
  `runCodeTurn` loads it and the registry drops `open_in_shell` when false.
- TTY hint names `open_in_shell` in the Code tab only; Shell Code mode's
  one-shot fallback keeps the Shell-tab wording.
- Paths: `code/paths.ts` (lexical, no disk). Markdown links `path:line` in
  backticks and prose (needs a slash or a line, and an extension) only when
  `renderMarkdown` gets a linker — the Code transcript. The editor has no
  line positioning, so `:line` opens the file at the top.
- Not done: raising the main window from a detached Code window (phase 7).
