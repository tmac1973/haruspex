# Phase 05 — ONVIF client: discovery, stream lookup, PTZ calls

**Depends on:** 02, 03 · **Enables:** 06 (`camera_look` on network cameras)

## Goal

A small hand-rolled ONVIF client so network cameras can be found on the LAN,
their main/sub stream URLs filled in automatically, and their pan/tilt driven.
The Add flow in Settings → Cameras gains a discovered-camera picker.

## Files touched

- `src-tauri/src/camera/onvif/mod.rs` — new: client struct, errors.
- `src-tauri/src/camera/onvif/discovery.rs` — new: WS-Discovery probe.
- `src-tauri/src/camera/onvif/soap.rs` — new: envelope building, WS-Security
  UsernameToken digest, response parsing with `quick-xml`.
- `src-tauri/src/camera/onvif/ptz.rs` — new: PTZ calls.
- `src-tauri/src/camera/onvif/fixtures/*.xml` — recorded responses
  (Thingino + one generic ONVIF Profile S sample).
- `src-tauri/src/camera/commands.rs` — `camera_onvif_discover`,
  `camera_onvif_connect`, `camera_onvif_presets`.
- `src-tauri/src/lib.rs` — register the three commands.
- `src/lib/ipc/gen/*` — regenerated.
- `src/lib/components/settings/CameraForm.svelte` — "Find cameras" list and
  the Pan/tilt ONVIF option.
- `docs/guide/settings.md` — the Pan/tilt (ONVIF) option.
- `docs/guide/cameras.md` — finding cameras on the network.

## Steps

1. Discovery: send a WS-Discovery `Probe` for
   `dn:NetworkVideoTransmitter` to `239.255.255.250:3702` from every IPv4
   interface that isn't loopback (respecting that the proxy config never
   applies to loopback/LAN), collect `ProbeMatch` XAddrs for 3 s, dedupe by
   endpoint UUID. Return `{xaddr, name (from scopes), hardware}`.
2. SOAP over `reqwest` (no proxy, 5 s timeout, `danger_accept_invalid_certs`
   only for https XAddrs on private addresses), WS-Security digest
   (nonce, created, SHA-1 per spec), falling back to HTTP digest auth on 401.
3. `connect(xaddr, user, pass)`: `GetCapabilities` → media + PTZ service
   URLs; `GetProfiles` → main is the highest-resolution profile (H.264
   preferred, else any codec ffmpeg decodes), sub is the lowest-resolution
   one; with a single profile, main and sub are the same URL; `GetStreamUri` (RTP-Unicast, RTSP) for both;
   `GetPresets` on the main profile if PTZ exists. Returns `{main_url,
   sub_url, profile_token, has_ptz, presets}`. Credentials are stripped from
   returned URLs.
4. PTZ (pan/tilt only; zoom is out of scope): `continuous_move(pan, tilt)` with normalized velocities, `stop`,
   `goto_preset(token)`, `goto_home`, `get_status` (position if reported).
   A "move by" helper runs continuous_move for a duration then stop.
5. Commands: `camera_onvif_discover()`, `camera_onvif_connect({xaddr,
   username, password})` and `camera_onvif_presets(config)` (re-reads
   `GetPresets` using the camera's saved credentials); the PTZ calls are internal (used by phase 06).
6. Form: "Find cameras" runs discovery and lists results; picking one asks for
   username/password, runs `connect`, and fills name, RTSP URL, substream URL,
   `onvif` endpoint (with `presets`) and `ptz: 'onvif'`
   when supported. A "Refresh presets" button calls `camera_onvif_presets`. Manual URL entry stays.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `npm run check`, `npm run lint`, `npm run test`
- `./scripts/export-ipc-types.sh` leaves no diff
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- Unit: envelope + digest against a known nonce/created/password vector;
  parsing of every fixture; profile selection; credential stripping.
- Unit: discovery response parsing and dedupe from fixture packets.
- Manual: "Find cameras" lists the D1; connecting fills main
  (`/ch0`) and sub (`/ch1`) URLs and enables ONVIF pan/tilt; a debug
  `continuous_move` turns the camera.

## Commit

`feat(camera): discover ONVIF cameras and read their streams and pan/tilt`

## Rollback

Revert: the form loses discovery; manually added cameras are unaffected.
Cameras saved with `ptz: 'onvif'` keep the field but nothing uses it.
