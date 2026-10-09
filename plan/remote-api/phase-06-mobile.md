# Phase 6 — Mobile (sketch)

**Depends on:** 4 · **Guide:** `remote-access` page

- The web client, made installable: manifest, icons, a service worker that
  caches only the app shell (never session data). Needs HTTPS, so
  `tailscale serve` (or equivalent) is a requirement here, not advice.
- Layout pass on phone widths: sidebar as a drawer, composer above the
  keyboard, diff cards scroll horizontally inside themselves.
- Reconnect after the phone sleeps: resync by snapshot (phase 2), and show
  "reconnecting" rather than a stale "running".
- Optional: notification when a turn finishes or an approval is waiting
  (Web Push needs a push service; decide whether that's acceptable for a
  private-by-design app, or poll on resume only).
- A native app only if the PWA can't do something the owner needs.
