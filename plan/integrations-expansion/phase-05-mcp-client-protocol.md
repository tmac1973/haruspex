# Phase 05 — MCP protocol: dual-era negotiation, discovery, MRTR

**Depends on:** Phase 04 · **Enables:** Phases 06, 07, 09.

## Goal

Speak MCP over the supervised stdio transport — to servers on the current
stateless revision **and** to the handshake-based servers that still make up most
of the ecosystem. Discover a server's tools, call them, and handle a server that
needs to ask the user something mid-call.

## Files touched

- **NEW** `src-tauri/src/integrations/mcp/client.rs` — session, negotiation,
  `tools/list`, `tools/call`.
- **NEW** `src-tauri/src/integrations/mcp/types.rs` — the ts-rs-exported shapes the
  frontend consumes (tool descriptor, annotations, call result, MRTR request).
- **NEW** `src-tauri/src/integrations/mcp/commands.rs` — Tauri commands.
- **EDIT** `src-tauri/src/integrations/mcp/process.rs` — readiness now means "the
  protocol answered", not just "the pipes are open".
- **EDIT** `src-tauri/src/lib.rs` — register the commands.
- **EDIT** `src/lib/ipc/commands.ts` — regenerated, not hand-edited.

## Implementation

### Two protocol eras, one client

The current revision (`2026-07-28`) is stateless: no `initialize` handshake, no
`Mcp-Session-Id`. Per-request identity, capabilities and protocol version travel
in `_meta` under `io.modelcontextprotocol/protocolVersion`. Servers must implement
`server/discover`, which returns supported versions, capabilities and identity in
a single request; clients may call it or may just send a request and handle the
error.

Older servers (`2025-11-25` and earlier) require the `initialize` /
`initialized` handshake and a session id.

The connection sequence:

1. Call `server/discover`. If it succeeds, pick the newest mutually supported
   version and proceed statelessly.
2. If it fails as an unknown method, fall back to the `initialize` handshake and
   remember that this server is handshake-era.
3. If a later request returns `UnsupportedProtocolVersionError`, retry once with a
   version from the error's supported list. Do not loop.

Record the negotiated era and version on the `ServerHandle` and surface it in the
UI — when a server misbehaves, "which protocol is it actually speaking" is the
first question. rmcp gates version-specific behaviour on the negotiated version,
so most of this is configuration rather than branching, but the *fallback* path
and the error retry are ours to drive and to test.

### Tool discovery

`tools/list` produces, per tool: name, description, input schema, and
`annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`). Carry annotations through to the frontend verbatim — Phase 07's
approval gate is built on them, and an absent annotation must stay absent rather
than being defaulted to something permissive at this layer.

Tool lists change: handle the list-changed notification where the server sends
one, and re-list on reconnect.

### Multi Round-Trip Requests

The current revision replaced server-initiated requests (elicitation, sampling,
roots) with MRTR: a tool call returns `resultType: "input_required"` describing
what it needs, and the client retries the same call with `inputResponses`.

Haruspex already has the machinery for this. `src/lib/stores/userQuestion.svelte.ts`
plus `UserQuestionModal.svelte` are a general "ask the user and await an answer"
primitive (single/multi-select, per-option descriptions, always a free-text
answer), and `ToolContext.askUser` already routes a question to whoever can answer
it — including a remote guest rather than whoever is at this keyboard. **Map MRTR
onto that. Do not build a second question path.**

Rules:

- Bound the round trips (a small fixed maximum). A server that keeps asking is a
  broken server, not an interactive one.
- In a non-interactive context (`ctx.interactive` falsy and no `askUser`), an
  `input_required` result fails the tool call with a clear message rather than
  hanging — the same fail-safe posture `ask_user_question` already takes.
- The user can always decline; a declined MRTR is a normal tool failure the model
  can act on.

### Commands and bindings

New `#[tauri::command]`s for connect, disconnect, list tools and call a tool. Any
phase adding commands must regenerate bindings and ts-rs types in the same
commit — a rename otherwise compiles and fails at chat time:

```bash
node scripts/check-ipc.mjs --write
./scripts/export-ipc-types.sh
```

## Build gate

```bash
npm run check && npm run lint && npm run test
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
node scripts/check-ipc.mjs && git diff --exit-code src/lib/ipc/commands.ts
```

## Test plan

- **Integration (Rust)** — extend the Phase 04 fixture into two fake servers, one
  per era:
  - Stateless server: `server/discover` succeeds, tools list, tool call.
  - Handshake server: `server/discover` fails as unknown; the `initialize`
    fallback engages and tools still list.
  - A server returning `UnsupportedProtocolVersionError` triggers exactly one
    retry at a supported version, then gives up.
  - An `input_required` result round-trips through a stubbed `askUser` and
    completes; the round-trip cap is enforced; a non-interactive context fails
    cleanly instead of hanging.
  - Annotations survive to the frontend shape unchanged, including *absent*.
- **Manual** — connect to one real server of each era and list its tools.

## Commit

`feat(mcp): speak both MCP protocol revisions with discovery and MRTR`

## Rollback

Revert. Phase 04's supervisor stands alone and stays useful.
