# Phase 3 — Owner API: transport, tokens, Settings

**Depends on:** 2 · **Guide:** new `remote-control` page; `settings` (new section)

## Goal

Phase 2's engine, reachable over HTTP by the owner's own devices and scripts:
off by default, loopback by default, one token per client with its own scopes.
Phase 4's web client and the driver's `--via api` are its first users.

## What exists (2026-10-09)

- **Remote chat** (`src-tauri/src/remote/`) is an axum server on its own port
  (default 8787, `remoteAccessPort`). It authenticates per handler
  (`unauthorised()`) against one shared token, compared in constant time
  (`auth::token_matches`). Events go over SSE (`axum::response::sse`, a 15 s
  keepalive, snapshot on `Lagged`). It has no Origin or Host checks; CSRF
  protection is the SameSite=Strict cookie plus the JSON content type.
  Tests start it on port 0 and drive it with reqwest (`server.rs` `http_tests`).
- **The engine hub** (`src-tauri/src/engine/`): `engine::request(app, op)`
  routes an op, `EngineHub::subscribe()` gives every window's events, and
  `enabled` is fixed at startup (e2e build only).
- **Randomness and hashing:** `ring::rand::SystemRandom` mints tokens elsewhere
  in the app; `sha2` is a direct dependency.
- axum 0.8 without the `ws` feature.

## Decisions

| #   | Question          | Decision                                                                                                                                                                                                                                           |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Events transport  | **SSE**, as remote chat does: works with a bearer header from `fetch` and Node, no new axum feature, and `tailscale serve` passes it through. A WebSocket is a later option if two-way traffic is needed.                                          |
| 2   | Port              | **8788** by default (`ownerApiPort`), next to remote chat's 8787. Its own listener.                                                                                                                                                                |
| 3   | Bind              | **Loopback** (default) or **all interfaces**. Loopback is what `tailscale serve` proxies to, and it gives HTTPS on the tailnet. "All" is for NetBird and plain LANs, and the guide says to firewall it.                                            |
| 4   | Tokens            | **Minted in Rust** (32 bytes from `SystemRandom`, hex), **shown once**, stored only as SHA-256 hashes in `owner-clients.json` in the app data dir. A hash is not a secret, so no keychain is needed and a lost token is replaced, never recovered. |
| 5   | Scopes            | `read` (list, get, resync, prompts.list, events), `drive` (open, new, send, stop, cancelShellWait), `approve` (prompts.answer). Each client has a set; a new one gets all three.                                                                   |
| 6   | Pairing link / QR | **Phase 4**, with the web client that would open it. Phase 3 shows the token once, to copy.                                                                                                                                                        |
| 7   | Settings home     | **A new Settings → Remote control category**, separate from Remote access (guest chat), per overview decision 4.                                                                                                                                   |

## 1. Rust: `src-tauri/src/owner/`

- **`clients.rs`:**
  - `OwnerClient { id, name, scopes: Vec<Scope>, created_at, last_seen: Option<i64>, token_hash }`.
  - `Clients` loads and saves `owner-clients.json` (atomic write; 0600 on Unix). It offers `create(name, scopes) -> (OwnerClient, token)`, `revoke(id)` and `list()`.
  - `authenticate(token) -> Option<OwnerClient>` hashes the presented token and compares it with every stored hash in constant time, so how far a guess matched never shows in the timing.
  - `last_seen` lives in memory and is written to disk at most once a minute.
