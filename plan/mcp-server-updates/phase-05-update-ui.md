# Phase 05 — Update button and the update sequence

**Depends on:** Phase 01 (the section it lives in), Phase 02 (manifests),
Phase 03 (`onUpdate`, `mcp_update_status`), Phase 04 (update commands) ·
**Enables:** Phase 06 (notifications point at this button)

## Goal

An **Update** button on a catalog server's row in Settings → MCP servers that
runs the whole update: install next to the running server, stop, swap, rerun
flagged setup steps, replace the Godot addon in each recorded project, start
and check the handshake, then commit or roll back. Afterwards the row says what
changed.

## Files touched

- `src/lib/stores/mcpUpdate.svelte.ts` (new) — `updateStatuses` state,
  `refreshUpdateStatuses(servers)`, `updateMcpServer(config, entry)`,
  `recoverInterruptedUpdates()`, per-server `updateResult` lines.
- `src/lib/stores/mcpUpdate.test.ts` (new).
- `src/lib/stores/mcpServers.svelte.ts` — `startConfiguredMcpServers` calls
  `recoverInterruptedUpdates()`, loads manifests, then
  `refreshUpdateStatuses()`, before starting servers.
- `src/lib/components/settings/McpServerRow.svelte` — version in the label's
  tooltip, Update button, progress (`DownloadProgressBar.svelte` on
  `mcp-install-progress`), Godot confirm, result line.
- `src/lib/components/settings/McpServerRow.test.ts` (new).
- `docs/guide/integrations.md` — new "## Update an MCP server" section.
- `docs/guide/settings.md` — the MCP servers section says a server can be
  updated from its row.

## Steps

1. `refreshUpdateStatuses` calls `mcp_update_status` with all servers and
   stores the result by server id.
2. The row puts the installed version (`McpUpdateStatus.installedVersion`)
   in the label's `title`. When `update_available`, it shows **Update** and the line
   "Version X is available." The button is disabled while an update of any
   server is running.
3. For an entry with `Addon` steps and a non-empty `addonProjects`, clicking
   Update first calls `mcp_existing_dirs`, drops missing folders from
   `addonProjects` (and persists), and, if any remain, shows a confirm "Update
   replaces the Godot addon in these projects:" with the list, Update and
   Cancel.
4. `updateMcpServer(config, entry)`:
   a. note whether the server is running and, if it is, its current tool names;
   b. `mcp_update_stage`; on error: result line "Update failed; version Y is
      still installed." with the error in the tooltip; stop here (the server
      was never stopped);
   c. `unregisterMcpServer(id)` so the agent cannot start a new call, then
      `mcp_calls_in_flight(id)`. If it is above zero: `refreshMcpTools(id)` to
      register the tools again, `mcp_update_rollback` to remove the staged
      install, and show "A tool from this server is running. Try again when it
      finishes." (the next click downloads again). Otherwise `stopMcpServer`,
      then `mcp_update_swap`; on error, roll back;
   d. for each `Command` step with `onUpdate`, `mcp_run_setup_command`; on
      failure, roll back;
   e. for each `Addon` step and each folder in `addonProjects`,
      `mcp_install_addon`; on failure, roll back;
   f. if the server is startable (`enabled && setupComplete`), `startMcpServer`
      and wait for Ready; on failure, roll back. Note its new tool names. If it
      was not running before and was not blocked, stop it again (a server that
      was blocked stays running, since the block was the only thing stopping
      it). If it is not startable, skip this check;
   g. `mcp_update_commit`; `forgetServerApprovals(id)`; reload its manifest;
      `toolEnabled` is kept as is (it is keyed by tool name);
   h. result line: with both old and new tool names known, "Updated to X. N
      tools added, M removed. Approvals were reset." (added and removed names
      in the tooltip; "N tools added" and "M removed" parts omitted when zero);
      otherwise "Updated to X. Approvals were reset.";
   i. refresh update statuses.
   Roll back = `mcp_update_rollback`, restart the server if it was running,
   and show "Update failed; version Y is still installed." with the error in
   the tooltip.
5. `recoverInterruptedUpdates` calls `mcp_update_recover`; if it returns any
   ids, show one error toast "An MCP server update was interrupted and has been
   undone."
6. Guide: "## Update an MCP server" — what Update does, that setup files and
   sign-ins are kept, that approvals reset, that Playwright downloads its
   browser again (about 200 MB), that Godot projects are updated, and that
   Update waits for a running tool call to finish. Keep the page under 6 KB.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`;
`cargo test`; Guide check.

## Test plan

- Vitest (`mcpUpdate.test.ts`, mocked `invoke`): the success path calls the
  commands in order and commits; a stage failure never stops the server; a
  failing swap, setup step, addon install or handshake each roll back and
  restart a server that was running; approvals are forgotten only on success; a busy server is not stopped and its
  staged install is removed; a blocked server is left running after its
  update; the result line covers the known
  and unknown tool-name cases.
- Vitest (`McpServerRow.test.ts`): Update shows only with an update; the Godot
  confirm lists only existing folders.
- Manual (dev build):
  - Pin Playwright to an older version in the catalog, install, restore the
    pin, Update: the old version keeps answering during the install, the
    browser downloads, tools work, choices kept.
  - Same with google-workspace: no new sign-in, the keys file is still there.
  - Handshake failure: in the dev catalog, give the new pin a wrong `bin`,
    Update; the old version starts again and the row shows the failure.

## Commit

`feat(mcp): update a catalog server from its settings row`

## Rollback

Revert the commit. The Phase 04 commands stay unused. If a user's update was
interrupted mid-swap and they then run a build without this phase, nothing
recovers it: the folder can be left without its package, and the server must
be removed and added again. Recovery comes back with the next build that has
this phase.
