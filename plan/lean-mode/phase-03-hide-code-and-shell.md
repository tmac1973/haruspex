# Phase 03 — Hide the Code and Shell tabs

**Depends on:** 01, 02 · **Enables:** 07 (the notice's "Turn on" hides the tabs as the user expects)

## Goal

In lean mode, the desktop window shows Chat and Jobs only, and nothing can
navigate to Code or Shell. Hidden is not removed. Code sessions, open
terminals, their history and their settings stay as they are, and they return
when lean mode is turned off.

## Files touched

- `src/lib/stores/activeTab.svelte.ts`: `visibleTabs()` and a guarded
  `setActiveTab`.
- `src/lib/stores/activeTab.test.ts`: lean tests.
- `src/lib/components/TabBar.svelte`: render `visibleTabs()`.
- `src/routes/+layout.svelte`: the tab shortcut handler (:513-522) and the
  code-window listener (:231).
- `src/lib/components/ChatView.svelte`: hide the "open in Shell" button
  (~:720).
- `src/lib/components/TasksChip.svelte`: do not switch to Code (:80).
- `src/routes/code/[id]/+page.svelte`, `src/routes/shell/[id]/+page.svelte`:
  redirect in lean mode.
- `src/lib/components/settings/LeanModeSetting.svelte`: add "Code and Shell
  tabs" to "Off in lean mode".
- `docs/guide/getting-started.md`: "The main tabs" gets one sentence on lean
  mode.
- `docs/guide/shortcuts.md` and `src/lib/shortcuts.ts`: the tab-switch line.

## Steps

1. **visibleTabs.** In `activeTab.svelte.ts`, add `visibleTabs()`. It returns
   `mainTabs()` filtered to `chat` and `jobs` when `getSettings().leanMode` is
   on, and returns `mainTabs()` unchanged otherwise. `mainTabs()` keeps its
   meaning (all tabs, fixed order), because the shortcut numbering uses it.
2. **Guard.** `setActiveTab(tab)` ignores `shell` and `code` in lean mode and
   sets `chat` instead. `getActiveTab()` returns `chat` when the stored tab is
   `shell` or `code` and lean mode is on. The stored value is left alone, so
   turning lean mode off returns to the tab the user had. This covers every
   existing caller in one place:
   - `TasksChip`
   - `shell.svelte.ts:1079`
   - `fromChat.ts:47`
   - `code.svelte.ts:1363`
   - the layout's code-window listener
3. **TabBar.** Iterate `visibleTabs()` instead of the static `tabs` array. Keep
   labels and badges keyed by id.
4. **Shortcuts.** In `onTabSwitchKeydown`, keep the `^[1-4]$` match and
   `mainTabs()[n-1]`. Return early, without `preventDefault`, when that tab is
   not in `visibleTabs()`. Ctrl/⌘+1 and +2 still go to Chat and Jobs, and +3
   and +4 do nothing in lean mode. In `shortcuts.ts`, change the description
   to "Switch to the Chat, Jobs, Shell or Code tab (Chat and Jobs only in lean
   mode)". Change `docs/guide/shortcuts.md` to the identical text, which
   `pages.test.ts` enforces. The Shell-tab and Code-tab shortcut sections stay
   as they are, because they only fire inside those tabs.
5. **Paths in.**
   - `ChatView.svelte`: wrap the open-in-Shell button in
     `{#if !getSettings().leanMode}`.
   - `TasksChip.svelte`: for a `code:` task in lean mode, the click does
     nothing. The chip shows the task without the jump, and its `title` says
     "Turn off lean mode to open the Code tab."
   - The layout's `listenForCodeWindows(() => setActiveTab('code'))` needs no
     change, because step 2 guards it.
6. **Detached windows.** In `routes/code/[id]/+page.svelte` and
   `routes/shell/[id]/+page.svelte`, render one line instead of the session
   when lean mode is on: "Turn off lean mode in Settings → General to open
   this." The session itself is not closed.
7. **Settings list.** Add "Code and Shell tabs" as the first line of "Off in
   lean mode" in `LeanModeSetting.svelte`.
8. **Guide.** In `getting-started.md` "The main tabs", add: "In lean mode
   (Settings → General → Lean mode) only Chat and Jobs show." Update the
   settings page section from phase 02 to say the tabs are hidden.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Unit (`activeTab.test.ts`):
  - With lean on, `visibleTabs()` is `['chat','jobs']`.
  - `setActiveTab('code')` results in `chat`.
  - With a stored `shell`, `getActiveTab()` is `chat`.
  - With lean turned off, `getActiveTab()` is `shell` again.
- `pages.test.ts` passes with the new shortcut text.
- Live:
  - Turn lean mode on while on the Shell tab. The window switches to Chat and
    shows two tabs.
  - Ctrl+3 does nothing.
  - The Chat header has no open-in-Shell button.
  - A detached code window shows the one-line message.
  - Turn lean mode off. The Shell tab returns with its terminal still running.

## Commit

`feat(ui): hide the Code and Shell tabs in lean mode`

PR body names `docs/guide/getting-started.md`, `docs/guide/shortcuts.md` and
`docs/guide/settings.md`.

## Rollback

Revert the commit. The tabs come back. Lean mode still trims tools (phase 01),
and the badge and switch remain (phase 02). No stored state was changed.
