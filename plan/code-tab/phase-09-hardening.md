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
- Two sessions hitting a risky command at once: the approval modal takes one
  prompt at a time, so the second currently gets a tool error. Queue the
  prompts instead (found in phase 4).

## Docs and follow-ups

- Final pass over the guide pages; each under 6 KB.
- File GitHub issues (one checklist issue, per CLAUDE.md):
  - Checkpoints / undo per turn (decision 7).
  - Anything cut during implementation.
  - Hand tests owed (add to #389 if it's still open).
- Move `plan/code-tab/` to `plan/archive/` once merged.

## As built (9a)

Sessions and folders. 9b (approval queue, repeat-write guard, loop split,
macOS wording) is a separate branch.

- **Folder not found:** `CodeSession.folderMissing`, set by `checkFolder()`
  (`code_folder_exists`, a plain `is_dir`) when a session is opened or
  activated (`setActiveSession`), on window `focus` (`CodePane`), as a turn
  starts, and after it ends. Never while a turn runs: its tools fail as
  before and the end-of-turn check shows the banner. A turn that finds the
  folder gone at its start never runs; the message goes back to the input
  box. `FolderMissingBanner` ("Folder not found: <path>", **Choose folder…**,
  **Delete session**, each confirmed) sits under the header; the composer is
  disabled with that text as placeholder and `title`, and forking says the
  same. Nothing offers to create the folder. **Choose folder…** calls the new
  `code_session_set_root` (canonical, must be a directory, `updated_at`
  untouched; the `worktree` is forgotten unless the new root is inside it)
  through `CodeSession.moveTo`, so `root` and `worktree` are now `$state`.
  Detached windows got `dialog:allow-open` for the picker (beyond the
  plan's "no dialogs" for `code-*`), and close themselves after a delete.
- **Unsent input:** the composer registers `setDraftReader`;
  `handOffSession` reads it before the sub-tab goes and puts `{ text,
  images }` in the handoff (`Handoff.draft`, beside `watches`); the next
  `openSession` sets it as the session's `prefill`. Both directions, and a
  failed window creation, use the same path.
- **Detached marker:** Rust emits `code://claims` (no payload) on a claim that
  succeeds, every release, and a window with claims closing.
  `CodeSidebar` reads `code_session_open_ids` on mount and on each event; a
  claimed id that isn't a sub-tab here gets **⧉** (`title`), and the row's
  tooltip says it is open in its own window. The e2e mock now keeps real
  claims (it used to report every saved session as open).
- **Notices across a restart:** `code_file_notices` (id, folder,
  session_id, title, files JSON, at) replaces the in-memory list;
  `CodeFolders` keeps only the leases and the clock, which starts past the
  newest stored notice, so times still strictly increase. `code_sessions`
  gains `notices_seen_at` and `agent_branch` (`NULL` never told, `''` no
  branch), written by `code_session_save` with each turn and read back as
  the session's `since` and `branchSeenByAgent`. A notice is dropped once
  every other saved session in an overlapping folder has a `notices_seen_at`
  (or, before that was kept, `updated_at`) past it, after 24 h, or past the
  newest 200. The record and take commands are now async (`spawn_blocking`).
- **Lighter remarks:** a step's `lead` renders as inline markdown
  (`renderMarkdown` with the session's path linker) in secondary text, with
  no header, copy or fork button; path links and ordinary links work as in
  answers.
- **Stop while queued:** `withInferenceSlot` already cancelled a waiting
  ticket on abort. Two fixes: Rust remembers an `inference_cancel` that
  overtakes its `inference_acquire` (64 ids) and refuses the acquire, which
  could otherwise wait in the queue with nobody left to want it; and the
  store treats a typed turn aborted before admission as never started: the
  opening message leaves the thread, nothing is saved, the text (as typed,
  without a skill's `/name`) and images go back to the input box with any
  steering queued behind it, and the notices it took are untold. A watch
  notification stopped in the queue keeps the old behaviour.
- **Not done here:** the `code` guide page (owned by 9b) doesn't yet say
  that Stop on a queued turn hands the message back, or describe the lighter
  remarks.
