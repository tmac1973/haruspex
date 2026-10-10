# Remote API — Overview

## Goal

Three uses, in order:

1. **Testing.** Claude drives the real app against a real model and reads back
   everything that happened, without a person clicking.
2. **Remote web client.** Haruspex runs on the owner's desktop. From another
   machine they open a browser and carry on with the same Code sessions:
   send prompts, approve commands, watch turns, read diffs.
3. **Mobile.** The same, from a phone.

Networking is the owner's business: we assume Tailscale, NetBird or similar.
Routing, NAT traversal and relays are out of scope.

## The constraint that shapes everything

The agent loop is TypeScript running in the webview. Rust handles transport,
storage, processes and sidecars, and cannot run a turn. Remote chat already
works around this: `src-tauri/src/remote/relay.rs` hands each HTTP prompt to
the webview as a Tauri event and streams the answer back over SSE.

We considered moving the loop out of the webview (a Node runtime under the
bundled `haruspex-node`, or Rust) to get a headless server mode. **Rejected**
(2026-10-09): it is the largest refactor in the plan, and the owner's real use
case has the desktop app running anyway.

So **the desktop webview is the engine.** Every remote client is a view and a
controller of sessions that run there. That's why a locked phone or a closed
tab never kills a turn.

## What already exists

| Need                                       | Existing piece                                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driving the real app against a real model  | `scripts/drive.mjs` + `src/lib/e2e/driveHooks.ts` on branch `code-tab/dev-driver` (commit `8fc77c0`, unmerged): tauri-driver, private X display, writes transcript/session/debug log/screenshot |
| Deterministic model output                 | `e2e/fake-llm/server.mjs`: scenarios, `--record` against a real upstream, `GET /__requests`                                                                                                     |
| Real-app e2e                               | `e2e/app/` (WebdriverIO + tauri-driver, isolated data dirs, stub sidecars)                                                                                                                      |
| A session engine with no UI dependency     | `src/lib/stores/code.svelte.ts`: `CodeSession` runs turns by id; "nothing here needs the tab to exist"                                                                                          |
| Thread persistence                         | Code sessions are saved after every turn; the database is the source of truth                                                                                                                   |
| HTTP server, token auth, SSE replay        | `src-tauri/src/remote/` (axum, constant-time token compare, cookie + bearer + query token, reconnect replay, orphan grace)                                                                      |
| Asking the remote user a question mid-turn | `/api/answer` in `remote/server.rs`                                                                                                                                                             |
| One window owns a session                  | Code tab phase 7 plans a Rust claim map (`code_session_claim`). The remote relay needs the same table to route a prompt to the right window                                                     |

## Decisions (settled 2026-10-09)

| #   | Question                              | Decision                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Headless mode                         | **No.** The desktop app must be running.                                                                                                                                                                                                                                                                              |
| 2   | Where turns run                       | **The desktop webview**, always. Remote clients never run the loop.                                                                                                                                                                                                                                                   |
| 3   | Files                                 | **The desktop's files are the only real ones.** No access to the client's filesystem in v1.                                                                                                                                                                                                                           |
| 4   | Remote chat vs this                   | **Separate.** Remote chat stays a guest feature (own sessions, one shared link). This is owner control: per-client tokens with scopes.                                                                                                                                                                                |
| 5   | Off by default                        | **Yes**, and loopback-only until the owner picks another bind address.                                                                                                                                                                                                                                                |
| 6   | First test surface                    | **The driver from `code-tab/dev-driver`**, extended, rather than a new HTTP bridge.                                                                                                                                                                                                                                   |
| 7   | First remote surface                  | **The Code tab.** Chat comes in phase 5 because its store holds one active conversation.                                                                                                                                                                                                                              |
| 8   | Web client UI                         | **Shared render pieces, its own shell** (narrowed 2026-10-09): markdown, steps, command and diff cards are shared; the session list, composer and prompt cards are the web client's own. Full reuse would have meant forwarding raw Tauri commands or refactoring the desktop Code tab. See `phase-04-web-client.md`. |
| 9   | Mobile                                | **PWA of the web client first.** A native app only if the PWA falls short.                                                                                                                                                                                                                                            |
| 10  | The 9B model                          | **Not a constraint.** Build for capable models; document what works poorly on 9B. Scripted backends are for exact checks, not because of 9B.                                                                                                                                                                          |
| 11  | Desktop Code tab and the event stream | **The desktop keeps reading the store.** The engine watches it and emits events; a test proves they rebuild the same session.                                                                                                                                                                                         |

## Invariants

- **One engine per session.** A session's turns run in exactly one webview
  (the owning window). Every other screen, local or remote, subscribes to it.
- **One turn per session at a time.** A prompt from a second screen while a
  turn runs is queued as a steering message, the way the desktop composer does
  it today. It never starts a second loop.
- **The API is a door, not a second set of rules.** Boundary checks, risk
  classification and approvals run the same code whether the prompt came from
  the window or a remote client. A remote client approves through the same
  modal state, relayed.
- **Every request is authenticated except `/api/health`.** Tokens are
  compared in constant time. A token's scope is checked on every call, not
  only at connect.
- **Nothing is served off-loopback unless the owner picked it** in Settings.
- **Test hooks are build-time gated.** `window.__haruspexDrive` exists only in
  `VITE_HARUSPEX_E2E=1` builds; CI greps the production output.

## Risks to check early

- **Background throttling.** Checked and ruled out: a streaming turn ran
  just as fast minimised as visible, on a private X display and on the
  owner's GNOME desktop (`phase-01-driver.md`, `phase-02-engine-surface.md`).
- **Secure context.** Microphone, clipboard and service workers need HTTPS
  off-loopback. `tailscale serve` gives a certificate; plain `http://` over a
  tailnet will not. Phase 3 documents the setup; phase 6 depends on it.
- **Desktop-only tools.** `open_in_shell` waits for the owner to press Enter
  in a desktop Shell tab, and `open_in_editor` opens a desktop window. Neither
  makes sense from a phone. Phase 4 decides what a remote-started turn does
  with them.
