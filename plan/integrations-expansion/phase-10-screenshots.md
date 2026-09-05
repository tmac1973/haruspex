# Phase 10 — Screen capture

**Depends on:** nothing (track C) · **Enables:** nothing (leaf). Shares the Phase 01 settings section if that has landed; otherwise creates it.

## Goal

Let the user hand the model what is on their screen — whole screen or a chosen
window — on every platform, with capture that is unmistakably user-initiated.

Vision is not a blocker: every model in `src-tauri/src/models.rs` carries an
`mmproj_url`, so the shipped local models can all see images. **No OCR fallback is
needed.**

## Files touched

- **NEW** `src-tauri/src/desktop/screenshot.rs` — per-platform capture.
- **EDIT** `src-tauri/src/desktop/mod.rs` — the capture command.
- **EDIT** `src-tauri/Cargo.toml` — `ashpd` (Linux portal), plus the existing
  per-platform blocks from Phase 01.
- **NEW** `src/lib/agent/tools/screen.ts` — the `capture_screen` tool.
- **EDIT** `src/lib/components/ChatView.svelte` / `ChatImageStrip.svelte` — a
  composer attach control.
- **EDIT** `src/lib/components/settings/DesktopSection.svelte` — a separate
  screen-capture toggle.

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

Screen capture gets its **own** toggle, separate from clipboard and active window.
They are different orders of intrusion and should not share a switch. Default off.
Never polled, and — as with Phase 01 — obviously so from reading the source.

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
