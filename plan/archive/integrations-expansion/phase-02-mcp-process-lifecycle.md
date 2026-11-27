# Phase 02 — MCP process lifecycle: spawn, crash, hang, zombie reaping

**Depends on:** Phase 01 · **Enables:** Phase 03.

## Goal

Own the lifetime of MCP server child processes before writing a line of protocol
logic. For a desktop app, local stdio servers matter far more than remote ones,
and lifecycle is the part that actually bites: a hung server that never answers,
a crashed server that leaves the UI claiming "connected", a child that outlives
the app and holds resources until reboot.

This phase introduces the `rmcp` dependency, because its stdio transport
(`TokioChildProcess`) spawns the child itself — the supervisor is built around
that type rather than around a hand-rolled spawn. Protocol work stays in Phase 03.

## Files touched

- **EDIT** `src-tauri/Cargo.toml` — `rmcp = "3"`.
- **NEW** `src-tauri/src/integrations/mcp/mod.rs`.
- **NEW** `src-tauri/src/integrations/mcp/process.rs` — the supervisor.
- **NEW** `src-tauri/src/integrations/mcp/orphans.rs` — pid tracking + sweep.
- **EDIT** `src-tauri/src/integrations/mod.rs` — `pub mod mcp;` and update the
  module docs, which currently say an MCP client is a future thing.
- **EDIT** `src-tauri/src/lib.rs` — `.manage(McpSupervisor::new())`, extend the
  `WindowEvent::Destroyed` handler, add a `RunEvent::Exit` handler, register the
  status/log/start/stop commands.
- **NEW** `src-tauri/tests/` fixture — a trivial stdio echo server used to
  exercise the supervisor without a real MCP server.

## Implementation

### Reuse the sidecar vocabulary

`src-tauri/src/sidecar_utils.rs` already solved most of this shape for
llama-server, whisper-server and koko. Reuse it rather than reinventing:

- `SidecarStatus` (`Stopped | Starting | Ready | Error`) — the same four states
  describe an MCP server. Use the existing enum, or mirror it exactly.
- `new_log_buffer()` / `push_log()` / `strip_ansi()` — the 1000-entry ANSI-stripped
  ring buffer, so Phase 06 can show a server's stderr when it fails.
- `spawn_log_reader` — the pattern for draining a child's output without blocking.

Do **not** reuse the port/health-poll helpers: stdio servers have no port and no
`/health`. Readiness is a successful protocol response, which Phase 03 supplies;
until then, readiness is "the process is alive and its pipes are open".

### The supervisor

One `McpSupervisor` managed by Tauri, holding a map of `server_id → ServerHandle`.
Each handle owns the `TokioChildProcess`, the status, the log ring, the child's
pid, and the spawn configuration needed to restart it.

Behaviour to get right:

- **Startup deadline.** A server that has not become usable within a bounded time
  is killed and moved to `Error` with the last log lines attached. Never wait
  forever.
- **Crash detection.** Watch for child exit; move to `Error`, record the exit
  status and the tail of stderr. Do **not** auto-restart in a loop — a server
  that crashes on start would spin forever. Restart is a user action, or at most
  a single retry, and the UI says what happened.
- **Hang detection.** A request with no response inside a timeout fails that
  request; it does not tear down the server. Repeated timeouts move it to `Error`.
- **Explicit stop.** Terminate gracefully first (close stdin, let the server
  exit), then kill after a grace period. `ChildWithCleanup` covers the common
  path; the grace period is ours.
- **Kill-all on exit.** `lib.rs` already handles `WindowEvent::Destroyed` for
  inference-slot cleanup. Add MCP teardown there *and* on `RunEvent::Exit` —
  window-destroyed alone does not cover every quit path.

### Orphan reaping

Kill-on-exit is not sufficient: a SIGKILL'd or crashed app never runs its
handler. So `orphans.rs` writes a pid file under
`<app_data>/mcp/running.json` — server id, pid, start time, and the command —
updated on spawn and on exit.

On next launch, sweep it: for each recorded pid still alive **and still matching
the recorded command** (a pid alone is not proof — pids are reused), kill it, then
clear the file. Matching the command line is what makes this safe.

This matters more here than for the existing sidecars: hot-reload after a Rust
change already orphans processes holding 8765/3001/8766, and MCP children make
that strictly worse. Note it in the module docs.

### Testing without a real server

Ship a tiny stdio echo fixture (a few lines of Node, run through the bundled
runtime from Phase 01). It can be made to exit immediately, hang forever, or
answer normally — which is exactly the matrix the supervisor must handle. This is
what lets lifecycle be proven before Phase 03 exists.

## Build gate

```bash
npm run check && npm run lint && npm run test
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
node scripts/check-ipc.mjs --write && git diff --exit-code src/lib/ipc/commands.ts
```

## Test plan

- **Unit/integration (Rust), against the echo fixture:**
  - Normal spawn reaches `Ready`; explicit stop reaches `Stopped`.
  - A server that exits immediately lands in `Error` with logs, and does **not**
    restart in a loop.
  - A server that never answers hits the startup deadline and is killed.
  - Stop during startup does not leave a child behind.
  - The orphan sweep kills a matching stale pid and ignores a recycled pid whose
    command differs.
- **Manual:**
  - Start a server, `kill -9` it externally, confirm the UI shows `Error` with the
    reason rather than a stale `Ready`.
  - Start a server, quit the app normally — confirm no children remain (`ps`).
  - Start a server, `kill -9` the *app* — relaunch, confirm the sweep reaps it.
  - Do the equivalent on Windows (Task Manager) and macOS.

## Commit

`feat(mcp): supervise MCP server processes with crash, hang and orphan handling`

## Rollback

Revert. Nothing spawns servers until a server is configured, which Phase 04 adds.
