# Phase 03 — Settings → Cameras (manual add, test, permission, trust)

**Depends on:** 02 · **Enables:** 04 (tools need configured cameras), 05
(discovery plugs into the add flow), 08 (log list and watcher controls live
here)

## Goal

A Settings → Cameras section where the user adds a camera by RTSP URL or by
picking a USB device, tests it (live frame + audio level), sets Ask/Allow,
removes it, and manages which saved remote servers may receive camera data.

## Files touched

- `src/lib/components/settings/categories.ts` — add `'cameras'`.
- `src/lib/components/settings/SettingsPanel.svelte` — `CategoryDef` in the
  Capabilities group (camera icon), import + branch.
- `src/lib/components/settings/CamerasSection.svelte` — new: list, add/edit
  form, test, permission, trusted servers.
- `src/lib/components/settings/CameraForm.svelte` — new: add/edit form.
- `src/lib/components/settings/CamerasSection.test.ts` — new.
- `src/lib/camera/trust.ts` — new: `isTrustableServer(url)` (private/loopback
  /link-local/`.local`/`.internal` hosts only; never OpenRouter) and
  `cameraDataAllowed(descriptor)`.
- `src/lib/camera/trust.test.ts` — new.
- `docs/guide/cameras.md` — new page (add a camera, test, Ask/Allow, trusted
  servers, what it doesn't do); register in `src/lib/guide/guide.ts`.
- `docs/guide/settings.md` — Cameras rows.

## Steps

1. Section layout (`.settings-section` cards, one-sentence copy, tooltips for
   detail): camera list (name, kind, permission badge, Edit/Remove); "Add
   camera" opens `CameraForm`.
2. `CameraForm`: Kind toggle Network / USB. Network: name, RTSP URL,
   username, password (saved with `cameraSecrets`, field shows "saved" after),
   optional substream URL (tooltip: used by the ambient log). If the pasted
   URL carries `user:pass@`, move them into the fields and strip them. USB:
   video device and microphone dropdowns from `camera_usb_devices`, mic
   pre-paired by name, "None" allowed. Permission: Ask (default) / Allow.
   No pan/tilt control in this phase: every camera saves `ptz: 'none'`.
3. Test button: calls `camera_probe` then `camera_snapshot` and shows the
   frame plus resolution/codec, then a 3-second
   `camera_listen(config, 3, transcribe: false)` showing the dB level. The
   probe result is saved into the camera's `caps`. Errors shown inline with the
   ffmpeg reason, password redacted.
4. Trusted servers card: lists `inferenceBackend.remoteServerUrls`; a checkbox
   per URL enabled only when `isTrustableServer(url)`; disabled rows carry a
   tooltip "Only servers on your own network can be trusted". Stores
   `cameraTrustedServers` (normalized URLs).
5. `cameraDataAllowed(descriptor)`: `kind === 'local'` → true;
   `kind === 'openrouter'` → false; `kind === 'remote'` → true only when
   `descriptor.baseUrl` normalized is in `cameraTrustedServers`.
6. Removing a camera deletes its keychain secret (`deleteSecret`).
7. Guide page + settings.md rows.

## Build gate

- `npm run check`, `npm run lint`, `npm run test`
- `node scripts/guide-check.mjs < /dev/null`; guide test (page registered,
  < 6 KB)

## Test plan

- Unit: `isTrustableServer` for 192.168.x, 10.x, 172.16–31.x, 127.x, ::1,
  fd00::/8, `*.local`, `*.internal`, public IPs, public hostnames, OpenRouter.
- Unit: `cameraDataAllowed` across local / openrouter / trusted remote /
  untrusted remote.
- Component: adding a network camera with credentials in the URL strips them
  into fields; removing deletes the secret; settings stay plain JSON
  (`structuredClone` of settings succeeds).
- Manual: add the D1 and a USB webcam, Test shows a frame and a level for
  both.

## Commit

`feat(camera): add Settings → Cameras with test, permission and trusted servers`

## Rollback

Revert: removes the section and guide page; stored `cameras` settings remain
and are ignored. Safe to leave partially applied (no tools read it yet).
