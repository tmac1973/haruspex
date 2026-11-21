# Phase 05 — Room references and room checks

**Depends on:** 01, 02, 03, 04 · **Enables:** 06 (room-check entries reach the
digest)

## Goal

Each Alerts-on camera keeps a day and a night reference picture of the room,
set with **This is normal**. About a minute after an event closes, and hourly
otherwise, Haruspex takes a picture at the camera's home view and compares it
with the reference for the current light:

- A cheap greyscale correlation decides whether the model needs to look at all.
- If it does, the vision model compares the two pictures and says what moved,
  is missing or is new, along with smoke or fire.
- A changed room is logged as a `"room"` camera event and judged like any
  other, so an Urgent one is emailed by Phase 04.
- A normal check with nobody in view replaces the reference, so slow changes
  don't keep alerting.

## Files touched

- `src-tauri/src/camera/reference.rs` (new):
  - storing references (`<app data>/camera_refs/<camera_id>/{day,night}.jpg`)
  - night detection
  - `room_fingerprint` (a 64×36 greyscale from a JPEG, with the `image` crate)
  - `room_similarity` (the correlation from `capture::same_view`, returning the
    score)
- `src-tauri/src/camera/capture.rs`: split `same_view` into a `correlation`
  that returns the score, and the existing boolean wrapper.
- `src-tauri/src/camera/aim.rs`:
  - The aim function takes a `record: bool`. When true, it records
    `last_aimed_at` per camera (epoch ms).
  - The `camera_aim` command passes true.
  - The room check's internal aim passes false.
  - Add a `last_aimed_at(camera_id)` accessor.
- `src-tauri/src/camera/commands.rs`: `camera_reference_set`,
  `camera_reference_get`, `camera_room_shot`, `camera_room_event_add`.
  Registered in `lib.rs`.
- `src-tauri/src/db/camera_events.rs`: new `insert_room_event(camera_id, at,
thumb_jpeg, caption, level, reason)`. It writes the thumbnail where the
  watcher's thumbnails go and inserts a row with trigger `"room"`, judgement
  already set.
- `src/lib/camera/roomCheck.ts` (new) and `roomCheck.test.ts`: the scheduler
  and the comparison call.
- `src/lib/camera/judge.ts`: `roomJudgeMessages` (two pictures).
- `src/lib/camera/captioner.ts`: start the room scheduler with the captioner.
- `src/lib/components/settings/CameraForm.svelte`: **This is normal** and the
  reference thumbnails in the Alerts block.
- `docs/guide/camera-alerts.md`: references and room checks.

## Steps

1. **Night detection**: `is_night(jpeg)` decodes the picture with `image`,
   samples a 64×36 grid and returns true when the mean of `|R−G| + |G−B|` is
   under 4.0. Thingino's infrared night mode is greyscale.
2. **References**:
   - `camera_reference_set(camera_id, jpeg_data_url)` writes `night.jpg` when
     `is_night`, else `day.jpg`, and returns which one it wrote.
   - `camera_reference_get(camera_id)` returns both, or null.
   - Removing a camera deletes its folder, in the existing camera-removal path.
