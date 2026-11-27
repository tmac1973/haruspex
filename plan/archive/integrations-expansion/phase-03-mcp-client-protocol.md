# Phase 03 — MCP protocol: dual-era negotiation, discovery, MRTR

**Depends on:** Phase 02 · **Enables:** Phases 04, 05, 08.

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
2. If it returns a *recognised modern* error (`UnsupportedProtocolVersionError`),
   the server is modern but disagrees on the version: retry once with a version
   from the error's `supported` list. Do not loop, and do **not** fall back to
   `initialize`.
3. On any other error — or no response within a short timeout — the server is
   handshake-era. Fall back to `initialize` and remember that. The fallback
   **must not** key on a specific error code; legacy servers answer unknown
   pre-`initialize` methods with implementation-defined errors (commonly `-32601`
   or `-32602`) or with silence.

Always probe, even though a modern-only client technically needn't: the spec
recommends it because some legacy servers do not validate that a request arrives
after `initialize`, and would happily process an era-ambiguous `tools/call` under
legacy semantics. Probing turns that into a deterministic failure.

Era is a property of the server, not the request. Cache it for the lifetime of
the process and persist it against the server config, re-probing if the cached
assumption later fails.

Record the negotiated era and version on the `ServerHandle` and surface it in the
UI — when a server misbehaves, "which protocol is it actually speaking" is the
first question.

rmcp 3.x drives the probe and fallback for us, so the happy path is configuration
rather than branching:

```rust
ClientInfo::default().serve_with_lifecycle(
    transport,
    ClientLifecycleMode::Auto {
        preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        legacy_version: Some(ProtocolVersion::V_2025_11_25),
    },
)
```

What is ours is the *policy* around it: the retry bound, the era cache, surfacing
the negotiated era, and the tests that prove each branch. Call sites do not
change between eras.

### What dual-era does not extend to

Dual-era covers **connect, `tools/list` and `tools/call`, and nothing else.**

The interactive path is modern-only. A legacy server asks for input with
server-initiated requests (`elicitation/create`, `sampling/createMessage`,
`roots/list`); a modern one uses MRTR. Supporting both would mean two question
paths into one modal — the genuine duplication in this phase, and the one worth
refusing. A server-initiated request from a legacy server therefore **fails the
tool call** with a message naming the reason, the same fail-safe posture the
non-interactive MRTR case takes below. Elicitation is rare, and a legacy server
that needs it is a server the user can wait to see upgraded.

This scoping is deliberate: when the ecosystem is majority-modern, retiring
legacy support is deleting the fallback arm and its fixture, not untangling two
interleaved feature sets.

### Tool discovery

`tools/list` produces, per tool: name, description, input schema, and
`annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`). Carry annotations through to the frontend verbatim — Phase 05's
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

- **Integration (Rust)** — extend the Phase 02 fixture into two fake servers, one
  per era:
  - Stateless server: `server/discover` succeeds, tools list, tool call.
  - Handshake server: `server/discover` fails as unknown; the `initialize`
    fallback engages and tools still list.
  - The fallback is not keyed to one error code — a handshake server answering
    the probe with `-32601`, with `-32602`, and with silence-until-timeout all
    reach the same `initialize` path.
  - A server returning `UnsupportedProtocolVersionError` triggers exactly one
    retry at a supported version, then gives up — and does *not* fall back to
    `initialize`.
  - A legacy server issuing a server-initiated `elicitation/create` fails the
    tool call with a message naming the era, rather than hanging or opening a
    second question path.
  - The cached era survives a reconnect, and a cache that proves wrong re-probes.
  - An `input_required` result round-trips through a stubbed `askUser` and
    completes; the round-trip cap is enforced; a non-interactive context fails
    cleanly instead of hanging.
  - Annotations survive to the frontend shape unchanged, including *absent*.
- **Manual** — connect to one real server of each era and list its tools.

## Commit

`feat(mcp): speak both MCP protocol revisions with discovery and MRTR`

## Rollback

Revert. Phase 02's supervisor stands alone and stays useful.