- **`server.rs`** (axum, after `remote/server.rs`):
  - `GET /api/v1/health`: open; returns `{ ok, version }`.
  - `POST /api/v1/op`: the body is an engine op, at most 64 KiB. Checks the scope for its `type`, then calls the engine. Answers `200 {value}`, or `{error}` with 400 for an unknown op, 403 for a missing scope, 409 for an engine refusal, and 504 for a window timeout.
  - `GET /api/v1/events` (SSE, needs `read`):
    - Streams `EngineHub::subscribe()` with a 15 s keepalive.
    - On `Lagged` it sends `{ type: "resync-all" }`; the client then sends `session.resync` for each session it follows.
    - Prompt events for prompts it can't answer still go out, so a `read`-only client can see why a turn is stuck.
  - **Auth** (one helper, every route but health):
    - `Authorization: Bearer <token>` only. No cookie or query token until phase 4 needs one, so no CSRF surface yet.
    - A request whose `Origin` doesn't match its `Host` is refused (403). There are no CORS headers, so browsers can't call it cross-site.
    - **Failed-auth throttle:** 10 failures a minute from one IP, then 429 for the rest of that minute.
  - The engine sits behind a `Dispatch` trait (as remote chat's `Host`), so the HTTP tests run without Tauri.
  - `start(config) -> Running` / `stop`, like remote chat. Starting turns the hub on (`EngineHub::set_enabled(true)`), stopping turns it off, except in the e2e build where it stays on. Either way, every window hears `engine://enabled`.
- **`commands.rs`** (all with `#[ts(export)]` types):
  - `owner_api_apply(config: { enabled, port, bindAll }) -> OwnerApiStatus` starts, restarts or stops it.
  - `owner_api_status`.
  - `owner_clients_list`, `owner_client_create { name, scopes } -> { client, token }` and `owner_client_revoke { id }`.
- **Engine:** `EngineHub.enabled` becomes an `AtomicBool` with `set_enabled`. The webview engine starts on `engine://enabled` if it was off at load, so turning the API on needs no restart.

## 2. Frontend

- **Settings:** `ownerApiEnabled` (false), `ownerApiPort` (8788), `ownerApiBindAll` (false).
- **`src/lib/owner/service.ts`:** `syncOwnerApi()`, called from the main window's bootstrap and the section, as `syncRemoteServer` is.
- **`OwnerApiSection.svelte`** (Settings → Remote control):
  - **On/off**, with the help line "Drive your Code sessions from your own devices."
  - **Port**, and **"Listen on all networks"** with a title tooltip on firewalls and `tailscale serve`.
  - **The address** it answers on.
  - **Devices:** name, scopes, last seen and Revoke. Add device takes a name and scope checkboxes, then shows the token once with Copy and "You won't see it again."
- **`docs/guide/remote-control.md`** (new, added to `PAGES`): turn it on; reach it from another device (`tailscale serve`, or all networks plus a firewall); devices and scopes; what it doesn't do yet (no web page until phase 4, Code sessions only); security notes.
- **`docs/guide/settings.md`** gets `## Remote control`.

## 3. Driver

- `drive start --api` turns the API on (loopback, a free port) through a hook, creates a client, and from then on sends engine ops over HTTP (`POST /api/v1/op`) instead of WebDriver `execute`. The UI paths (`send` without `--via engine`) are unchanged.
- `drive api-events [--seconds N]` reads the SSE stream for N seconds and prints what came.
- The self-test runs a second pass with `--api`: a turn, an approval and `consistent`.

## Tests

- **`owner::clients`:**
  - a create → authenticate round trip;
  - a revoked token fails;
  - a wrong token fails;
  - the file holds no token, only hashes;
  - scopes are checked per op type.
- **`owner::server`** (port 0, reqwest, a stub `Dispatch`):
  - health is open;
  - every other route needs a token;
  - a missing scope gets 403;
  - an Origin that doesn't match the Host gets 403;
  - the throttle gives 429;
  - an oversized body gets 413;
  - the SSE stream delivers a published event, and sends `resync-all` after a lag;
  - a stopped server stops answering.
- **Frontend:** the section renders, Add device shows the token once, and Revoke removes the device (component tests with mocked IPC). `pages.test.ts` passes with the new page.
- **Driver self-test** `--api` pass.

## Done when

The owner can turn on Settings → Remote control, add a device, and with its
token drive a Code session with `curl` (op) and watch it (events). The driver
does the same in CI. With the API off, the port is closed and the engine
stays off.

## As built (2026-10-09)

Branch `remote-api/p03-owner-api`. As planned, with these notes:

- **The engine starts on switch-on.** Each window listens for
  `engine://enabled` before it asks `engine_enabled`, so a switch-on between
  the two isn't missed. Switching off leaves a window's watchers running:
  Rust drops what they send while off.
- **`settings.md` is at the 6 KB page limit** (5,999 bytes after the
  Remote control entry and a few trims elsewhere). The next section added
  there needs a trim or a split.
- **The `authorise` helper returns `(status, message)`,** not a `Response`
  (clippy `result_large_err`).

**Checked:**

- 20 Rust tests in `owner::`: devices, hashes, scopes, and the HTTP surface
  (auth, scopes, Origin, throttle, body limit, SSE ready, lag → `resync-all`,
  stop).
- 3 component tests for the section.
- The guide tests, with the new page.
- 14 UI flows.
- The driver self-test (24 checks), with an `--api` pass: a turn over HTTP,
  the event stream, and `consistent`.
