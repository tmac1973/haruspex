# Phase 07 — Ambient watcher backend: detection, events, storage

**Depends on:** 02 · **Enables:** 08 (captioning, `camera_log`, UI)

## Goal

A Rust watcher per camera that detects motion or speech from the camera's
low-res stream, records the event, transcribes it, stores a transcript and
thumbnail in SQLite, and enforces retention — all without the model. Captions
are added in phase 08.

## Files touched

- `src-tauri/src/db/mod.rs` — migration: `camera_events` table +
  `camera_events_fts` (FTS5, external content) + triggers.
- `src-tauri/src/db/camera_events.rs` — new: insert, set caption, list,
  search, delete, purge-older-than.
- `src-tauri/src/camera/watcher.rs` — new: per-camera task.
- `src-tauri/src/camera/detect.rs` — new: parse ffmpeg metadata lines.
- `src-tauri/src/camera/capture.rs` — read a running USB watcher's shared
  files instead of opening the device.
- `src-tauri/src/camera/commands.rs` — `camera_watch_set`,
  `camera_watch_status`, `camera_events_list({camera_id?, since?, until?,
  limit})`, `camera_events_search({query, camera_id?, since?, until?,
  limit})`, `camera_event_thumb(id) -> data:image/jpeg;base64`,
  `camera_event_delete(id)`, `camera_events_clear(camera_id?)`. Lists return
  rows without thumbnails; the UI fetches each via `camera_event_thumb` (no
  asset-protocol scope needed).
- `src-tauri/src/lib.rs` — manage `WatcherRegistry` state; stop all watchers
  at exit next to the whisper stops.
- `src/lib/ipc/gen/*` — regenerated.

## Steps

1. Schema: `camera_events(id INTEGER PK, camera_id TEXT, started_at INTEGER
   (epoch ms), ended_at INTEGER, trigger TEXT ('motion'|'sound'|'both'),
   level_db REAL, transcript TEXT, caption TEXT NULL, caption_status TEXT
   ('pending'|'done'|'skipped'), thumb_path TEXT)`; index on
   `(camera_id, started_at)`; FTS5 over `transcript, caption`.
2. Watcher input: one ffmpeg on `substream_url` (fallback main; USB devices at
   640 px) with `-vf fps=2,scale=320:-2,select='gt(scene,T)',metadata=print:file=-`
   and `-af astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`
   writing metadata to stdout; T = 0.08 / 0.04 / 0.02 for low / medium / high
   sensitivity; sound trigger when RMS ≥ `sound_threshold_db` for ≥ 0.5 s.
   The process restarts with backoff (2 s → 60 s) on exit; status reports the
   last error.
3. USB cameras can't be opened twice, so a USB watcher's single ffmpeg also
   writes 2-second WAV segments and a full-res `latest.jpg` (overwritten each
   second) into `<app data>/camera_watch/<camera_id>/`, and while it runs
   `capture::snapshot` / `record_audio` for that camera read from those files
   instead of opening the device. RTSP cameras need none of this.
4. On trigger: if no event is open, open one; for RTSP start a second ffmpeg
   on the main stream that records audio to a temp WAV and grabs one full-res
   JPEG 1 s in; keep the event open while triggers continue, close after 10 s
   quiet or at 60 s max (USB: concatenate the segments and copy
   `latest.jpg`). Cooldown 30 s between events per camera.
5. On close: transcribe the WAV holding a `WhisperLease`, delete the WAV,
   insert the row (`caption_status = 'pending'`, `thumb_path` empty), write
   the thumbnail (resized to 640 px) to
   `<app data>/camera_events/<camera_id>/<id>.jpg`, set `thumb_path`, emit
   `camera://event` with the id.
6. Schedule: a 30 s tick in the registry starts/stops each watcher by
   `enabled` and `active_hours` (local time, wrap past midnight). Watchers run
   only while the app is open. Every start/stop emits `camera://watchers`
   with the running camera ids; `camera_watch_status` returns the same list
   plus each watcher's last error.
7. Retention: on every `camera_watch_set` call and hourly after the first,
   delete rows and thumbnails older than the `retention_days` it was given.
8. Commands take the camera configs from the frontend (as video commands do);
   `camera_watch_set(configs, retention_days)` reconciles running watchers.

## Build gate

- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `npm run check`, `npm run lint`, `npm run test`
- `./scripts/export-ipc-types.sh` leaves no diff

## Test plan

- Unit: with a USB watcher running, snapshot/listen read the shared files.
- Unit: metadata line parsing; trigger/open/extend/close/cooldown state
  machine driven by synthetic lines; active-hours wrap; retention purge
  removes files and rows; FTS search finds transcript words.
- Integration (skipped without ffmpeg): the watcher's input builder takes an
  `Input` enum whose `#[cfg(test)] Lavfi(String)` variant feeds a lavfi source that switches scenes
  and plays a tone produces exactly one event with a thumbnail.
- Manual (dev console `invoke('camera_watch_set', …)`, since the UI arrives
  in phase 08): watcher on the D1 — walk past and talk → one row with transcript;
  10 min of an empty quiet room → no rows.

## Commit

`feat(camera): watch cameras for motion and speech and log transcribed events`

## Rollback

Revert: the migration's tables stay in existing databases but nothing reads
them; delete `camera_events/` to reclaim space. No user-visible UI exists yet,
so a partial rollout is invisible.
