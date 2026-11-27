# Phase 8 — Shell: Read-only / Full access

**Depends on:** 5 (for "Open in Code") · **Guide:** `shell.md`, `settings.md`, `code.md`

## Goal

The Shell assistant's Code button becomes a **Read-only / Full access** toggle
(lock icon). Full access keeps today's tools and drops the coding prompt and
saved threads.

## Changes

- `ShellSession.codeMode` → `fullAccess` (and `shellCodeModeDefault` →
  `shellFullAccessDefault`, migrating the setting value once in
  `stores/settings.ts`). The registry flag passed is still `codeMode: true`
  with `shellMode: true` — the tool set is unchanged (decision 12).
- System prompt: Full access uses the shell assistant prompt plus a short
  "you can run commands in the user's terminal and edit files" addendum; the
  coding prompt now lives only in `src/lib/code/system-prompt.ts` (phase 4).
- Remove cwd persistence: `persistCodeThread`, `restoreCodeThread`,
  `maybeRestoreForCwd`, `settleRestoreBeforeTurn`, `restoreCheckedCwds`,
  `restoredNotice` and its UI, `db_*_shell_session` commands,
  `db/shell_sessions.rs`, and the re-export of `codeSession.ts`.
- Migration: `DROP TABLE IF EXISTS shell_code_sessions` (decision 8 — no import).
- **Open in Code** button in the shell assistant header: creates a Code session
  rooted at the shell's current cwd via a bridge (`openCodeAt(root)` in
  `src/lib/code/bridge.ts`, same handler-slot pattern as phase 6) and switches
  to the Code tab. The shell thread is not carried over.
- Settings → Shell: drop what moved to Settings → Code in phase 5; keep the
  terminal-run approval behaviour and the PTY-vs-one-shot override.

## Tests

Update `shell.test.ts` / `runShellTurn.test.ts` for the rename and the removed
restore paths; settings migration of the default; Open in Code calls the
bridge with the live cwd.

## Done when

No code keys anything on a cwd; the Shell toggle reads Read-only / Full
access; the old table is gone.

## As built

- **Mode:** `ShellSession.codeMode` → `fullAccess`, seeded from
  `shellFullAccessDefault`. The registry still gets `codeMode: true` with
  `shellMode: true`, so Full access has exactly the tools Code mode had
  (`CODE_TAB_ONLY` stays off for the Shell). Iterations, the file-write
  ceiling and auto-approve still come from Settings → Code.
- **Prompt:** `buildShellSystemPrompt({ …, fullAccess })`. Full access is the
  Read-only prompt minus its two read-only lines ("You are read-only…", "You
  have no execute tool…"), with the nested-session advice for driving the
  session, plus a `FULL ACCESS` addendum: `run_command` (sticky cwd,
  timeout from Settings → Code, background/watch), `shell_read` /
  `shell_input` / `shell_interrupt` / `shell_snapshot`, the edit and search
  tools, "don't leave a program holding the terminal", and the two
  environments. `buildShellCodeSystemPrompt` and `buildSessionBlock`'s
  export are gone; `code/system-prompt.ts` is the Code tab's alone. No
  `HOW TO WORK` block and no custom instructions (the shell prompt never
  carried them).
- **Removed:** `persistCodeThread`, `restoreCodeThread`, `maybeRestoreForCwd`,
  `settleRestoreBeforeTurn`, `restoreCheckedCwds`, `restoredNotice`,
  `startFreshCodeThread`, `dismissRestoredNotice` and the sidebar's
  Restored / Keep / Start fresh bar; `shell/codeSession.ts`;
  `countTurns`; the `dbSaveShellSession` family; `db_*_shell_session` and
  `db/shell_sessions.rs`. The migration runs `DROP TABLE IF EXISTS
shell_code_sessions` in place of the old `CREATE`.
- **Setting:** `load()` maps a stored `shellCodeModeDefault` to
  `shellFullAccessDefault` when the new key is absent and drops the old
  key, so the next save writes only the new one.
- **Toggle:** a `.toggle` button in the assistant header with a lock (closed
  / open) and **Read-only** / **Full access**, `aria-pressed`, detail in the
  `title`. The header's actions now wrap rather than break labels.
- **Open in Code:** `code/bridge.ts` (`registerCodeOpener`, `useCodeRelay`,
  `openCodeAt`, `relayToMain`). The Code store registers
  `openCodeSessionAt(root)`: `newSession` (which claims), `codeLastRoot`,
  Code tab. `ShellSession.openInCode` reads the live cwd through
  `shell_get_context` at click time; no cwd is an error toast. A detached
  Shell window installs `relayToMain`, which emits `code://open-at` to main;
  `listenInMainWindow` opens it there (`openAtHandler`) and raises main.
  Hidden where the Code tab is (Windows).
- **Detached Shell windows** now keep the mode across the move
  (`?access=full` on the way out, `fullAccess` in the re-attach payload;
  beyond the plan) and render the agent approval modals
  (`windowRoutes.ts` `rendersAgentModals`, #413).
- **Settings → Shell:** the "Code mode" group is "Full access": the default
  toggle (detail in a `title`) and command execution; memory limit stays.
  Nothing Code-only was left there.
- **Wording:** `/init` outside Full access, the startup notice and the guide
  pages (`shell`, `settings`, `code`, `skills`, `images`, `models`,
  `troubleshooting`, `getting-started`, `shortcuts`) and README say Full
  access instead of Code mode.
- **e2e:** `e2e/ui/shell.spec.ts` (toggle, Open in Code, a detached shell's
  approval modal); the mock terminal's `shell_get_context` carries a
  `context`, and a few shell reads gained mocks.