3. **The room shot**: `camera_room_shot(config, overrides)`:
   - If the camera has pan/tilt and its last aim by a user or chat was under
     300 s ago, return `Busy`, so a camera someone is aiming is never moved.
   - Otherwise, if it has pan/tilt, aim Home (Haruspex's home) and wait as
     `camera_aim` already does. This internal aim passes `record: false`, so
     it doesn't update `last_aimed_at` and a room check never makes the next
     one Busy.
   - Take a snapshot at 1280 px.
   - Return `{ jpeg, night, similarity }`, where similarity is against the
     matching reference, or null when there's none.

   Pan/tilt moves made here don't log motion, because the watcher already
   ignores the camera's own turning.

4. **Scheduler** (`roomCheck.ts`). Per Alerts-on camera with at least one
   reference:
   - After a non-`room` event is judged, schedule a check 60 s after its
     `ended_at`. A later event pushes the check back, so checks run once the
     room has settled.
   - Otherwise run a check hourly, measured from the last check.
   - Only one check runs per camera at a time.
   - `Busy`: retry 5 minutes later. If it's still Busy, drop it and leave the
     next hourly check as it was.
   - Skip while the watcher's Active hours exclude now, or the camera isn't
     Allow.
5. **Gate**:
   - `similarity >= 0.995` and the reference is under 24 h old: nothing is
     logged and there's no model call.
   - `similarity >= 0.995` and the reference is 24 h old or more: go on to the
     model anyway, so the refresh in step 7 only happens once the model has
     seen nobody in view.
   - No reference for this light: save the shot as that reference (first
     night), and log nothing.
   - `similarity < 0.995`: go on to the model.
6. **Comparison**:
   - `roomJudgeMessages` sends the reference, then the current picture, with
     the camera's note and watch rules. It also sends the reasons of any
     Urgent events on this camera in the last 30 minutes, read with
     `camera_events_list`. It asks for JSON
     `{"people": number, "changes": string[], "level": ..., "reason": string, "rule": number|null}`.
   - The instructions:
     - Light, shadows, screens and pets don't count.
     - Large furniture moved, a large object missing or a new large object is
       Unusual.
     - Smoke, flames or fire glow is Urgent.
     - Missing valuables right after an Urgent event within the last 30
       minutes is Urgent.
     - Watch rules apply as in Phase 03.
   - It runs at `prompt` priority through `withInferenceSlot` and `cameraDataAllowed`.
7. **Outcome**:
   - `level == normal`, `people == 0` and no changes: replace the reference
     and log nothing.
   - `normal` with people in view: log nothing and keep the reference.
   - Otherwise `roomCheck.ts` calls `camera_room_event_add`, which wraps
     `insert_room_event` with caption "Room check: <changes joined>" and the
     judgement, and returns the new `CameraEvent`. `roomCheck.ts` then calls
     `onJudged` with it, and Phase 04 emails it when it's Urgent.
8. **This is normal** in the camera form takes a snapshot (going home first
   for pan/tilt). It ignores Busy, since the user asked for it, and its aim
   records `last_aimed_at` like any user aim. It then calls
   `camera_reference_set`, and shows the day and night
   reference thumbnails with their dates, and a **Clear** for each.
9. Guide: references, when checks run, and that small objects and other views
   of a pan/tilt camera aren't covered.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test camera`
- `./scripts/export-ipc-types.sh` with no drift
- `npm run check && npm run lint && npm run test -- camera`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- Rust:
  - `is_night` on a greyscale JPEG and a colour JPEG.
  - `correlation` of identical, brightness-shifted and different pictures.
  - `camera_room_shot` returns `Busy` within 300 s of an aim (with a faked
    clock).
  - Reference files are written to the right name.
- TS (`roomCheck.test.ts`, fake timers):
  - An event schedules a check at `ended_at + 60 s`, and a second event
    pushes it back.
  - The hourly timer runs.
  - Similarity ≥ 0.995 with a reference under 24 h old gives no model call.
    With a reference 24 h old or more, it does call the model.
  - A normal, empty check replaces the reference; an Unusual one logs a `room`
    event and calls `onJudged`.
- Driven on the D1:
  - Set day and night references.
  - Move a chair and leave: within about 2 minutes, an Unusual room entry
    names the chair.
  - Take a large object off a shelf after a drawer-search Urgent: an Urgent
    room entry and an email.
  - Turn the camera through chat, then wait: no room check moves it for 5
    minutes.
  - Log the D1's similarity score for every hourly check through a day with
    nothing moved. If more than half of them reach the model, set the
    threshold to the lowest score from that day, rounded down to 3 decimals,
    and note it in `reference.rs`.

## Commit

`feat(camera): room references and room checks against them`

## Rollback

Revert the commit. Reference files under `camera_refs/` are left behind and are
harmless. `room` events already logged stay in the log as ordinary entries.
