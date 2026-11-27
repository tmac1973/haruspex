# Phase 02 — Alert settings and event columns

**Depends on:** nothing · **Enables:** Phases 03–06

## Goal

Add the data the rest of the work reads and writes:

- per-camera alert settings
- the global alert email settings
- columns on `camera_events` for a judgement and a dismissal
- a `"room"` trigger value
- a query that counts events per hour for learning quiet hours

There's no behaviour change yet. Nothing judges, and Settings shows nothing new.

## Files touched

- `src-tauri/src/camera/mod.rs`: new `AlertConfig` struct; `alerts: AlertConfig`
  on `CameraConfig` (`#[serde(default)]`).
- `src-tauri/src/db/mod.rs`: `ALTER TABLE camera_events ADD COLUMN` for
  `alert_level`, `alert_reason`, `dismissed_at`, `dismiss_note`, in the
  existing column list.
- `src-tauri/src/db/camera_events.rs`: the fields on `CameraEvent`; `COLS`;
  `set_camera_event_judgement`, `dismiss_camera_event`, `camera_event_hour_counts`;
  the `trigger` doc comment adds `"room"`. Phase 05 adds the insert that uses
  it.
- `src-tauri/src/camera/commands.rs`: `camera_event_set_judgement`,
  `camera_event_dismiss`, `camera_event_hour_counts` commands; register them in
  `src-tauri/src/lib.rs`.
- `src/lib/stores/settings.ts`: a `cameraAlerts` blob with a getter and a setter.
- `src/lib/ipc/gen/*`: regenerated (`AlertConfig`, `CameraEvent`,
  `HourCounts`).

## Steps

1. Add `AlertConfig` (ts-rs exported, `#[serde(default)]` on every field):
   - `enabled: bool`, default false
   - `usual_people: u32`, default 1
   - `watch_rules: Vec<String>`. Each rule is at most 300 characters and there
     are at most 20; both limits are enforced in the setter in step 7 and in
     the form in Phase 03.
   - `quiet_hours: Option<QuietHours>`, where `QuietHours { weekday: [bool; 24], weekend: [bool; 24] }`.
     `None` means "use the learned hours"; `Some` is the user's override.
2. Add `pub alerts: AlertConfig` to `CameraConfig` with `#[serde(default)]`, so
   existing settings load unchanged.
3. Migration: add these columns to the `ALTER TABLE` list in
   `Database::migrate()`, each with a comment:
   - `alert_level TEXT NULL`: `normal`, `unusual` or `urgent`; NULL until judged
   - `alert_reason TEXT NOT NULL DEFAULT ''`
   - `dismissed_at INTEGER NULL`: epoch ms
   - `dismiss_note TEXT NOT NULL DEFAULT ''`

   Extend the FTS update trigger so `alert_reason` is searchable: rebuild
   `camera_events_fts` over `(transcript, caption, alert_reason)` with a
   one-off `fill_camera_events_fts` in the same style as `fill_messages_fts`.

4. `CameraEvent` gets `alert_level: Option<String>`, `alert_reason: String`,
   `dismissed_at: Option<i64>` and `dismiss_note: String`. Add them to `COLS`.
5. New DB functions:
   - `set_camera_event_judgement(id, caption: Option<String>, level, reason)`
     sets caption, `caption_status` (`done`/`skipped`), level and reason in one
     update.
   - `dismiss_camera_event(id, note)` sets `dismissed_at = now` and the note.
   - `camera_event_hour_counts(camera_id, since)` returns
     `HourCounts { weekday: [u32; 24], weekend: [u32; 24], days_weekday: u32, days_weekend: u32 }`
     in local time. It counts only events with trigger other than `"room"`. The
     day counts are how many distinct weekday and weekend dates in the range
     have any event, so Phase 03 can turn the counts into a rate.
6. Commands wrap the three functions. The `trigger` doc comment on
   `CameraEvent` lists `"room"`.
7. `settings.ts`:
   - Add `cameraAlerts: { enabled: false, accountId: '', to: [] }` with a
     getter `getCameraAlerts()` and a setter `setCameraAlerts()`. The setter
     snapshots its input, and keeps only addresses that match a simple
     `local@domain` check, at most 5.
   - Clamp the `watch_rules` limits in `setCameras`.
8. Run `./scripts/export-ipc-types.sh`.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test camera db`
- `npm run check && npm run lint && npm run test -- settings camera`

## Test plan

- Rust:
  - The migration on a database made before this phase adds the columns, and
    old rows read with `alert_level = None`.
  - FTS finds a word that's only in `alert_reason`.
  - `camera_event_hour_counts` buckets events by local hour and weekday or
    weekend, and skips `"room"` events.
  - `CameraConfig` JSON without `alerts` deserialises to the defaults.
- TS: `setCameraAlerts` drops invalid addresses and caps the list at 5.

## Commit

`feat(camera): alert settings and judgement columns for camera events`

## Rollback

Revert the commit. The new columns stay in users' databases, which is harmless:
old code doesn't read them, and the migration ignores duplicate columns if the
phase is applied again.
