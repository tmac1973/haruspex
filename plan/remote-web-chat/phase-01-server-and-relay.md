# Phase 01 — Server, Relay, and the Remote Turn

The Rust half: bind a port, authenticate, accept a prompt, hand it to the
webview, stream the answer back. Depends on phase 00's answer.

## Steps

### 1. The server

A new `remote/` module under `src-tauri/src`, with `axum` as the only new
dependency (`reqwest` is a client; nothing in the tree serves HTTP today —
the sidecars run their own).

Routes, deliberately few:

```
GET  /                     the thin client page (phase 02)
GET  /app.js /app.css      its assets
POST /api/chat             { sessionId, message } -> 202, streams via SSE
GET  /api/stream/:session  SSE: deltas, done, error, queue-state
POST /api/cancel           stop the in-flight turn for a session
GET  /api/health           for the settings page's own check
```

SSE rather than WebSockets: the traffic is one-directional once a turn starts,
every browser supports it without ceremony, and it survives proxies that eat
upgrades. Cancellation is a separate POST rather than a duplex channel.

**Binding.** Default `0.0.0.0` on a configurable port so the LAN can reach it,
which is the entire point — but the settings page must state the address in
plain terms ("anyone on your network who has the link can use this") rather
than hiding it behind a checkbox.

### 2. Authentication

A token generated on first enable, stored in settings, and carried in the URL:
`http://host:port/?t=<token>`. The client stashes it in `localStorage` so a
reload does not require the link again.

Every route except `/` and `/api/health` requires it. `/` requires it too
before rendering anything useful — an unauthenticated visitor gets a bare
"this needs a link from the host" page, not the chat box.

This is a shared secret on a trusted LAN, not an identity system, and the plan
should not pretend otherwise. It exists so that a housemate's laptop, a smart
TV, or a guest phone cannot spend the host's GPU by guessing a port. Rotating
it is a button.

Rate-limit per token: a small cap on concurrent sessions and on turns per
minute. The threat is not an attacker, it is a friend holding down enter.

### 3. The relay

Rust cannot run a turn, so it brokers one:

1. `POST /api/chat` validates the token, allocates a turn id, and emits a
   Tauri event `remote://prompt` with `{sessionId, turnId, message}`.
2. The webview's remote driver (step 4) picks it up, runs the turn, and pushes
   deltas back through a command: `remote_turn_delta(turnId, chunk)`, then
   `remote_turn_done(turnId, finalText)` or `remote_turn_error(turnId, msg)`.
3. Rust fans those out to the session's SSE subscribers.

State held in Rust: a map of `turnId -> broadcast::Sender<Event>`, plus the
session registry. Nothing durable — conversation persistence is phase 03 and
belongs to the frontend, which already owns the database path for messages.

**Backpressure.** A disconnected browser must not accumulate deltas forever:
bound the channel and drop the session when its receiver is gone, cancelling
the turn on the frontend side through the same abort path the local UI uses.

### 4. The remote turn driver

A frontend module that listens for `remote://prompt` and runs the turn through
`runEphemeralTurn`, which already provides everything needed: a message, a tool
allowlist, streaming callbacks, and a backend override.

Options that matter, and why:

- `toolAllowlist`: web search and fetch only for v1. No `fs_*`, no
  `run_command`, no shell, no Python sandbox. A remote user is a guest on
  someone else's machine and should not be able to touch its disk.
- `interactive: false`: the existing "nobody is present at *this* keyboard"
  signal. `code.ts` already denies risky commands under it rather than opening
  a modal, which is exactly the desired behaviour even though those tools are
  not in the allowlist — defence in depth costs nothing here.
- `workingDir: null`: there is no remote working directory and never will be.
- The backend descriptor resolves as normal, so a remote user's turns use
  whatever the host has configured, local or remote.

**Queue integration is one wrapper**: `withInferenceSlot({ consumer: { kind:
'remote', client: <label> }, ... })`. The consumer value is opaque to Rust and
echoed into the snapshot, so the local UI can label the waiter "Remote — Dave"
without any Rust change. Lane and parallelism come from the existing
`laneFor()`, so collision behaviour is inherited rather than reimplemented:
local serializes, parallel-capable remote backends do not.

### 5. Tests

- Token: every protected route rejects a missing, wrong and stale token.
- Relay: a delta pushed for an unknown turn id is dropped, not a panic; a
  session whose SSE receiver is gone is reaped and its turn cancelled.
- Driver: a remote turn requests only allowlisted tools; `workingDir` is null;
  the consumer descriptor carries the client label.
- Queue: two remote turns on the local lane run one at a time; on a
  parallel-capable lane they overlap. (Phase 00's capacity work is a
  prerequisite for the third case: capacity 2 admits two and queues the third.)

## Verification

- With the local UI mid-turn, submit remotely: the remote client shows waiting,
  then answers, and the local turn is undisturbed.
- Kill the browser mid-answer: the turn cancels rather than running to
  completion against a dead socket.
- Wrong token: no chat box, no leak of whether the host is running anything.
