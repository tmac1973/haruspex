# Phase 7 — Fork and detach

**Depends on:** 5 · **Guide:** `code.md`

## Fork from message

- Each user and assistant message gets a _Fork from here_ action (message
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

## As built

- **Fork:** `code/fork.ts` `forkPoint(messages, index)`: an answer forks at
  `index + 1`; a user message at `index`, with its typed text (`typedText`,
  as the input history does: a skill run gives back the request without
  its `/name`) and images as the new session's
  `prefill`. Tool calls/results can't be forked. The store's `forkSession`
  forks only an idle session (the saved thread is then the one on screen)
  and `forkAndOpen` opens it as a sub-tab; `CodeComposer` takes the prefill
  and focuses the input. The button lives in `ChatMessage`'s footer (new
  `onFork` / `forkBlocked` props; a user message gets a footer that shows on
  hover). Background processes and watches are not forked.
- **Sidebar:** a fork shows `BranchGlyph` and its tooltip says `Forked from
"<source>"` (or "a deleted session", `forkedFromTitle`). Forks stay with
  their folder, ordered by recency, rather than nested under the source —
  the folder grouping from phase 5 already puts them side by side.
- **Claims** (`code_tools/claims.rs`, managed `CodeSessionClaims`):
  `code_session_claim { id } → { owner, handoff }` and
  `code_session_release { id, handoff? }`, keyed by the _calling_ window's
  label. A claim held by a window that no longer exists
  (`get_webview_window` is none) is free; `WindowEvent::Destroyed` drops a
  window's claims. A window can only release its own claim. The store claims
  in `openSession` / `newSession` and releases in `closeSession`; when
  another window owns a session, `openSession` raises it and returns null.
  `deleteSession` refuses (and raises the owner) while another window has it.
- **Handoff (divergence):** the plan said nothing live crosses windows, but
  background _watches_ do: they live in a window's JS context
  (`backgroundWatch.ts`). A release can leave a JSON handoff in the claim map
  and the next successful claim takes it. `handOffSession` (detach and
  re-attach) does `takeCodeWatches` → dispose → release with
  `{ watches }`; `openSession` `adoptCodeWatches` before the new
  `CodeSession` registers its completion handler, then flushes, so a watch
  that finished mid-move is still delivered — by the owning window.
- **Windows** (`code/windows.ts`): label `code-<id>`, route `/code/[id]`
  (`routes/code/[id]/+page.svelte`: header bar with **⇤ Re-attach**, then
  `CodePane`). `detachSession` refuses unless idle (`moveBlockedReason`
  gives the tooltip), hands off, then creates the window (waiting for
  `tauri://created`; on `tauri://error` the session reopens as a sub-tab).
  Re-attach: hand off → `emitTo('main', 'code://reattach', { id })` →
  `destroy()`. The main window's listener (`listenInMainWindow`, started by
  the layout for non-detached routes) switches to the Code tab, opens the
  session and raises itself. The same event carries forks and `/new` made
  in a detached window (with `prefill`), since that window shows one
  session only.
- **Closing** a detached window = closing the tab (`closeSession`: stops the
  turn and background processes, asking first when any run, via
  `onCloseRequested`). Rust `close()`s `code-*` windows with `main`, like
  editors, so each still asks.
- **open_in_shell across windows** (`code/shellRelay.ts`): the detached
  window installs `createShellRelay` with `shellBridge.useShellRelay`, which
  takes precedence over the shell store's opener (that store loads in every
  window via the layout, but only main renders it). Events:
  `code://shell-open` → main answers `shell-accepted` (else "unavailable"
  after 5 s), `shell-opened { name }`, `shell-result { result }`;
  `shell-focus` (Go to shell) and `shell-abort` (Cancel / Stop) go to main.
  The detached side resolves `aborted` at once on abort; main also drops a
  request whose abort overtook it. Main raises itself on open and focus; the
  opener already switches to the Shell tab. The command card's **Open in
  Shell** goes the same way.
- **Layout:** `/code/[id]` is detached (no bootstrap, no MCP servers — code
  turns don't use them, no header, so no status badge; the session header
  names the model). It renders the agent approval modals (each window has
  its own approval stores; detached _shell_ windows render none, which
  looks like a bug of their own — a follow-up). F2/F3 apply there and target the session (`hotkeyTab()`
  instead of persisting the active tab from that window); Ctrl+1–4 don't.
- **Settings:** each window loads them once, so the detached window reloads
  on the `storage` event (`reloadSettingsFromStorage`) — otherwise a setting
  written there (repo trust) would put back main's older settings.
- **Capability:** `capabilities/code.json` for `code-*`: the editor's set
  (core, create windows for editors, zoom, close/destroy/title/focus/
  unminimize). Code turns only use app commands, so no shell plugin,
  sidecars or dialogs.
- **Not done:** session-level command approval ("approve for this
  session") resets when a session moves windows; the input box's unsent
  draft doesn't move with it; the main sidebar doesn't mark sessions that
  are open in their own window.
