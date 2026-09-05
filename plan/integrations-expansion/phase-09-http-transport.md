# Phase 09 — Streamable HTTP transport

**Depends on:** Phases 05, 08 · **Enables:** hosted/remote MCP servers.

## Goal

Support MCP servers reached over the network rather than spawned locally. Last in
the MCP track deliberately: local stdio is what the bundled-runtime work is built
for and what the privacy-minded audience runs, and remote servers bring an auth
story that would have slowed everything before it.

## Files touched

- **NEW** `src-tauri/src/integrations/mcp/http.rs` — the transport.
- **EDIT** `src-tauri/src/integrations/mcp/server_config.rs` — a transport
  discriminant (`stdio` | `http`) with URL and auth fields.
- **EDIT** `src-tauri/src/integrations/mcp/client.rs` — construct either transport.
- **EDIT** `src-tauri/src/integrations/mcp/catalog.rs` — an `http` acquisition-free
  entry kind (nothing to install; just a URL and credentials).
- **EDIT** `src/lib/components/settings/McpServerRow.svelte`,
  `McpCatalogBrowser.svelte` — surface remote servers distinctly.

## Implementation

### Transport

rmcp provides the streamable-HTTP client transport; wire it through the existing
session type so everything above `client.rs` is unchanged. Route it through the
app's existing egress configuration — `src-tauri/src/proxy/` and the settings
proxy `mode`/`bypass` rules — so a user who has configured a proxy does not find
that MCP quietly ignores it.

The stateless revision carries the negotiated version in the
`MCP-Protocol-Version` header as well as `_meta`; handshake-era remote servers
still expect `Mcp-Session-Id`. The dual-era logic from Phase 05 already decides
which, so this phase supplies headers, not policy.

### Lifecycle differences

There is no child process, so most of Phase 04 does not apply — but the status
vocabulary does. Reachability replaces liveness: connection failures, TLS
failures and HTTP errors all map onto `Error` with a readable reason. Retries are
bounded and never automatic in a loop.

### Auth

In scope: a bearer token or API key the user pastes, stored like every other MCP
secret. Out of scope: a full OAuth authorization-code flow. If a target server
requires interactive OAuth, it is documented as unsupported for now rather than
half-implemented — a partial OAuth flow that strands the user mid-redirect is
worse than an honest "not yet".

### Trust posture

A remote server sees whatever the model sends it. Say so plainly in the UI when
adding one, and keep the same approval rules — remoteness does not make a
non-read-only tool safer.

## Build gate

```bash
npm run check && npm run lint && npm run test
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## Test plan

- **Integration (Rust)** — a local HTTP fake server of each era: discovery,
  tools list, tool call, header shape per era, bounded retry on failure.
- **Manual** — add a real remote server with a token; confirm tools appear and
  calls work; confirm it is routed through a configured proxy; confirm an
  unreachable host produces a readable error rather than a hang.

## Commit

`feat(mcp): streamable HTTP transport for remote servers`

## Rollback

Revert. Stdio servers are unaffected; existing configs have no `http` transport.
