# Phase 7 — Fork and detach

**Depends on:** 5 · **Guide:** `code.md`

## Fork from message

- Each user and assistant message gets a *Fork from here* action (message
  menu, next to Copy).
- Calls `code_session_fork { id, at }` where `at` is the index after the
  chosen message, opens the new session as a sub-tab, and focuses its input.
  Forking a user message puts that message's text back in the input instead of
  including it, so the user can edit and resend.
- Background processes are not forked (they belong to the source session).
- The sidebar shows forks under their source with a branch glyph
  (`forked_from`); deleting the source leaves the fork standalone.

## Detach / re-attach

Simpler than the Shell's (`shell/windows.ts`) because nothing live has to
cross windows — the database holds the thread and Rust holds background
processes.

- Detach (strip button, disabled with a tooltip while `status !== 'idle'`):
  save → close the sub-tab in this window without stopping its background
  processes → open `WebviewWindow('code-<id>', { url: '/code/<id>' })`.
- `src/routes/code/[id]/+page.svelte` loads the session and renders the pane
  without the sidebar.
- Re-attach: the window's button emits `code://reattach { id }`, the main
  window opens the session as a sub-tab, the detached window closes.
- **Single owner:** a Rust-side `HashMap<session_id, window_label>`
  (`code_session_claim` / `code_session_release`). Opening a claimed session
  focuses the owning window instead. Released on window close; a claim
  whose window no longer exists is treated as free.
- Closing a detached window behaves like closing the tab (asks about running
  background processes).
- Background-watch completions route to whichever window owns the session —
  the watch handler is registered by the owning window's store.

## Tests

Fork indices (user vs assistant message, first/last); claim/release and stale
claims; detach blocked while running.

## Done when

A session can be forked mid-thread and detached to its own window and back,
and can never be open in two windows at once.
