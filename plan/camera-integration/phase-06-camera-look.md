# Phase 06 — UVC pan/tilt and the camera_look tool

**Depends on:** 02, 03, 04, 05 · **Enables:** nothing further required; completes the
on-demand feature set

## Goal

One `camera_look` tool that aims any pan/tilt camera — ONVIF network cameras
(phase 05) and UVC USB webcams on Linux — and returns a fresh frame so the
model sees where it now points.

## Files touched

- `src-tauri/src/camera/uvc.rs` — new (Linux only, `cfg(target_os = "linux")`):
  read ranges and set `V4L2_CID_PAN_ABSOLUTE` and `V4L2_CID_TILT_ABSOLUTE`
  (no zoom).
- `src-tauri/src/camera/aim.rs` — new: `Aim` request and dispatch to ONVIF or
  UVC.
- `src-tauri/src/camera/commands.rs` — `camera_aim`, `camera_uvc_supported`.
- `src-tauri/src/lib.rs` — register the two commands.
- `src/lib/ipc/gen/*` — regenerated.
- `src/lib/agent/tools/camera.ts` — register `camera_look`.
- `src/lib/agent/tools/camera.test.ts` — cases.
- `src/lib/components/settings/CameraForm.svelte` — USB: "Pan/tilt (UVC)"
  option on Linux when `camera_uvc_supported(device)`; Test gains
  left/right/up/down/home buttons for any aimable camera.
- `docs/guide/cameras.md` — aiming a camera; USB pan/tilt is Linux-only.
- `docs/guide/settings.md` — the Pan/tilt (UVC) option.

## Steps

1. `Aim` = `{ direction: 'left'|'right'|'up'|'down'|'home', amount:
   'small'|'medium'|'large' }` or `{ preset: string }`. Amounts map to 10°,
   30°, 60° of pan / 10°, 20°, 40° of tilt.
2. ONVIF: direction → `continuous_move` at velocity 0.5 for 0.4 s (small),
   1.2 s (medium) or 2.4 s (large), then `stop` (durations are constants in
   `aim.rs`, checked against the D1 in the test plan); `home` → `goto_home`, falling back to
   preset named "home" (case-insensitive) when the camera has no home;
   `preset` → `goto_preset` by name. Wait 1.5 s after motion stops.
3. UVC: read control ranges (units are arc-seconds per UVC spec, e.g. ±468000
   on OBSBOT), clamp, set absolute = current + delta (track the last value we
   set per device in memory because some kernels return stale readbacks);
   `home` → 0/0. Wait 1 s. Non-Linux USB: `can_aim` is false.
4. `camera_look({camera, direction?, amount = 'medium', preset?})`;
   exactly one of `direction` / `preset` is required, otherwise it refuses
   "Give a direction or a preset." It applies same gate as
   phase 04 (Ask prompts with action "move"); refuses "This camera can't
   move" when `ptz === 'none'`; calls `camera_aim`, then `camera_snapshot`,
   pushes the image (needs vision; without vision it still moves and says so).
   `camera_list` reports presets for ONVIF cameras.
5. Activity indicator wraps the move + snapshot.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
  (Linux and non-Linux builds compile; CI runs all three platforms)
- `npm run check`, `npm run lint`, `npm run test`
- `./scripts/export-ipc-types.sh` leaves no diff
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- Unit: amount → degrees → ONVIF duration / UVC arc-seconds, with clamping.
- Unit: `camera_look` refusals (no PTZ, Ask in job, untrusted backend) and the
  happy path pushes one image.
- Manual: on the D1, small/medium/large left turns move roughly 10°/30°/60°;
  if not, adjust the three constants in the same PR.
- Manual: "look left" turns the D1 and the returned frame shows the new view;
  "go home" recenters. On Linux with an OBSBOT Tiny: left/up/home work and
  the frame follows.

## Commit

`feat(camera): aim pan/tilt cameras over ONVIF and UVC with camera_look`

## Rollback

Revert: removes `camera_look` and the UVC code; snapshot and
listen keep working.
