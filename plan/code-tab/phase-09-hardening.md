# Phase 9 — Hardening

**Depends on:** 1–8 · **Guide:** sweep of `code.md`, `shell.md`, `settings.md`,
`shortcuts.md`, `getting-started.md` (mention the tab)

## Cross-platform

- **macOS:** bash 3.2 is the system bash — check `pipefail`/arrays the prompt
  encourages still work; `sudo` TTY message differs, add it to the matcher.

## Load and failure cases

- Three sessions queued on the local model: statuses correct, Stop on a queued
  one dequeues it.
- App killed mid-turn: session reloads with the partial turn; background
  processes reaped by `orphans.rs`.
- Session folder deleted or moved: the session opens read-only with a banner
  ("Folder not found") and can be deleted; no tool runs.
- A background process that ignores SIGTERM is SIGKILLed.

## Docs and follow-ups

- Final pass over the guide pages; each under 6 KB.
- File GitHub issues (one checklist issue, per CLAUDE.md):
  - Checkpoints / undo per turn (decision 7).
  - Anything cut during implementation.
  - Hand tests owed (add to #389 if it's still open).
- Move `plan/code-tab/` to `plan/archive/` once merged.
