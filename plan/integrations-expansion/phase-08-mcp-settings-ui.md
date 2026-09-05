# Phase 08 — MCP settings UI

**Depends on:** Phases 06, 07 · **Enables:** Phase 09.

## Goal

The surface a non-technical user actually touches: browse the catalog, install a
server with a progress bar, complete its guided setup, see whether it is running,
and control which of its tools the model can see. Plus the tier-3 escape hatch for
a custom server.

## Files touched

- **NEW** `src/lib/components/settings/McpSection.svelte` — the section.
- **NEW** `src/lib/components/settings/McpServerRow.svelte` — one configured server.
- **NEW** `src/lib/components/settings/McpCatalogBrowser.svelte` — the catalog list.
- **NEW** `src/lib/components/settings/McpSetupWizard.svelte` — the guided-setup runner.
- **NEW** `src/lib/components/settings/McpToolList.svelte` — per-tool toggles + budget warning.
- **NEW** `src/lib/stores/mcpServers.svelte.ts` — server status and tool lists.
- **EDIT** `src/lib/components/settings/SettingsPanel.svelte` — mount `McpSection`
  after `EmailSection`.

## Implementation

Follow `EmailSection.svelte` for structure and the established visual language:
`.settings-section` is a card, `.toggle-row` is a switch, filled controls use
`accent-contrast` on the teal accent, surfaces stay the always-dark `#0c0b0a`.

### Server list

Each configured server shows its name, status (reusing the four-state vocabulary
from Phase 04), the negotiated protocol era and version, tool count, and controls
to start, stop, view logs, configure, or remove.

A server in `Error` shows its reason and the tail of its log ring inline. A
non-technical user's whole diagnostic surface is this panel, so it must say what
went wrong in words, with the raw log available but not shouted.

### Catalog browser

Lists the bundled catalog with name, description, what the server can do, and what
setup it will require *before* the user commits — a Google-Cloud-project step
disclosed after installation is a bad experience.

"Add" runs the install with the `DownloadProgress` events from Phase 06, then
hands off to the setup wizard.

### Setup wizard

Renders the ordered steps from the catalog entry generically: instruction text
with an optional link, masked secret inputs, a file picker via
`tauri-plugin-dialog`, and a command step that streams stdout/stderr into a
scrollable panel. The wizard is resumable — a user who closes it mid-Google-Cloud
detour returns to the step they were on, because that particular detour takes
long enough that they will.

### Tool list

Per-tool toggles with each tool's description and its annotation badges
(read-only / destructive). The budget warning from Phase 07 sits above the list
and names the model it is judged against. "Reset to defaults" restores the
catalog entry's tested `defaultTools`.

### Custom server (tier 3)

A form for command, arguments, environment variables and working directory,
feeding the same lifecycle and the same tool controls. Marked as advanced. No
catalog entry, no guided setup, and the same approval rules — a hand-configured
server is not more trusted than a curated one.

### Runtime health

If Phase 03's `runtimes_available()` reports a missing runtime, say so at the top
of the section and disable the affected acquisition kinds, rather than letting an
install fail deep in a spawn.

## Build gate

```bash
npm run check && npm run lint && npm run test
npm run format:check
```

## Test plan

- **Unit (TS)** — the server store's status transitions; the wizard advances,
  persists partial progress and resumes; tool toggles persist; the budget warning
  renders with real numbers.
- **Manual, end to end:**
  - Install GitHub from the catalog, enter a PAT, start it, and ask the model to
    search a repository.
  - Run the Google Drive/Workspace setup start to finish, including the browser
    auth step, without touching a terminal.
  - Close the app mid-wizard and confirm resume.
  - Add a custom server by command and confirm identical behaviour.
  - Verify the section in both light and dark themes.

## Commit

`feat(mcp): settings UI for catalog install, guided setup and tool control`

## Rollback

Revert. Configured servers persist in settings; only the UI to manage them goes.
