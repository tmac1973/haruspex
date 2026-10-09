# Phase 3 — Owner API: transport, tokens, Settings (sketch)

**Depends on:** 2 · **Guide:** `remote-access` page (or a new `remote-api` page)

- **Listener:** its own axum listener, separate from remote chat's, reusing
  `remote/auth.rs` and the relay's replay and orphan-grace logic. Own
  bind address, default `127.0.0.1`. Separate because the two have different
  audiences: guest chat on the LAN, owner control on loopback or a tailnet
  interface.
- **Routes:** `POST /api/v1/<op>` for each phase-2 operation;
  `GET /api/v1/events` WebSocket (or SSE plus POST, if WebSocket through
  `tailscale serve` causes trouble) for the event stream; `/api/health`
  unauthenticated.
- **Rust → webview:** the relay pattern. Emit a Tauri event to the owning
  window with a request id; the dispatcher answers through one command.
  Timeouts and "no window can answer" fail fast, like
  `a_prompt_nobody_can_run_fails_instead_of_hanging`.
- **Clients and tokens:** each paired client gets its own token (in
  `secrets.rs`, never in settings JSON), a name, a last-seen time, and a scope:
  `read` (watch sessions), `drive` (prompts, steer, cancel), `approve`
  (answer command approvals). Revoking one never touches the others.
- **Pairing:** Settings → Remote access → Add device shows a one-time link and
  QR code. The token goes into an `HttpOnly; SameSite=Strict; Secure` cookie
  on first open, as remote chat does.
- **Settings → Remote access:** enable, bind address (loopback / a chosen
  interface), paired devices with revoke, and one sentence pointing at
  `tailscale serve` for HTTPS.
- **The driver** gains `--via api`: drive a running dev app
  (`npm run tauri dev`) through this API, no WebDriver. Tests the API, and
  lets Claude poke a hot-reloading app.
- **Tests:** the axum test pattern in `remote/server.rs` (token required,
  scope enforced per route, rotation cuts off, stopped server stops
  answering), plus a phase-1 driver spec that runs over `--via api`.
