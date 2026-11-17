# Phase 04 — mDNS advertise and browse

**Depends on:** 01, 03 · **Enables:** 05 (Settings lists found computers)

## Goal

A Haruspex whose Remote control is on and listening on all networks
advertises itself as `_haruspex._tcp.local.`; one with the feature on browses
for others and reports what it finds, skipping itself and deduplicating by
instance id. Uses `mdns-sd`, so no Avahi or Bonjour is needed.

## Files touched

- `src-tauri/Cargo.toml` — add `mdns-sd`.
- `src-tauri/src/peers/mdns.rs` — new: one `ServiceDaemon`, `advertise`,
  `unadvertise`, `browse_start`, `browse_stop`.
- `src-tauri/src/owner/commands.rs` — `owner_api_apply` advertises when the
  server ends up running with `bind_all`, and unadvertises otherwise.
- `src-tauri/src/peers/manager.rs` — `peers_apply` starts or stops browsing
  with `enabled`.
- `src-tauri/src/peers/commands.rs` — `peers_found` (current found list).
- `src/lib/ipc/gen/FoundPeer.ts` — generated.

## Steps

1. One lazily created `ServiceDaemon` shared by advertise and browse, shut
   down when neither is active.
2. Advertise: instance name = identity name (phase 01), deduplicated by
   mdns-sd if two share it; host = `haruspex-<first 8 of id>.local.`, not
   `<name>.local.`, which Avahi or Bonjour may already answer for; port =
   owner API port; addresses from `mdns-sd`'s interface enumeration;
   TXT: `id=<instanceId>`, `v=<CARGO_PKG_VERSION>`, `api=1`. The fingerprint
   is **not** advertised: mDNS is unauthenticated and the owner confirms the
   fingerprint by eye (overview decision).
3. Browse: on `ServiceResolved`, build `FoundPeer { instance_id, name,
   addresses: Vec<String>, port, version }` (loopback and IPv6 link-local
   dropped; a record left with none is ignored, since on one machine it can
   arrive over loopback first), skip it if `instance_id` is ours,
   keep a map by `instance_id` (latest wins), emit `peer://found` with the
   whole list. On `ServiceRemoved`, drop it and emit. A record without `id`
   is ignored.
4. Browsing only while `PeersConfig.enabled`; advertising only while the
   owner API runs with `bind_all`. With both off the daemon is shut down, so
   nothing is sent on 5353 (overview success criterion).
5. Daemon errors (port 5353 unusable, no interfaces) log a warning once and
   leave the feature working for peers added by hand.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy --all-targets -- -D warnings && cargo test peers::`
- Windows CI (`windows-ci` label) and macOS build pass: mdns-sd is
  cross-platform but is a new native-socket dependency.

## Test plan

- Rust unit: TXT parsing → `FoundPeer`; self id skipped; missing id ignored;
  removal drops the entry.
- Rust integration (Linux CI, `#[ignore]` off by default where multicast is
  unavailable): two daemons in one test, one advertising with a test id, the
  other browsing, finds it within 5 s.
- Hand check once, recorded in the phase PR: with the feature off and Remote
  control off, `sudo tcpdump -i any udp port 5353` shows nothing from
  Haruspex.

## Commit

`feat(peers): advertise and find other Haruspex computers over mDNS`

## Rollback

Revert. Advertising stops with the next `owner_api_apply`; no state is kept.
