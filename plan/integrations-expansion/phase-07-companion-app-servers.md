# Phase 07 — Companion-app servers: Blender and Godot

**Depends on:** Phases 04, 06 · **Enables:** nothing (leaf).

## Goal

Add a third class of catalog entry: servers that drive a third-party desktop
application Haruspex neither bundles nor installs. Ship Blender and Godot as the
two entries, and give the format, the status model and the UI the one thing this
class needs — an honest answer to "the server is running, so why does every tool
fail?"

## Why this is a different shape

GitHub and Google Drive are self-contained: install the package, supply a
credential, and every tool works. Blender and Godot are not. Each is a bridge to
an application that must be **installed by the user, carrying an enabled addon,
and running right now**.

The failure this creates is the one worth designing against. The MCP process
starts cleanly, negotiates, and answers `tools/list` with its full toolset — so
Phase 02 calls it `Ready` and Phase 06 draws a green dot — and then every
`tools/call` fails with a socket timeout or a `BRIDGE_DISCONNECTED` error, in the
middle of a conversation, with nothing in Settings suggesting anything is wrong.
The user's diagnostic surface says healthy and the model says it cannot reach
Blender.

So the dependency gets declared in the catalog, probed by the app, and shown in
the row.

## Files touched

- **EDIT** `src-tauri/resources/mcp-catalog.json` — the two entries.
- **EDIT** `src-tauri/src/integrations/mcp/catalog.rs` — parse and validate the
  `companion` block and optional setup steps.
- **NEW** `src-tauri/src/integrations/mcp/companion.rs` — the probe and its
  status type.
- **EDIT** `src-tauri/src/integrations/mcp/process.rs` — `ServerHandle` carries a
  companion status alongside its `SidecarStatus`.
- **EDIT** `src-tauri/src/integrations/mcp/commands.rs` — a probe command; the
  status command returns companion state.
- **EDIT** `src/lib/stores/mcpServers.svelte.ts` — companion status per server.
- **EDIT** `src/lib/components/settings/McpServerRow.svelte` — the disconnected
  line and its hint.
- **EDIT** `src/lib/components/settings/McpCatalogBrowser.svelte` — surface the
  companion requirement and the provenance line *before* install.

## Implementation

### The `companion` block

```jsonc
"companion": {
  "app": "Blender",
  "minVersion": "3.0",
  "download": "https://www.blender.org/download/",
  "probe": { "kind": "tcp", "host": "127.0.0.1", "port": 9876 },
  "hint": "In Blender, press N in the 3D viewport, open the MCP tab, and click Start MCP Server."
}
```

Two probe kinds, because the two servers wire themselves up in opposite
directions:

- **`tcp`** — connect to a host and port and disconnect. Blender's addon *listens*
  on 9876, so a refused connection is a definitive "the addon is not serving".
- **`tool`** — call a named tool and classify the result. Godot inverts the
  topology: the MCP server binds the bridge on `ws://127.0.0.1:9080` and the
  editor's addon dials *out* to it. Something is always listening on 9080, so a
  TCP probe would report connected with no editor attached. Instead, call a tool
  and treat a declared error (`BRIDGE_DISCONNECTED`) as disconnected, anything
  else as a real failure.

```jsonc
"probe": { "kind": "tool", "tool": "get_editor_state", "disconnectedError": "BRIDGE_DISCONNECTED" }
```

**A `tool` probe may only name a tool carrying `readOnlyHint`.** Validate that at
parse time against the discovered tool list and fail loudly — a probe is a thing
the app calls on its own initiative, so it must never be able to reach a tool the
approval gate would otherwise have prompted for. Blender's
`execute_blender_code` is the reason this rule is written down rather than
assumed.

### Status: a field, not a fifth state

Companion state lives *beside* `SidecarStatus`, not inside it:

```rust
pub enum CompanionStatus {
    Connected,
    Disconnected { hint: String },
    Unknown,          // not yet probed, or the server is not Ready
}
```

Adding a fifth variant to `SidecarStatus` would ripple through every match on it
in the lifecycle, the UI and the sidecar code that shares the vocabulary, to
describe something that is not a process state at all — the process is fine. A
separate field keeps the four-state vocabulary from Phase 02 intact and is
strictly more expressive.

It *displays* as one combined state, which is what the user actually cares about:

```
Blender   ● running · ⚠ Blender not connected
          In Blender, press N in the 3D viewport, open the MCP tab,
          and click Start MCP Server.                    [Check again]
```

The hint is the catalog entry's string. Do not hardcode per-server text in the
component — a third companion entry must be a JSON change.

### When to probe

On server start, on demand from the row's "Check again" control, and lazily after
a tool call fails — a failed call is the strongest possible signal that the
companion dropped, and re-probing there turns the model's error into a specific
one.

While the MCP settings panel is open, poll on a slow interval so a user who
alt-tabs to Blender, starts the addon and comes back sees it flip without
touching anything. Stop when the panel closes. This does not breach the
never-poll rule, which is about sampling the user's screen and clipboard, not
about a loopback connect — but keep it scoped anyway, and say why in the module
docs so the next reader does not have to re-derive the distinction.

