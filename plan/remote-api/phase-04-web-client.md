# Phase 4 — The Code tab in a remote browser (sketch)

**Depends on:** 3 · **Guide:** `code` page, `remote-access` page

- **Build:** a SvelteKit build mode (like the `e2e` mode) whose client hook
  replaces Tauri's IPC with one that forwards to the owner API. That's the
  same trick as `installMocks.ts` (`mockIPC`), so the 121 files that import
  `invoke` don't change. The desktop serves this build from the phase-3
  listener.
- **Session view, not session engine:** Code components today read
  `CodeSession` fields. Extract the fields they read into a
  `CodeSessionView` interface. The desktop passes its `CodeSession`; the
  web client passes a `RemoteCodeSession` built from the phase-2 event
  stream. The remote one never runs a turn.
- **Forwarded IPC is allowlisted** by scope. Anything not listed fails with
  its name, as the e2e mocks do.
- **Approvals** render in the web client's modal and answer through the API.
  If the window and a remote client both show one, the first answer wins and
  the other modal closes.
- **Desktop-only tools in a remote-started turn:** `open_in_shell` returns
  "needs the desktop" to the model instead of waiting, unless the desktop is
  also attached (decide at build time); file links open a read-only viewer
  instead of the editor window.
- **Not in v1:** Shell tab, settings editing, image generation, file upload
  from the client.
- **Tests:** Playwright against the web build with the fake LLM and a real
  desktop app via the driver: send from the browser, see the desktop's pane
  update, and the reverse.
