# Phase 06 — Tell the user: toast, badges, blocked versions

**Depends on:** Phase 01 (rail entry), Phase 03 (status, `blocked` state),
Phase 05 (Update button and statuses) · **Enables:** nothing; this completes
the feature

## Goal

Make updates visible. After a release pins a new version, the user gets one
toast and a badge on the Settings rail entry and the row until they update. A
blocked version shows its reason and the Update button, and gets a toast on
every launch until it is updated.

## Files touched

- `src/lib/stores/mcpUpdate.svelte.ts` — `notifyUpdates()`, the
  `haruspex.mcp.updateNotified` localStorage record, `mcpAttentionCount`
  derived value.
- `src/lib/stores/mcpUpdate.test.ts` — notify tests.
- `src/lib/stores/mcpServers.svelte.ts` — `startConfiguredMcpServers` calls
  `notifyUpdates()` after `refreshUpdateStatuses()`; `removeMcpServer` clears
  the server's `updateNotified` key.
- `src/lib/components/settings/SettingsPanel.svelte` — optional `badge` on a
  rail entry; the MCP servers entry passes `mcpAttentionCount`.
- `src/lib/components/settings/SettingsPanel.test.ts` — rail badge tests.
- `src/lib/components/settings/McpServerRow.svelte` — update badge next to the
  label; a blocked server's Start control is disabled.
- `src/lib/components/settings/McpServerRow.test.ts` — row badge and blocked
  state tests.
- `docs/guide/integrations.md` — security block paragraph in "## Update an MCP
  server".
- `docs/guide/settings.md` — the MCP servers section mentions the badge.

## Steps

1. `haruspex.mcp.updateNotified` is a map `serverId → pinned version` in
   localStorage, read and written inside `try/catch`. A failure means the
   toast may show again, never that it is lost.
2. `notifyUpdates()`:
   - Blocked servers, on every launch: one error toast. For one server,
     "<Name> was stopped for a security problem: <reason>."; for more,
     "N MCP servers were stopped for security problems. Settings → MCP
     servers." Action "Open" → `openSettings('mcp')`.
   - Updates: servers with `update_available`, not blocked, whose
     `updateNotified[id]` differs from the pin. If any, one info toast: "1 MCP
     server has an update. Settings → MCP servers." or "N MCP servers have
     updates. Settings → MCP servers.", action "Open". Then record the pins for
     those servers.
3. Rail badge: `CategoryDef` gets `badge?: () => number`. When it returns more
   than zero, the rail button shows the number in a small pill after the label,
   with `aria-label` "N need attention". MCP servers passes
   `mcpAttentionCount`: servers with an update or blocked.
4. Row: an update shows an "Update" pill next to the label. A blocked server
   keeps "Stopped for a security problem: <reason>." (Phase 03) and the Update
   button (Phase 05: a blocked version always differs from the pin), and its
   Start control is disabled with the tooltip "Update to
   start it."
5. Guide: a version Haruspex knows to be unsafe will not start, and Update
   fixes it; `settings.md` mentions the badge.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`; Guide
check.

## Test plan

- Vitest (`mcpUpdate.test.ts`): one toast for two updated servers, with the
  plural text; the singular text for one; no toast on the next launch for the
  same pins; a toast again after a newer pin; blocked toast on every launch; a
  localStorage that throws still shows the toast and does not crash.
- Vitest (`SettingsPanel.test.ts`): the rail badge shows the right count and
  disappears when the statuses clear.
- Vitest (`McpServerRow.test.ts`): the row pill shows with an update and goes
  after a successful update; a blocked row shows the reason, Update, and a
  disabled Start.
- Manual (dev build): pin an older Playwright, install, bump: one toast, badge
  on the rail and row, Update clears both. Add the installed version to
  `blockedVersions`: the server does not start, the reason shows, the toast
  appears on each launch, Update fixes it.

## Commit

`feat(mcp): tell the user when a catalog server has an update or is blocked`

## Rollback

Revert the commit. The block still holds without it (Phase 03 refuses to spawn
a blocked version and shows the reason on the row); only the toasts, badges and
the disabled Start go. The localStorage key is harmless if left
behind.