### Entry — Blender

| Field | Value |
|---|---|
| Acquisition | `pypi`, `blender-mcp`, pinned; installed with the bundled `uv` |
| Command | `blender-mcp`, no args |
| Companion | Blender 3.0+, `tcp` probe on 9876 |
| License / provenance | MIT, community (`ahujasid/blender-mcp`) |

Environment, both non-negotiable:

- `DISABLE_TELEMETRY=true`. The server reports usage by default. Haruspex is a
  private local AI desktop app; shipping a catalog entry that phones home would
  contradict the product's whole premise. Set it in the entry, and assert it in a
  test against the spawned environment rather than trusting the JSON to stay
  right.
- `BLENDER_MCP_SAFE_MODE=1`. Validates scripts before execution.

Setup steps: an `instruction` naming Blender 3.0+ with the download link; a
`command` step running `blender-mcp install-addon`, whose output the wizard
already streams; an `instruction` for enabling the addon and clicking *Start MCP
Server*.

Optional asset-service keys (Sketchfab, Poly Pizza, Hyper3D Rodin, Hunyuan3D)
need `"optional": true` on the `secret` step — the first optional step in the
format. An optional step is skippable in the wizard and its absence must not
block the server from starting.

`execute_blender_code` runs arbitrary Python inside the user's Blender. It is
**out of `defaultTools`**, and when a user enables it, it carries no
`readOnlyHint`, so Phase 05's gate treats it as unsafe and prompts. It is never
eligible as a probe.

### Entry — Godot

| Field | Value |
|---|---|
| Acquisition | `pypi`, `godot-editor-mcp`, pinned; installed with the bundled `uv` |
| Command | `godot-editor-mcp`, `GODOT_MCP_TRANSPORT=stdio` set explicitly |
| Companion | Godot 4.4+, `tool` probe classifying `BRIDGE_DISCONNECTED` |
| License / provenance | Community (`hybridindie/godot-mcp`) |

Pin the transport in the entry even though stdio is the default: Phase 08 adds
HTTP, and an entry that depends on a default is an entry that breaks quietly when
the default moves.

`GODOT_MCP_GODOT_BIN` is auto-discovered and gets an **optional** step for the
case where it is not.

The addon is per **project**, not per machine — it lives in a project's
`addons/` directory. There is no one-time machine-level install to run, so the
setup steps are instructions: install Godot 4.4+; in your project, Editor → Asset
Library → *Godot MCP* → Install; Project Settings → Plugins → Enable. The
companion `hint` must repeat the per-project part, because the user who hits
"not connected" six months later will be in a different project and will not
remember.

Start order does not matter and reconnection is automatic — the addon retries
outbound — so the probe is the whole story and there is nothing to sequence.

### Vetting a community server

Neither entry is first-party, and both execute code inside an application holding
the user's unsaved work. Tier 2 promises "vetted", so write down what that means
and enforce it in the entry:

- Version **pinned**, never a range.
- License and maintainer recorded in a `provenance` field, and **shown in the
  catalog browser before install** — not left in a README.
- Source reviewed at the pinned version, with the review noted in the commit.
- `defaultTools` actually exercised, not copied from upstream docs.

Blender's server in particular is large. `defaultTools` is not a nicety on the 9B
tier; it is the difference between usable tool selection and none.

## Build gate

```bash
npm run check && npm run lint && npm run test
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
node scripts/check-ipc.mjs && ./scripts/export-ipc-types.sh
```

## Test plan

- **Unit (Rust)** — the `companion` block parses; an unknown probe kind is a loud
  error; a `tool` probe naming a tool without `readOnlyHint` is rejected at
  validation, not at call time; the `tcp` probe classifies connected, refused and
  timed-out distinctly; the `tool` probe distinguishes the declared disconnected
  error from a genuine tool failure; an optional setup step left blank still
  yields a startable server; the spawned environment for the Blender entry
  contains `DISABLE_TELEMETRY=true`.
- **Unit (TS)** — the row renders running-and-connected, running-but-disconnected,
  and `Error` as three visibly different things; the hint string comes from the
  entry; "Check again" re-probes; polling stops when the panel closes.
- **Manual:**
  - Blender: install from the catalog with Blender closed. Server starts, row
    says *running · Blender not connected* with the hint. Launch Blender, enable
    the addon, click *Start MCP Server* — the row flips with no restart of the
    MCP server. Ask the model to describe the scene.
  - Blender: quit Blender mid-conversation. The next tool call fails with a
    specific message and the row updates.
  - Godot: same cycle with the editor closed and then opened, in a project with
    the addon enabled — confirm start order genuinely does not matter.
  - Godot: open a *different* project without the addon; confirm the row reports
    disconnected and the hint names the per-project install.
  - Confirm the catalog browser shows the companion requirement and the
    community-maintainer line before the user commits to installing.

## Commit

`feat(mcp): companion-app catalog entries for Blender and Godot`

## Rollback

Revert. The `companion` block is additive — entries without one behave exactly as
before, and the two new entries disappear with the catalog change.
