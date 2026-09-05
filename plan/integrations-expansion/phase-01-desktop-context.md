# Phase 01 — Desktop context: clipboard + active-window tools

**Depends on:** nothing · **Enables:** Phase 02 (the hotkey reuses both readers), Phase 10 (screenshots join the same category and settings toggle).

## Goal

Give the agent two new tools — `read_clipboard` and `active_window` — behind a
single Settings toggle, on all three platforms, with an honest "unavailable"
where the platform genuinely cannot answer. This is the warm-up phase: it ships
something useful quickly and establishes the category + double-gating pattern
that Phase 07 later extends for MCP.

## Files touched

- **NEW** `src-tauri/src/desktop/mod.rs` — module docs (including the
  never-polled guarantee) and the `active_window` command.
- **NEW** `src-tauri/src/desktop/active_window.rs` — per-platform implementations
  behind `cfg`.
- **EDIT** `src-tauri/src/lib.rs` — `mod desktop;` and register the new command in
  `generate_handler![...]`.
- **EDIT** `src-tauri/Cargo.toml` — `x11rb` (Linux), `windows` (Win32), `objc2-app-kit`
  (macOS), each behind a `[target.'cfg(...)'.dependencies]` block so no platform
  pays for another's dependency.
- **NEW** `src/lib/agent/tools/desktop.ts` — registers both tools.
- **NEW** `src/lib/agent/tools/desktop.test.ts`.
- **EDIT** `src/lib/agent/tools/index.ts` — side-effect import.
- **EDIT** `src/lib/agent/tools/types.ts` — add `'desktop'` to the `category` union.
- **EDIT** `src/lib/agent/tools/registry.ts` — `desktopContext` on `ToolFilterOpts`,
  the chat-mode filter arm, and the hard gate in `executeTool`.
- **EDIT** `src/lib/stores/settings.ts` — `desktopContextEnabled` (default `false`)
  plus a `desktopContextActive()` predicate alongside `hasEnabledEmailAccount()`.
- **NEW** `src/lib/components/settings/DesktopSection.svelte` — modelled on
  `EmailSection.svelte`.
- **EDIT** `src/lib/components/settings/SettingsPanel.svelte` — mount it.

## Implementation

### Clipboard — no new native code

`src-tauri/src/clipboard.rs` already exposes `clipboard_read_text` and
`clipboard_read_primary`, both `async` and both reading off the main thread. That
constraint is load-bearing: a synchronous `#[tauri::command]` runs on the main
thread and blocking arboard there freezes WebKitGTK. The new tool `invoke`s the
existing command; **do not add a synchronous variant.**

The tool returns the clipboard text with a length cap (truncate head/tail, same
spirit as `shell/truncate.ts`) so a user who copied a 40 MB log doesn't blow the
context window in one tool call.

### Active window — a tagged result, not an error

```rust
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActiveWindow {
    Available { app_name: String, title: Option<String> },
    Unavailable { reason: String },
}
```

`Unavailable` is a normal, expected outcome — not an `Err`. The reason string is
written for the model and the user to read, e.g. *"Wayland does not let
applications read which window is focused."*

Per platform:

- **Linux/X11** — `x11rb`: read `_NET_ACTIVE_WINDOW` off the root window, then
  `_NET_WM_NAME` (UTF-8) and `WM_CLASS` for the app name.
- **Linux/Wayland** — return `Unavailable`. `ext-foreign-toplevel-list-v1` is
  compositor-dependent and does not cleanly report focus; GNOME needs a shell
  extension and KDE needs KWin scripting. Detect via `XDG_SESSION_TYPE` /
  `WAYLAND_DISPLAY`, and note that XWayland clients still answer the X11 path —
  so try X11 first and fall back to `Unavailable`.
- **Windows** — `GetForegroundWindow` + `GetWindowTextW`, plus
  `GetWindowThreadProcessId` → `QueryFullProcessImageNameW` for the app name.
- **macOS** — `NSWorkspace.sharedWorkspace.frontmostApplication` gives the app
  name with no permission. The window *title* needs an Accessibility grant; when
  it is absent, return `Available` with `title: None` and say so in the tool
  result rather than prompting.

### Tools

`read_clipboard` takes no arguments. `active_window` takes no arguments. Neither
takes a "watch" or "poll" option, now or ever.

Both are registered with `category: 'desktop'`. Gating is enforced **twice**:

1. `shouldIncludeChatTool` drops the category when `desktopContext` is false, and
2. `executeTool` hard-gates it before dispatch.

The second is not redundant. The existing sandbox and memory-write gates document
exactly why: `executeTool` resolves names against the **full** registry, so a
small model emitting a call it was never offered would otherwise execute it.

Not exposed in Shell or Code mode — `shouldIncludeShellTool` and
`shouldIncludeCodeTool` both fall through to `false` for unknown categories, so
this needs no change there. Verify that with a test rather than by reading.

### Never polled

Say it in the module docs, say it in the tool descriptions, and prove it with a
test asserting no timer or interval exists in the desktop module. The brief's
hard constraint is that this is *obviously* user-initiated from reading the
source.

## Build gate

```bash
npm run check && npm run lint && npm run test
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
node scripts/check-ipc.mjs --write && git diff --exit-code src/lib/ipc/commands.ts
```

Cross-compile check is not enough for the `cfg` arms — build on each platform.

## Test plan

- **Unit (TS)** — tool registration; schema filtering on and off with the
  setting; `executeTool` refuses when the setting is off; clipboard truncation.
- **Unit (Rust)** — the `Unavailable` serialization shape; the Wayland detection
  helper against faked env vars.
- **Manual, per platform:**
  - X11: focus a known window, call `active_window`, confirm title and app name.
  - Wayland: confirm a clear `Unavailable` (and that an XWayland app still works).
  - macOS: confirm app name without a grant; confirm title appears after granting
    Accessibility.
  - Windows: confirm title and app name.
  - All: copy text, ask the model "what's on my clipboard".

## Commit

`feat(desktop): expose clipboard and active window to the agent`

## Rollback

Self-contained. Revert the commit; the setting defaults to `false`, so even a
partially-landed version exposes nothing.
