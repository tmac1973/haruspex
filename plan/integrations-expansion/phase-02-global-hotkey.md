# Phase 02 — Global hotkey: capture desktop context into a new chat

**Depends on:** Phase 01 · **Enables:** nothing (leaf).

## Goal

A system-wide keyboard shortcut that grabs the clipboard — plus the active window
where the platform can report it — brings Haruspex to the front, and drops the
captured context into a new chat's composer, ready to send. This is the change
that alters how the app *feels*: context arrives without the user switching to
the app and pasting.

## Files touched

- **EDIT** `src-tauri/Cargo.toml` — `tauri-plugin-global-shortcut`.
- **EDIT** `src-tauri/src/lib.rs` — register the plugin; register/unregister the
  binding at startup and whenever the setting changes; emit a `desktop-capture`
  event to the frontend.
- **EDIT** `src-tauri/src/desktop/mod.rs` — a `capture_context` helper that
  gathers clipboard + active window in one call, reused by the hotkey handler.
- **EDIT** `src/lib/stores/settings.ts` — `desktopHotkey: string | null`
  (default `null`, i.e. off) under the same desktop-context section.
- **EDIT** `src/lib/components/settings/DesktopSection.svelte` — a binding
  capture field, a "clear" control, and an inline error when registration fails.
- **EDIT** `src/lib/components/ChatView.svelte` (or the layout that owns chat
  creation) — listen for `desktop-capture`, open a new chat, prefill the composer.

## Implementation

### The binding

Stored as a Tauri accelerator string (`"CommandOrControl+Shift+Space"`). Default
is **off** — a desktop app that silently claims a global shortcut on first launch
is hostile, and shortcut collisions are common.

Registration can fail (another app owns the combination). Surface that inline in
Settings as a clear message; do not fail silently, and do not retry in a loop.

### The capture

The handler calls the same readers Phase 01 built. Active window contributes only
when `Available`; on Wayland the capture is clipboard-only and the composer says
so in a small note rather than pretending it captured nothing.

If the clipboard is empty *and* the window is unavailable, focus the app and
show a toast rather than opening an empty chat.

### Window handling

Bring the main window to the front and focus it — creating it if the app was
closed to tray. On Wayland, focus-stealing prevention may leave the window
requesting attention instead of raising; that is the compositor's call, and it is
acceptable. Do not fight it.

### The prefill

The composer is prefilled but **not sent**. The user decides what to ask. This
keeps the capture user-initiated end to end.

## Build gate

```bash
npm run check && npm run lint && npm run test
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
node scripts/check-ipc.mjs --write && git diff --exit-code src/lib/ipc/commands.ts
```

## Test plan

- **Unit (TS)** — settings round-trip; the event handler opens a chat and
  prefills; empty-capture path shows a toast instead.
- **Manual, per platform:**
  - Set a binding, copy text in another app, press it: Haruspex raises with the
    text and window name in the composer, unsent.
  - Set a binding already owned by the OS; confirm the inline failure message.
  - Clear the binding; confirm the shortcut stops working immediately without a
    restart.
  - macOS: confirm the shortcut works without Accessibility, and that the window
    title simply drops out when the grant is absent.

## Commit

`feat(desktop): global hotkey to capture context into a new chat`

## Rollback

Revert. The binding defaults to `null`, so no shortcut is claimed if the feature
is half-present.
