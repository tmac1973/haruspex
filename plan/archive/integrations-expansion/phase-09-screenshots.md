# Phase 09 — Screen capture

**Depends on:** nothing (track B) · **Enables:** nothing (leaf).

This phase is self-contained: it creates the `desktop/` module, the Settings
section and the `desktop` tool category that no other phase provides.

## Goal

Let the user hand the model what is on their screen — whole screen or a chosen
window — on every platform, with capture that is unmistakably user-initiated.

Vision is not a blocker: every model in `src-tauri/src/models.rs` carries an
`mmproj_url`, so the shipped local models can all see images. **No OCR fallback is
needed.**

## Files touched

- **NEW** `src-tauri/src/desktop/mod.rs` — module docs (including the
  never-polled guarantee) and the capture command.
- **NEW** `src-tauri/src/desktop/screenshot.rs` — per-platform capture.
- **EDIT** `src-tauri/src/lib.rs` — `mod desktop;` and register the command in
  `generate_handler![...]`.
- **EDIT** `src-tauri/Cargo.toml` — `ashpd` (Linux portal), plus per-platform
  blocks (`windows` for Win32, `objc2`/ScreenCaptureKit for macOS) under
  `[target.'cfg(...)'.dependencies]` so no platform pays for another's deps.
- **NEW** `src/lib/agent/tools/screen.ts` — the `capture_screen` tool.
- **NEW** `src/lib/agent/tools/screen.test.ts`.
- **EDIT** `src/lib/agent/tools/index.ts` — side-effect import.
- **EDIT** `src/lib/agent/tools/types.ts` — add `'desktop'` to the `category` union.
- **EDIT** `src/lib/agent/tools/registry.ts` — `screenCapture` on `ToolFilterOpts`,
  the chat/code-mode filter arms, and the hard gate in `executeTool`.
- **EDIT** `src/lib/stores/settings.ts` — `screenCaptureEnabled` (default `false`).
- **NEW** `src/lib/components/settings/DesktopSection.svelte` — modelled on
  `EmailSection.svelte`; one toggle.
- **EDIT** `src/lib/components/settings/SettingsPanel.svelte` — mount it.
- **EDIT** `src/lib/components/ChatView.svelte` / `ChatImageStrip.svelte` — a
  composer attach control.

## Implementation

### Per platform

- **Linux, Wayland — portal first.** `xdg-desktop-portal`'s Screenshot interface
  via `ashpd`. The portal's own picker is not an obstacle to work around: it *is*
  the user-initiated guarantee, enforced by the OS rather than promised by us.
- **Linux, X11** — direct capture of the root window or a chosen window. Try the
  portal first regardless; fall back to X11 when no portal is present.
- **macOS** — ScreenCaptureKit. Requires the Screen Recording grant; detect its
  absence and return a clear result telling the user where to grant it, rather
  than returning a black image (which is what macOS actually hands back).
- **Windows** — native capture of the desktop or the foreground window.

### Result handling

Captures are PNG. Route them through the existing image path rather than a new
one: `src-tauri/src/image_cache/` for storage and the `asset` protocol, and the
`thumbDataUrl` / `PendingImage` channel already on `ToolExecOutput` and
`ToolContext` for getting the image in front of both the model and the user.

Downscale before sending. A 4K screenshot is an enormous number of image tokens
for a 9B model; cap the long edge at something the vision projector actually
benefits from and record the chosen number with its reasoning in the code.

### Tool

`capture_screen` is registered with `requiresVision: true`. The registry already
filters vision-dependent tools when the backend cannot see images
(`shouldIncludeCodeTool` and `shouldIncludeChatTool` both check it), so a
text-only remote backend never gets offered a tool it cannot use.

Arguments: an optional target (`screen` | `window`). Nothing else. No interval,
no "capture until", no background variant.

### Consent

One Settings toggle, default **off**. Gating is enforced **twice**: the category
is dropped from `getToolSchemas` when the toggle is off, *and* `executeTool`
hard-gates before dispatch. The second check is not redundant — `executeTool`
resolves names against the **full** registry, so a small model emitting a call it
was never offered would otherwise execute it. The existing sandbox and
memory-write gates document exactly this.

Never polled. Say it in the module docs, say it in the tool description, and
prove it with a test asserting no timer or interval exists in the desktop module.
The constraint is that user-initiation is *obvious* from reading the source.

## Build gate

```bash
npm run check && npm run lint && npm run test
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
node scripts/check-ipc.mjs --write && git diff --exit-code src/lib/ipc/commands.ts
```

## Test plan

- **Unit (TS)** — the tool is hidden when vision is unsupported; hidden when the
  toggle is off; refused by `executeTool` when off.
- **Unit (Rust)** — downscale maths; the missing-permission result shape.
- **Unit** — no timer or interval anywhere in the desktop module.
- **Manual, per platform:**
  - Wayland: portal picker appears, capture succeeds, model describes the image.
  - X11: capture without a portal present.
  - macOS: confirm the guidance result before the grant, and a real capture after.
  - Windows: whole screen and foreground window.
  - Confirm the captured image renders in the chat and the model actually reads it.

## Commit

`feat(desktop): user-initiated screen capture for vision-capable models`

## Rollback

Revert. Default-off toggle means a partial landing exposes nothing.
