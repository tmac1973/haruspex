# Phase 12 — Integration hardening + cross-platform verification

**Depends on:** all previous phases · **Enables:** shipping.

## Goal

Prove the whole thing holds together on real machines, under the conditions that
actually break integrations: another platform, no network, a hostile server, and
a small model.

Every previous phase verified itself. This one verifies the seams between them,
and the two things no unit test can: three operating systems, and a 9B model's
behaviour when handed a large toolset.

## Files touched

- **NEW** `plan/integrations-expansion/verification.md` — the filled-in checklist,
  committed as the record of what was actually run and on what.
- **EDIT** `maintenance.md` — MCP runtime and orphan-process notes for future work.
- **EDIT** `README.md` — the integrations the app now has.
- **EDIT** `CLAUDE.md` — bundled runtimes in the sidecar table; the new
  `integrations/` and `desktop/` modules; the companion-app ports (Blender 9876,
  Godot's 9080 bridge) alongside the existing sidecar port list.
- Bug fixes across the phases as the matrix finds them.

## The matrix

### Cross-platform

Every native capability, on each of Linux (both X11 and Wayland), macOS and
Windows:

| Capability | Linux/X11 | Linux/Wayland | macOS | Windows |
|---|---|---|---|---|
| `capture_screen` | ✓ | portal picker | grant flow, then ✓ | ✓ |
| Bundled node/npm/uv | ✓ | ✓ | ✓ signed | ✓ |
| MCP stdio server | ✓ | ✓ | ✓ | ✓ |
| Companion probe (Blender, Godot) | ✓ | ✓ | ✓ | ✓ |

macOS and Windows are verified on Tim's own machines. A row that cannot be
verified is recorded as unverified in `verification.md` rather than assumed.

### Process lifecycle soak

The failure mode that reaches users as "my laptop got slow" and is never
attributed to us:

- Start several servers, use them, quit normally → no children remain.
- Start several, `kill -9` the app → relaunch reaps every orphan, and reaps
  nothing that isn't ours (verify a recycled pid running a different command is
  left alone).
- Start, stop, restart a server fifty times → no accumulation of processes, file
  handles or log memory.
- A server that crashes on every start does not spin in a restart loop.
- Hot-reload during `make dev` after a Rust change: confirm the documented
  clean-restart guidance, since MCP children compound the existing sidecar-orphan
  problem.

### Offline and degraded

- Install a server, disconnect the network, restart the app: the server still
  starts and its tools still work. This is the whole point of installing up front
  rather than resolving with `npx` at launch.
- Install with the network dropping mid-download: clean failure, no partial
  directory, a retry that works.
- A missing bundled runtime is reported in Settings, not discovered at spawn.
- A DAV server that is unreachable produces a readable error, not a hang.

### Hostile and malformed servers

- A server returning malformed JSON, an enormous tool result, or a tool schema
  the coercion layer has never seen.
- A server whose tools carry **no annotations** — confirm every one prompts.
- A server that renames its tools between listings.
- A companion app that dies mid-conversation: the next tool call fails with a
  specific message and the Settings row updates, rather than the model guessing.
- A `tool`-kind probe whose target tool has been disabled by the user, or has
  vanished from the server's list — the probe degrades to *unknown*, not to a
  crash or a silent *connected*.
- A tool result large enough to exceed the context budget — confirm
  `fitMessagesToBudget` truncates rather than the request 400ing.

### Small-model behaviour

The reason the budget exists. On the 9B tier, with a multi-tool server enabled:

- Confirm the budget warning fires with honest numbers.
- Compare tool-selection quality with the full toolset versus the curated default
  subset, and record the observation — this is the evidence that calibrates the
  cap, and it belongs in `verification.md` rather than in someone's memory.

### End-to-end user journeys

Run as the non-technical user this was designed for, from a fresh profile:

1. Install GitHub from the catalog, paste a token, ask a question about a repo.
2. Complete Google Drive/Workspace setup start to finish — Cloud project, OAuth
   client, credentials file, browser auth — without a terminal.
3. Install Blender from the catalog with Blender closed, run the addon install,
   start the addon, and ask the model to describe the scene — checking that the
   Settings row told the truth at each stage.
4. Enable the Godot entry in a project without the addon, confirm the hint names
   the per-project install, then enable it and confirm reconnection needs no
   restart.
5. Screenshot a window and ask what it says.
6. Add a Nextcloud account and ask what's on the calendar this week.

## Build gate

```bash
npm run check && npm run lint && npm run test && npm run format:check
cargo test   --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt    --manifest-path src-tauri/Cargo.toml -- --check
node scripts/check-ipc.mjs
npm run tauri build    # on each platform
```

## Commit

`chore(integrations): cross-platform verification and hardening`

## Rollback

Fixes here are individually revertable. The checklist is a record; it does not
change behaviour.
