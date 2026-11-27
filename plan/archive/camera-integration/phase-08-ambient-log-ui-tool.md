# Phase 08 — Ambient log: captions, camera_log tool, watcher UI

**Depends on:** 02, 03, 04, 07 · **Enables:** 09 (Camera digest job)

## Goal

Turn watcher events into a usable log: caption each event's frame with the
local model (queued behind chat), let the model search the log with
`camera_log`, and give the user watcher controls and a recent-entries list
in Settings → Cameras.

## Files touched

- `src/lib/camera/captioner.svelte.ts` — new: listens for `camera://event`,
  captions pending events.
- `src/lib/camera/captioner.test.ts` — new.
- `src-tauri/src/camera/commands.rs` — `camera_event_set_caption`,
  `camera_events_pending`.
- `src/lib/agent/tools/camera.ts` — register `camera_log`.
- `src/lib/agent/tools/camera.test.ts` — cases.
- `src/lib/components/settings/CameraForm.svelte` — Ambient log toggle, active
  hours, motion sensitivity, sound threshold.
- `src/lib/components/settings/CamerasSection.svelte` — retention days, recent
  entries list (thumbnail, time, transcript, caption) with delete and
  "Clear all".
- `src/lib/stores/cameraActivity.svelte.ts` / `CameraIndicator.svelte` —
  include running watchers.
- `src/routes/+layout.svelte` — start the captioner and push configs to
  `camera_watch_set` on load and on settings change.
- `docs/guide/cameras.md` — ambient log section; `docs/guide/settings.md`.

## Steps

1. Captioner: on `camera://event` and at startup (`camera_events_pending`),
   for each pending event: if `!cameraDataAllowed(resolveBackendDescriptor())`
   leave it pending; otherwise run one completion inside
   `withInferenceSlot` (`src/lib/agent/inferenceQueue.svelte.ts`) so it waits
   behind chat turns, sending the thumbnail with the prompt "Describe what is
   happening in this camera frame in one sentence. Mention people, animals and
   anything that changed. Don't guess identities." and the transcript as
   context; max 80 tokens, no tools, thinking off. Save with
   `camera_event_set_caption` (`done`). If the model has no vision, mark
   `skipped`. One at a time; pending events older than the retention window
   are purged by phase 07.
2. `camera_log({camera?, query?, since?, until?, limit = 20})` — backed by
   `camera_events_search` when `query` is set and `camera_events_list`
   otherwise: same gate as
   phase 04 for the named camera (or every camera the gate allows when
   omitted; Ask cameras prompt once per call via
   `askCameraUse({cameras, action: 'read_log'})`; jobs see Allow
   cameras only). `since`/`until` accept ISO times or "today", "yesterday",
   "last N hours". Returns entries newest first: time (local), camera,
   trigger, transcript, caption (or "caption pending"). No images.
3. Form controls: Ambient log switch (`.toggle-row`), active hours (two time
   inputs, empty = always), motion sensitivity select, sound threshold
   slider; saving calls `camera_watch_set`.
4. Section: retention days (1–90, default 7); each camera row in the list
   gets an "Activity" expander showing its latest 50 entries (thumbnail via
   `camera_event_thumb`), delete per entry, and "Clear all" (that camera)
   with a confirm.
5. `cameraActivity` subscribes to `camera://watchers` (seeded from
   `camera_watch_status` at startup) and the indicator shows a distinct
   "watching" state per running watcher.
6. Guide: turning on the ambient log, what is stored (text + one frame, no
   clips), retention, it only runs while Haruspex is open, captions wait for
   chat to finish.

## Build gate

- `npm run check`, `npm run lint`, `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- Unit: captioner leaves events pending on an untrusted backend, captions on
  local, marks skipped without vision, processes one at a time, and waits on
  `withInferenceSlot`.
- Unit: `camera_log` time parsing, filters, gate behaviour (job + Ask camera
  excluded), output shape.
- Manual: watcher on the D1; during a long chat turn walk in and talk — the
  chat isn't slowed and the caption appears after the turn; "did anyone come
  by in the last hour?" answers from the log; deleting an entry removes its
  thumbnail; retention 1 day purges older entries.

## Commit

`feat(camera): caption ambient events and let the assistant search the camera log`

## Rollback

Revert: watcher keeps writing uncaptioned rows (phase 07) but the UI to turn
it on disappears, so stop watchers first (`camera_watch_set` with all
disabled) or revert 07 as well.
