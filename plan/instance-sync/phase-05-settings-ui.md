# Phase 05 — Settings → Remote control → Other computers

**Depends on:** 02, 03, 04 · **Enables:** 07 (trusted peers to show), 13
(un-hiding the switch)

## Goal

The owner can turn the feature on, see computers found on the network, add
one by name or address, confirm its certificate fingerprint, paste a token
when the other computer requires one, and remove a computer. The section is
hidden behind a build flag until phase 13, so main never shows a half
feature.

## Files touched

- `src/lib/peers/flag.ts` — new: `export const PEERS_READY =
  import.meta.env.DEV || import.meta.env.VITE_HARUSPEX_E2E === '1';` It
  reads the env flag directly and imports nothing from `src/lib/e2e`, per
  `src/lib/buildFlags.ts`, so no e2e chunk reaches a production build.
- `src/lib/stores/settings.ts` — `peersEnabled: boolean` (default `false`),
  `peers: PeerConfig[]` (default `[]`), `refusedPeers: string[]` (instance
  ids, default `[]`), with comments; setters snapshot plain objects.
- `src/lib/peers/service.ts` — new: `applyPeers()`, `syncPeers()` (startup,
  never rejects), `probePeer`, `trustPeer`, `refusePeer`, `removePeer`,
  `setPeerToken`, listeners for `peer://found` and `peer://status`.
- `src/lib/components/settings/OwnerApiSection.svelte` (Settings → Remote
  control; `RemoteSection.svelte` is Guest chat) — add the "Other
  computers" subsection when `PEERS_READY`.
- `src/lib/components/settings/PeerTrustDialog.svelte` — new: fingerprint
  confirmation (first contact and changed certificate).
- `src/lib/components/settings/PeerTokenDialog.svelte` — new: paste a token.
- `src/routes/+layout.svelte` — call `syncPeers()` in the main window after
  `syncOwnerApi()`.
- Tests beside each new file.

## Steps

1. `applyPeers()` builds `PeersConfig { enabled: peersEnabled && PEERS_READY,
   peers }` and calls `invoke('peers_apply', { config })`. It runs on startup
   and after every change below.
2. Subsection layout (CLAUDE.md copy rules, details in `title` tooltips):
   - Toggle row **Show my other computers here** (`.toggle-row`).
   - **Found on your network**: each `FoundPeer` not already in `peers` and
     not in `refusedPeers`, as "desk-pc · v0.9.1" with **Connect…**.
   - **Your computers**: each `peers` entry with its status from
     `peer://status`: Connected / Connecting / Offline / "Not letting this
     computer in" (with **Use a token…**) / "Certificate changed" (with
     **Check again…**, whose `title` says a computer replaces its
     certificate near expiry and when its names change), and **Remove**.
     "Not letting this computer in" has the `title` "On <name>: Settings →
     Remote control → Who can connect → add this computer under These
     computers, or use a token. My whole network doesn't cover tailnet
     addresses."
   - **Add a computer…**: name or address, and port (default 8788).
3. Connect… / Add a computer… → `invoke('peer_probe', {address, port})`. For
   a found peer, the first of its addresses that probes successfully is used
   and saved as `address`. A probe whose `instanceId` is ours says "That's
   this computer". One whose `instanceId` is already in `peers` updates that
   entry's address instead of adding a second.
4. `PeerTrustDialog`: shows the name and the fingerprint grouped in fours,
   and the one sentence "Check it matches Settings → Remote control →
   Advanced → Certificate on <name>." Buttons **Trust** and **Don't trust**.
   Trust adds `{instanceId, name, address, port, fingerprint, auth:
   'trusted'}` to `peers` and removes the id from `refusedPeers`. Don't trust
   adds the id to `refusedPeers` (never offered again in Found; adding it by
   hand probes and asks again, which is "re-added" in the overview).
5. Changed certificate: **Check again…** probes; the dialog shows the pinned
   and the new fingerprint, both labelled. Trust replaces the pin. Don't
   trust leaves the peer pinned to the old one (it stays "Certificate
   changed", never contacted).
6. `PeerTokenDialog`: one field, "Paste a script token from <name>'s
   Settings → Remote control → Add a device… → Token for a script."; saves
   with `secret_set('peer:<instanceId>', token)` and switches `auth` to
   `'token'`. Remove clears it with `secret_delete`.
7. PRs for phases 05–12 change nothing a release build shows (the flag is
   off there), so they take the `no-docs` label; phase 13 writes the guide.

## Build gate

- `npm run check && npm run lint && npm run test -- src/lib/peers src/lib/components/settings`
- `npm run format:check`

## Test plan

- `service.test.ts`: `applyPeers` sends `enabled: false` when
  `PEERS_READY` is false; trust adds a plain object (structuredClone of the
  settings blob succeeds); refuse records the id; a probe of our own id is
  rejected; a probe of a known id updates its address.
- `OwnerApiSection` component test (flag on): found list filters known and
  refused peers; statuses render the right action; the subsection is absent
  with the flag off.
- `PeerTrustDialog.test.ts`: changed-certificate mode shows both
  fingerprints.

## Commit

`feat(peers): add Other computers to Settings → Remote control, behind a build flag`

## Rollback

Revert. Settings keep `peersEnabled`, `peers`, `refusedPeers` keys, which
unknown-key handling ignores; with the flag gone nothing reads them.
