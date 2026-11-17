# Phase 02 — Peer client in Rust

**Depends on:** 01 · **Enables:** 03 (the manager streams through it), 05
(Settings probes and trusts with it), 07 (ops and uploads)

## Goal

A Rust client that talks to another Haruspex's owner API with its certificate
pinned by SHA-256, because the webview can't pin a self-signed certificate.
It can probe an unknown computer (fingerprint + health, no credentials sent),
and run ops, uploads and image fetches against a trusted one, with either
`X-Haruspex: 1` (trusted by the other's Who can connect) or a pasted token.

## Files touched

- `src-tauri/src/peers/mod.rs` — new module: `PeerConfig`, `PeerState`,
  `PeerAuth`, re-exports.
- `src-tauri/src/peers/tls.rs` — two rustls `ServerCertVerifier`s: `Capture`
  (accepts any cert, records the leaf's SHA-256) and `Pinned(fingerprint)`.
- `src-tauri/src/peers/client.rs` — `PeerClient`: address resolution, reqwest
  client built with the pinned verifier, `probe`, `op`, `upload`, `image`,
  `images_lookup`. The event stream is phase 03's, which adds it here.
- `src-tauri/src/peers/commands.rs` — Tauri commands `peer_probe`, `peer_op`,
  `peer_upload`, `peer_image`, `peer_images_lookup`, and the temporary
  `peers_set_config`.
- `src-tauri/src/secrets.rs` — a `peer:` namespace, not readable from the
  webview; a token is saved with the existing `secret_set` /
  `secret_delete` under `peer:<instanceId>`, as other secrets are.
- `src-tauri/src/owner/tls.rs` — make the private `fn fingerprint(der)`
  `pub(crate)`, so both sides print the same `AA:BB:…` string.
- `src-tauri/src/lib.rs` — `mod peers;`, manage a `PeerClients` registry,
  register commands.
- `src/lib/ipc/gen/*.ts` — `PeerConfig`, `PeerProbe`, `PeerAuthKind`
  generated.

## Steps

1. Types (`#[ts(export)]`, camelCase):
   - `PeerConfig { instance_id, name, address, port, fingerprint, auth:
     PeerAuthKind }` where `address` is what the owner typed or mDNS found
     (name or IP), `fingerprint` the pinned `AA:BB:…` string.
   - `enum PeerAuthKind { Trusted, Token }`. A token's value lives only in the
     keyring under `peer:<instance_id>`; Rust reads it per client build.
   - `PeerProbe { instance_id, name, version, fingerprint, address, port }`.
2. Address resolution: every connect resolves `address` with
   `tokio::net::lookup_host((address, port))`, preferring IPv4, and connects to
   `https://<ip>:<port>`. The `Host` is then that IP, which the other side's
   `host_is_ours` accepts; this is why typed tailnet FQDNs work without the
   other computer setting a link address. Resolution is redone on each
   reconnect so DHCP changes are followed.
3. `tls.rs`:
   - `Capture` verifier: `verify_server_cert` stores
     `owner::tls::fingerprint(end_entity)` in an `Arc<Mutex<Option<String>>>` and
     returns `ServerCertVerified::assertion()`; signature checks delegate to
     the ring provider's defaults.
   - `Pinned` verifier: compares `owner::tls::fingerprint(end_entity)` to the pin in
     constant time (`subtle` is not needed: fingerprints aren't secret, plain
     `==` is fine) and returns `Error::InvalidCertificate(
     CertificateError::ApplicationVerificationFailure)` on mismatch.
   - Both: SNI disabled (`enable_sni = false`); name checks skipped because
     the pin is the identity.
4. `PeerClient::probe(address, port)`: a one-off client with `Capture`, GET
   `/api/v1/health` with no credentials, 5 s timeout. Returns `PeerProbe`, or
   `"not Haruspex"` if the JSON lacks `ok`, or `"Haruspex on <name> is too
   old: update it"` if it lacks `instanceId`.
5. `PeerClient::for_peer(cfg)`: reqwest client with `Pinned`, 10 s connect
   timeout, no global timeout (the SSE stream is long-lived; ops set a 60 s
   per-request timeout). Default headers: `X-Haruspex: 1`, and
   `Authorization: Bearer <token>` when `auth == Token`.
6. A certificate mismatch is reported as the distinct error string
   `"certificate changed"` so the UI can ask again (phase 05); a 401/403 as
   `"not let in"`; a connect failure as `"offline"`.
7. Commands (all async, domain-first names): `peer_probe(address, port)`,
   `peer_op(peer_id, operation: serde_json::Value)` → the `value` the API
   answers, `peer_upload` (raw body, `x-peer-id` and `content-type`
   headers) → `{hash, mime, width, height}`, `peer_image(peer_id, hash)` →
   raw bytes, `peer_images_lookup(peer_id, urls)`. They look the peer up in `PeerClients`, which
   phase 03 fills from `peers_apply`; until then `PeerClients::set` is called
   from a temporary `peers_set_config` command so tests and phase 05 can use it.
   Phase 03 replaces `peers_set_config` with `peers_apply`.
8. Run `./scripts/export-ipc-types.sh`.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy --all-targets -- -D warnings && cargo test peers:: owner::`
- `npm run check && npm run lint`

## Test plan

Rust tests in `peers/client.rs` against the owner server's test harness
(`owner/server.rs` `serve()`; make it `pub(crate)` under `#[cfg(test)]` if
needed):

- probe returns the harness certificate's fingerprint and the identity from
  phase 01, and sends no `Authorization` or `X-Haruspex` header.
- with the right pin and the harness in `Lan` mode, `sessions.list` succeeds
  (the harness engine answers its stub).
- with a wrong pin, every call fails with `"certificate changed"`.
- `Tokens` mode without a token → `"not let in"`; with a harness-issued token
  → success.
- a name that resolves to 127.0.0.1 (`localhost`) connects by IP and passes
  the `Host` check.
- upload of a small PNG returns a hash.

## Commit

`feat(peers): add a pinned-certificate client for another Haruspex's owner API`

## Rollback

Revert the commit; nothing calls these commands yet outside tests.
