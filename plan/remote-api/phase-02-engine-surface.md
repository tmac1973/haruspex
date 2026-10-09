# Phase 2 — One engine surface in the webview (sketch)

**Depends on:** 1 · **Guide:** none (`no-docs`)

The webview gets a single dispatcher for everything a non-window client may do
with Code sessions, and a single event stream of their state. The drive hooks
are rebuilt on it, so phase 1's tests exercise the same surface the remote API
will.

- **Operations:** `listSessions`, `openSession`, `newSession(root)`,
  `send(id, text)`, `steer`, `cancel`, `answerApproval`, `getSession(id)`,
  `listBackgroundProcesses(id)`. Each calls the existing `CodeSession` /
  store functions; none holds its own state.
- **Events:** per session, `status`, `delta` (live text and reasoning),
  `step` (started / progress / done, with the diff), `approval` (pending /
  resolved), `turn-done` (thread saved). Subscribers get a snapshot first,
  then events, and resync by snapshot after a gap. That's the same rule as
  `relay.rs`: the engine is authoritative, clients never patch.
- **Routing:** an op for a session is handled by the window that owns it.
  Needs the Rust claim map from Code tab phase 7 (`code_session_claim`);
  build that part here if phase 7 hasn't landed. Sessions not open anywhere
  are opened in the main window.
- **Transport-neutral:** the dispatcher takes plain JSON in and emits plain
  JSON out, so phase 3 can carry it over Tauri events ↔ WebSocket and the
  driver over WebDriver `execute`.
- **Throttling fix,** if phase 1 found one.

Open: whether the desktop Code tab itself should render through the same
event stream (one code path, but a refactor of working UI) or keep reading the
store directly (two paths that must agree). Lean: keep the store for the
desktop, and add a test that replays the event stream and checks it rebuilds
the same session the store holds.
