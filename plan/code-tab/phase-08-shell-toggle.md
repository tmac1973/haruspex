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
