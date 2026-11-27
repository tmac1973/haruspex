# Phase 02 — Settings toggle, open-at-section, header badge

**Depends on:** 01 · **Enables:** 03, 04 (they add lines to the "what's off"
list), 07 (the badge hosts the model-swap hint)

## Goal

Give lean mode a switch the user can see and a constant reminder that it is on.
This phase adds Settings → General → Lean mode with a short list of what lean
mode turns off, and a way to open Settings at a given section. It also adds a
**Lean mode** badge in the window header that opens it. After this phase, a
user can turn lean mode on and get the phase 01 tool set. The tabs still show
until phase 03.

## Files touched

- `src/lib/stores/settingsNav.svelte.ts` (new): open Settings at a category
  and anchor.
- `src/lib/stores/settingsNav.test.ts` (new).
- `src/routes/+layout.svelte`: make `showSettings` follow the store, and mount
  the badge.
- `src/lib/components/settings/SettingsPanel.svelte`: read the requested
  category and scroll to the anchor.
- `src/lib/components/settings/GeneralSection.svelte`: the lean mode switch.
- `src/lib/components/settings/LeanModeSetting.svelte` (new): the switch, the
  "what's off" list and the busy guard.
- `src/lib/lean/pausedIntegrations.ts` (new) and its `.test.ts`: list the
  configured integrations that lean mode pauses.
- `src/lib/stores/shell.svelte.ts`: export `anyShellTurnRunning()`.
- `src/lib/components/LeanModeBadge.svelte` (new): the header badge.
- `docs/guide/settings.md`: a "Use lean mode on a small model" section under
  General.

## Steps

1. **settingsNav store.** Create `settingsNav.svelte.ts` holding
   `$state<{ open: boolean; category: Category | null; anchor: string | null }>`.
   Export:
   - `openSettings(category?: Category, anchor?: string)`
   - `closeSettings()`
   - `toggleSettings()`
   - `getSettingsNav()`
     Move the `Category` union out of `SettingsPanel.svelte` (:30-49) into a new
     `src/lib/components/settings/categories.ts`. `SettingsPanel.svelte` and the
     store both import it from there.
2. **Layout.** Replace the local `showSettings` `$state` in `+layout.svelte`
   (:103) with `getSettingsNav().open`. The header gear button calls
   `toggleSettings()`, the panel's `onclose` calls `closeSettings()`, and the
   `/setup` auto-close (:110-114) calls `closeSettings()`.
3. **Panel.** In `SettingsPanel.svelte`, an `$effect` watches
   `getSettingsNav()`. When `category` is set, it calls
   `selectCategory(category)`. After `tick()`, it runs
   `document.getElementById(anchor)?.scrollIntoView({ block: 'center' })` and
   then clears `category` and `anchor` in the store. A requested category wins
   over the localStorage restore in `onMount`.
4. **Paused integrations.** `pausedIntegrations(settings)` returns display
   names for what is configured and would otherwise be offered:
   - "Email" (`hasEnabledEmailAccount()`)
   - "Calendar" (`hasEnabledCalendarAccount()`)
   - "Contacts" (`hasEnabledContactsAccount()`)
   - "Screen capture" (`screenCaptureEnabled`)
   - "Image generation" (`imageBackendKind !== 'none'`)
   - "Music generation" (`musicBackendKind !== 'none'`)
   - "Video generation" (`videoGenBackendKind !== 'none'`)
   - "Python sandbox" (`sandboxEnabled`)
   - "MCP: <server label>" for each server in `startableMcpServers()`
     (`settings.ts:1420`).
     Unit-test it with each one on and off.
5. **Shell busy helper.** `ShellSession` sets its private `abortController`
   when an assistant turn starts (`shell.svelte.ts:970`) and clears it when the
   turn ends (:1049). Add a public getter
   `get assistantBusy(): boolean { return this.abortController !== null; }`.
   `abortController` is a plain field today (:249); change it to
   `private abortController = $state<AbortController | null>(null);` so the
   getter is reactive. Then add
   `export function anyShellTurnRunning(): boolean { return getShellSessions().some((s) => s.assistantBusy); }`.
6. **LeanModeSetting.svelte**, rendered at the top of `GeneralSection.svelte`
   inside `<div id="lean-mode">`:
   - Heading "Lean mode" and a switch bound through `setLeanMode`.
   - One line of copy: "Chat and research only, for small models and slow
     machines." Tooltip (`title`): "Sends a much smaller tool list, so replies
     start sooner and leave more room in the context window."
   - When on, a compact list "Off in lean mode:" with "File writing, Python,
     skill writing and speech generation" and each name from `pausedIntegrations()`. Phases 03 and 04 append their lines here.
   - Busy guard: when lean mode is **off** and either
     `getOpenSessions().some((s) => s.status !== 'idle')` or
     `anyShellTurnRunning()` is true, the switch is disabled. Its `title` reads
     "Finish or stop the Code and Shell turns first." Turning lean mode **off**
     is never blocked.
7. **Badge.** `LeanModeBadge.svelte` renders only when `getSettings().leanMode`
   is true, as a small pill reading "Lean mode", styled like
   `ServerStatusBadge`. It has `title="Fewer tools and tabs for small models.
Click to change."` and calls `openSettings('general', 'lean-mode')` on
   click. Mount it in `.header-right` in `+layout.svelte`, before
   `ServerStatusBadge` (:621).
8. **Guide.** In `docs/guide/settings.md` under General, add a short section,
   "Use lean mode on a small model". It says what lean mode keeps, what it
   turns off and where the badge is, and that the switch waits while Code or
   Shell turns run. Keep the page under 6 KB.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Unit: `settingsNav.test.ts` (open with a category sets the state, and
  close clears it) and `pausedIntegrations.test.ts`.
- Live:
  - Turn lean mode on in Settings → General. The badge appears.
  - Close Settings, click the badge. Settings opens on General with the switch
    centred.
  - With an email account and an MCP server set up, both are listed under "Off
    in lean mode".
  - Start a Code turn and open Settings: the switch is disabled with the
    tooltip.
  - Turn lean mode off: the badge goes.

## Commit

`feat(settings): add the lean mode switch and header badge`

PR body names `docs/guide/settings.md`.

## Rollback

Revert the commit. The settingsNav store replaces a local variable, so the
revert restores the old gear-button toggle. Phase 01's setting remains and
still works without UI.
