# Phase 03 — Catalog fields and update status

**Depends on:** Phase 02 (status compares the manifest with the pin) ·
**Enables:** Phases 05 and 06 (they act on `onUpdate`, `blockedVersions` and
the status)

## Goal

Teach the catalog two new things — which setup steps must run again on update,
and which versions must not start — and give the frontend one command that
says, per server, whether an update is available and whether the installed
version is blocked. The spawn path refuses a blocked version, so the block
holds even if the UI misses it.

## Files touched

- `src-tauri/src/integrations/mcp/catalog.rs` —
  `BlockedVersion { version, reason }`; `CatalogEntry.blocked_versions:
  Vec<BlockedVersion>` (`#[serde(default)]`); `on_update: bool`
  (`#[serde(default)]`) on `SetupStep::Command`; accessor
  `SetupStep::runs_on_update()`; checks in `validate()`; tests.
- `src-tauri/resources/mcp-catalog.json` — Playwright's "Download the browser"
  step gets `"onUpdate": true`.
- `src-tauri/src/integrations/mcp/install.rs` — `build_spawn_config` returns
  an error starting with the marker `BLOCKED_VERSION:` when the manifest's
  version is in the entry's `blocked_versions`.
- `src-tauri/src/integrations/mcp/commands.rs` — new command
  `mcp_update_status(servers: Vec<McpServerConfig>) -> Vec<McpUpdateStatus>`.
- `src-tauri/src/lib.rs` — register it.
- `src/lib/ipc/gen/*` — regenerated (`CatalogEntry`, `SetupStep`,
  `BlockedVersion`, `McpUpdateStatus`).
- `src/lib/stores/mcpServers.svelte.ts` — `startMcpServer` maps a
  `BLOCKED_VERSION:` error to a new server state `'blocked'` carrying the
  reason.
- `src/lib/components/settings/McpServerRow.svelte` — render the `blocked`
  state as the error line "Stopped for a security problem: <reason>."

## Steps

1. Add the fields above. `onUpdate` exists only on `Command` steps: a `File`
   or `Secret` step's result already survives the update (Phase 04 keeps the
   folder's state and secrets live outside it), and `Addon` steps are always
   replaced (Phase 05).
2. `validate()`: every `blockedVersions[].version` is non-empty, unique within
   the entry, and not equal to the entry's pinned version; every `reason` is
   non-empty.
3. `McpUpdateStatus { server_id, installed_version, pinned_version,
   update_available: bool, blocked_reason: Option<String> }`. For each catalog
   server whose folder exists: load the manifest (backfilling), compare
   `manifest.version()` to the current entry's pin by string equality, look it
   up in the current entry's `blocked_versions`. Custom and remote servers, and
   catalog servers whose entry is no longer in the catalog, are left out (they
   keep launching from their manifest).
4. In `build_spawn_config`, after loading the manifest, refuse a version that
   is in the *current* catalog entry's `blocked_versions` with
   `BLOCKED_VERSION:<reason>`. A server whose entry is gone is not checked.
5. In `startMcpServer`, an error with that prefix sets the server's state to
   `{ kind: 'blocked', reason }` instead of `'error'`. The row shows the reason
   in that error line; Phase 06 adds the Update button and the toast.
6. Run `./scripts/export-ipc-types.sh`.

## Build gate

`cargo fmt -- --check`, `cargo clippy`, `cargo test`; `npm run check`,
`npm run lint`, `npm run test`; IPC drift check.

## Test plan

- Rust: `validate()` rejects a blocked version equal to the pin, a duplicate,
  and an empty reason; the bundled catalog still validates; Playwright's
  browser step `runs_on_update()`.
- Rust: `mcp_update_status` logic (as a plain function) reports
  `update_available` for an older manifest, nothing for an equal one, and the
  reason for a blocked one.
- Rust: `build_spawn_config` refuses a blocked manifest with the marker.
- Vitest: `startMcpServer` turns the marker into the `blocked` state.

## Commit

`feat(mcp): mark setup steps that rerun on update and versions that must not start`

## Rollback

Revert the commit. Older builds ignore the unknown catalog fields. Label the PR
`no-docs`: no catalog entry is blocked yet, so nothing a user sees changes.
