# MCP Server Updates — Project Overview

**Status:** Draft 2026-11-01 · **Type:** Feature + fix · **Output of:** a guided
planning session.

---

## Problem

The MCP catalog is compiled into the app (`include_str!` in
`src-tauri/src/integrations/mcp/catalog.rs`) and pins an exact version for each
entry. When a release bumps a pin, nothing happens to a server the user already
installed: `<app_data>/mcp/servers/<id>/` keeps the old package, and the
installed record (`McpServerSource::Catalog { entry_id }`) holds no version, so
the app cannot tell that it is out of date. The only way to get the new version
is to remove the server and add it again, which loses its tool choices and runs
the whole setup again.

Worse, launch reads the *new* catalog entry against the *old* install.
`build_spawn_config` in `install.rs` takes `bin`, `command.args` and
`command.env` from the current entry, and the tool list takes `defaultTools`
from it too. A bump that also changes a flag, moves the entry point or renames a
tool breaks the server or quietly turns tools off, with an error that never
points at the cause. There is also no way to stop a version with a known
security problem from running.

Separately, MCP settings sit at the bottom of Settings → Integrations, under
Email and Calendar. They are the largest part of that page and are hard to find.

## Goals

- An installed catalog server always launches with the settings it was
  installed with, whatever later releases do to its catalog entry.
- After a release pins a new version, the user is told once and can update the
  server in place with one click, keeping its secrets, setup files and tool
  choices.
- An update runs the setup steps that must follow the package (Playwright's
  browser download) and none of the ones that must not (sign-in steps), and
  replaces the Godot addon in each project it was installed into.
- If an update fails, the previous install is still there and still works.
- A version the catalog marks as unsafe does not start, and the user is told why
  and offered the update.
- MCP servers get their own Settings section.

## Non-goals

- No remote or online catalog. Pins change only with a Haruspex release. (A
  background fetch would be a privacy change for a private local app.)
- No free version choice. The catalog stays curated; the only installable
  version is the current pin.
- No automatic installs. Nothing downloads without a click, security fixes
  included.
- No "skip this version" or "hold updates" option.
- No updates for custom or remote servers; they have no catalog entry.
- No change to how Email and Calendar settings work, beyond staying in
  Integrations.

## Users & primary flow

**Normal update**

1. Haruspex 0.2.16 ships with `@playwright/mcp` pinned at 0.0.90. The user has
   0.0.83 installed.
2. On first launch, the app compares each server's recorded version with its
   catalog pin. One toast says "1 MCP server has an update. Settings → MCP
   servers." ("N MCP servers have updates." for more than one.) It does not
   appear again for that pin.
3. The Settings rail entry and the Playwright row show an update badge until the
   update is done. Meanwhile 0.0.83 keeps running from its own snapshot.
4. The user clicks **Update** on the row. The app installs 0.0.90 into a staging
   folder while 0.0.83 keeps running. Then it stops the server, moves the
   folder's user state (setup files, sign-in tokens, the browser) into the new
   folder, swaps the folders, runs the browser download step (it is flagged to
   run on update) and starts the server.
5. Once the server answers its handshake, the old folder is deleted and the row
   says "Updated to 0.0.90. 2 tools added, 1 removed. Approvals were reset."
   with names in a tooltip. If anything after the swap fails, the old folder and
   its state go back, the server restarts on 0.0.83, and the row shows the
   error.

**Security update**

1. The release adds 0.0.83 to the entry's `blockedVersions` with a reason.
2. On launch, the Playwright server does not start. A toast says "Browser
   (Playwright) was stopped for a security problem: <reason>." The row says
   "Stopped for a security problem: <reason>." and offers **Update**.
3. Update runs as above, and the server stays running afterwards.

**Godot**

Before it starts, the update drops recorded project folders that no longer
exist, lists the remaining ones whose addon it will replace, and asks to go on.
It then replaces `addons/<name>` in each.

## Constraints

- Tauri 2 + Svelte 5 runes; MCP logic lives in `src-tauri/src/integrations/mcp/`
  and `src/lib/stores/mcpServers.svelte.ts`; the UI in
  `src/lib/components/settings/Mcp*.svelte`.
- Settings are plain JSON in the settings blob. Old records without a snapshot
  must keep loading.
- Changing `McpServerSource`, `CatalogEntry` or a Tauri command means running
  `./scripts/export-ipc-types.sh`.
- Install mechanics stay as they are: staged install in `<id>.installing`,
  checksum-verified binaries, bundled node and uv, offline-capable launches.
- "Always allow" approvals live in localStorage (`mcpApproval.svelte.ts`);
  `forgetServerApprovals` exists but is only called on remove today.
- Server ids are UUIDs, and the config is persisted only by the frontend
  (`settings.integrations.mcp.servers`); Rust receives it on every call.
- User-visible changes update `docs/guide/integrations.md` and
  `docs/guide/settings.md` in the same PR. UI copy: one short sentence per
  section, details in tooltips, Settings paths in full.

## Success criteria

- A test changes a catalog entry's `bin`, `args`, `env` and `defaultTools` after
  install, and the server still launches with the installed values.
- An existing npm or PyPI install with no snapshot gets its real version from
  disk on first launch; a binary install records the current pin.
- Bumping a pin produces exactly one toast and a badge on the rail entry and the
  row; updating clears the badge.
- Updating Playwright keeps its tool choices, re-downloads the browser, and
  ends with a working server and a tool-change summary.
- Updating Google keeps the OAuth credentials file and does not ask the user to
  sign in again.
- A forced handshake failure after the swap leaves the previous version running.
- A version in `blockedVersions` never starts, and the user sees the reason and
  the Update button.
- Settings has an "MCP servers" entry after Integrations, and Integrations holds
  only Email and Calendar.
- The `Guide` check passes with the guide pages updated.

## Decisions

- **Security updates** → block the unsafe version from starting; one-click
  update; nothing installs without the user.
- **How normal updates are announced** → one toast per new pin, plus a badge on
  the Settings rail entry and the server row until updated.
- **Skipping an update** → not offered; the badge stays until the user updates.
- **New Settings section name** → "MCP servers", placed right after
  Integrations; Integrations keeps Email and Calendar.
- **Which setup steps rerun on update** → only steps the catalog flags with
  `onUpdate: true` (Playwright's browser download yes, sign-in steps no).
- **Godot addon copies** → replaced in each recorded project folder, after
  listing them; missing folders are dropped from the record.
- **Tool changes after update** → short summary on the row, names in a tooltip;
  explicit on/off choices are kept by tool name.
- **Existing installs with no record** → read the version from disk for npm and
  PyPI; assume the current pin for binaries; snapshot the rest from the current
  entry.
- **How the catalog marks unsafe versions** → a `blockedVersions` list of exact
  versions, each with a reason shown to the user.
- **How the work lands** → one PR per phase; the Settings split first.
- **Updating while the server is in use** → the swap is refused while a tool
  call to that server is in flight (counted per server in Rust, so every caller
  is covered), rather than while any turn or job runs anywhere. The row says
  why and the user clicks again later.
- **Where the install record lives** → a manifest file,
  `.haruspex-install.json`, in the server folder, holding a copy of the whole
  catalog entry as installed plus the list of top-level names the package
  owns. It swaps and rolls back with the package.
- **Install while running** → the new version installs into staging while the
  old one keeps running; the server stops only for the swap.
- **Keeping user state across the swap** → move every top-level entry the
  package does not own into the new folder; roll back by moving it back.
- **Approvals on update** → reset all "always allow" approvals for that server;
  the result line says so.
