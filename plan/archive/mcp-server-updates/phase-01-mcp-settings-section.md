# Phase 01 — MCP servers get their own Settings section

**Depends on:** nothing · **Enables:** Phase 06 (the rail badge and the toast's
deep link point at this section)

## Goal

Move the MCP UI out of Settings → Integrations into a new rail entry,
Settings → MCP servers, placed right after Integrations. Integrations keeps
Email and Calendar. This is a pure move with no behaviour change, so it ships on
its own and makes the later phases' UI land in the right place.

## Files touched

- `src/lib/components/settings/categories.ts` — add `'mcp'` to `Category`.
- `src/lib/components/settings/SettingsPanel.svelte` — new `CategoryDef`
  `{ id: 'mcp', label: 'MCP servers', … }` after Integrations in the
  "Capabilities" group; render `<McpSection />` under
  `activeCategory === 'mcp'`; remove it from the `integrations` branch.
- `src/lib/components/settings/SettingsPanel.test.ts` — the MCP mocks
  (`mcp_runtimes_available`) move to a test that clicks `rail('MCP servers')`;
  the Integrations tests assert MCP is no longer there.
- `e2e/ui/settings.spec.ts` — add 'MCP servers' to the listed rail entries.
- `docs/guide/settings.md` — new "## MCP servers" section; drop the MCP bullet
  from "## Integrations".
- `docs/guide/integrations.md` — "## Add an MCP server" says
  Settings → MCP servers.
- Any other `docs/guide/*.md` that says "Settings → Integrations" about MCP
  (grep for it) — same change.

## Steps

1. Add `'mcp'` to the `Category` union in `categories.ts`.
2. In `SettingsPanel.svelte`, add the rail entry with the subtitle "Tools from
   MCP servers, on this computer or your network." and feather's `server` icon:
   `<rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2"
   y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6"
   x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line>`.
   Change the Integrations subtitle to "Email and calendar."
3. Move `<McpSection />` to its own `{:else if activeCategory === 'mcp'}`
   branch.
4. Check `McpSection.svelte` for copy that says "Integrations" and update it.
5. Grep `src/lib` and `docs/guide` for "Integrations" near "MCP" and update
   every hit to "Settings → MCP servers".
6. Leave `src/lib/engine/settings.ts:40` and the guide page id `integrations`
   alone: they are a settings patch key and a page name, not the rail entry.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`,
`node scripts/guide-check.mjs` (via the PR's Guide check).

## Test plan

- `SettingsPanel.test.ts`: clicking "MCP servers" shows the catalog browser;
  clicking "Integrations" shows Email and Calendar and no MCP heading.
- Manual: open Settings in `npm run tauri dev`, check the rail order and that
  installing, editing and removing a server still work from the new section.

## Commit

`feat(settings): give MCP servers their own section`

## Rollback

Revert the commit. Nothing is stored under the new category id, so no settings
migration is involved.
