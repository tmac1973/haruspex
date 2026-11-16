# Phase 03 — Peer manager: streams, status, last-known lists

**Depends on:** 02 · **Enables:** 04 (found peers feed it), 05 (Settings
shows its status), 07 (frontend store subscribes to its events)

## Goal

Rust holds one event stream per trusted peer while the feature is on,
reconnecting with backoff, and emits each event to every window as a Tauri
event. It also keeps each peer's last-known session and chat list (titles and
times only) in the database, so an offline peer's section can still be drawn.
One stream per peer, however many windows are open.

## Files touched

- `src-tauri/src/peers/manager.rs` — new: `PeerManager` (task per peer,
  status map, apply).
- `src-tauri/src/peers/commands.rs` — `peers_apply(config)`, `peers_status`,
  `peer_lists_get(peer_id)`, `peer_lists_save(peer_id, sessions, chats)`;
  remove phase 02's `peers_set_config`.
- `src-tauri/src/db/mod.rs` — migration: `peer_lists` table.
- `src-tauri/src/db/peer_lists.rs` — new: get/save/delete.
- `src-tauri/src/lib.rs` — manage `PeerManager`, register commands, stop it on
  exit.
- `src/lib/ipc/gen/*.ts` — `PeersConfig`, `PeerStatus`, `PeerConnection`.

## Steps

1. `PeersConfig { enabled: bool, peers: Vec<PeerConfig> }` (`#[ts(export)]`).
   `peers_apply` is idempotent, like `owner_api_apply`: peers whose config is
   unchanged keep their running stream; removed ones stop; changed ones
   (address, port, fingerprint, auth) restart. `enabled: false` stops all and
   clears status.
2. Per peer, a tokio task:
   - builds `PeerClient::for_peer`, GETs `/api/v1/events`, parses SSE frames
     (blank-line framed, `data:` lines joined with `\n`, the same rule as
     `sseParser` in `src/web/api.ts`), and emits
     `app.emit("peer://event", {peerId, event})` with the parsed JSON as is.
   - on connect emits `peer://event` with `{type:"ready"}`, as the web stream
     does, so the frontend resyncs.
   - on end or error: status `offline` (or `certificateChanged` / `notLetIn`
     from phase 02's errors, which stop the task until the next apply instead
     of retrying), then retries after 1 s doubling to 30 s; success resets.
   - status changes emit `peer://status` with `PeerStatus { peerId,
     connection: connecting|open|offline|certificateChanged|notLetIn,
     lastSeen: Option<i64> }`.
3. `peers_status` returns every peer's current `PeerStatus`, for a window
   opened after the events fired.
4. `peer_lists` table: `peer_id TEXT PRIMARY KEY, sessions TEXT NOT NULL,
   chats TEXT NOT NULL, updated_at INTEGER NOT NULL`. `sessions` and `chats`
   are JSON arrays the frontend writes (phase 07) holding only `{id, title,
   root, updatedAt}` for sessions (`updatedAt` null from an older peer) and
   `{id, title, updatedAt}` for chats; Rust doesn't interpret them. `peer_lists_save`
   rejects arrays over 2,000 entries or 1 MB. Deleting a peer from config in
   `peers_apply` deletes its row.
5. The manager never runs ops itself; it only streams. Ops go through phase
   02's commands, which now look peers up in the manager's config.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy --all-targets -- -D warnings && cargo test peers:: db::`
- `./scripts/export-ipc-types.sh` leaves no diff; `npm run check && npm run lint`

## Test plan

- Rust: against the owner harness, apply one peer → status goes
  `connecting` → `open`, and an engine event the harness publishes arrives
  through a test emitter hook (the manager takes an `Emit` trait so tests
  don't need an `AppHandle`).
- Stop the harness → `offline`; restart it on the same port → `open` again
  within the backoff.
- Wrong pin → `certificateChanged`, no retry until re-apply.
- Applying the same config twice doesn't restart the stream (count connects
  on the harness).
- `db/tests.rs`: save/get round trip; oversize refused; peer removal deletes
  the row.

## Commit

`feat(peers): keep an event stream per trusted peer and its last-known lists`

## Rollback

Revert. The `peer_lists` table stays in existing databases; it's
`CREATE TABLE IF NOT EXISTS` and unused, so leaving it is safe.
