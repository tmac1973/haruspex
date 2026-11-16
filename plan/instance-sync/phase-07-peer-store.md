# Phase 07 — Peer store in the frontend

**Depends on:** 02, 03, 05, 06 · **Enables:** 09, 11, 12

## Goal

Each window keeps an `EngineClient` per trusted peer, fed by phase 03's
`peer://event` and driven through phase 02's commands, plus the peer's
last-known lists for when it's offline. This is the one place the Code and
Chat sidebars, the remote adapters and the prompt bridge read another
computer's state from.

## Files touched

- `src/lib/peers/transport.ts` — new: a `Transport` over Tauri.
- `src/lib/peers/store.svelte.ts` — new: `peers` registry (`PeerView` per
  trusted peer).
- `src/lib/peers/images.ts` — new: resolve a peer's image URLs to object URLs.
- Tests beside each.

## Steps

1. `peerTransport(peerId)`:
   - `op(o)` → `invoke('peer_op', { peerId, operation: o })`, mapping the
     Rust error strings (`offline`, `not let in`, `certificate changed`) onto
     `ApiError` (`#lib/engine/transport.ts`, phase 06) statuses 0/401/495 so `EngineClient` handles them as the web
     client does.
   - `events(onEvent, onConnection)` → `listen('peer://event')` filtered by
     `peerId`, and `listen('peer://status')` mapped to `Connection`
     (`open`→`open`, `connecting`→`connecting`, `offline`→`offline`,
     `notLetIn`/`certificateChanged`→`unauthorised`). Returns an unlisten.
   - `upload(blob)` → `invoke('peer_upload', { peerId, bytes, contentType })`.
2. `PeerView { config, status, client: EngineClient, lastKnown: {sessions,
   chats, updatedAt} | null }`. The registry follows `settings.peers` and
   `peersEnabled`: adds, rebuilds on config change, disposes on removal.
3. While `connection === 'open'`, when `client.sessions` or `client.chats`
   change, debounce 2 s and `invoke('peer_lists_save', …)` with only `{id,
   title, root, updatedAt}` / `{id, title, updatedAt}`. On creation, load
   `peer_lists_get` into `lastKnown`.
4. `listedSessions(peer)` / `listedChats(peer)`: the live lists when open,
   else `lastKnown` marked `offline: true`.
5. Images: a peer's message images are `haruspex-img:` URLs that mean the
   other computer's cache. `peerImageUrl(peerId, url)` asks
   `peer_images_lookup` for the hash, then `peer_image`, and returns a
   `URL.createObjectURL` blob URL, cached per (peer, hash) in memory and
   revoked when the peer is disposed. Same lookup rule as
   `src/web/images.ts`.
6. The app's lean mode is not consulted; the peer's own `lean` (`app.mode`)
   is: a lean peer exposes chats only (`listedSessions` empty).

## Build gate

- `npm run check && npm run lint && npm run test -- src/lib/peers`

## Test plan

- `transport.test.ts` with mocked `invoke`/`listen`: events for another peer
  are ignored; status maps correctly; errors map to statuses.
- `store.svelte.test.ts`: adding a peer to settings creates a view; removing
  disposes it and unlistens; lists are saved debounced and trimmed to the
  four fields; offline returns `lastKnown` flagged offline; a lean peer
  lists no sessions.
- `images.test.ts`: the second request for one hash doesn't call Rust again.

## Commit

`feat(peers): mirror each trusted computer's sessions and chats in the frontend`

## Rollback

Revert; nothing renders this store until phase 09.
