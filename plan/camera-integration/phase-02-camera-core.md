# Phase 02 — Camera core: config, secrets, snapshot and listen

**Depends on:** 01 · **Enables:** 03 (settings UI), 04 (chat tools), 05
(ONVIF), 07 (watcher)

## Goal

A Rust `camera` module that, given a configured camera, can probe it, grab a
JPEG frame, and record and transcribe a short audio clip — for RTSP cameras
and USB webcams on all three platforms. Plus the settings shape that stores
cameras. No UI and no model tools yet; everything is reachable through Tauri
commands and tested.

## Files touched

- `src-tauri/src/camera/mod.rs` — new module; `CameraConfig`, `CameraSource`,
  shared helpers; registered in `src-tauri/src/lib.rs`.
- `src-tauri/src/camera/capture.rs` — new: `snapshot`, `record_audio`,
  `probe`.
- `src-tauri/src/camera/usb.rs` — new: USB video/audio device enumeration per
  platform.
- `src-tauri/src/camera/commands.rs` — new Tauri commands.
- `src-tauri/src/video/transcribe.rs` — replace the bare idle stop with a
  lease: `pub(crate) async fn lease_server(model) -> WhisperLease` starts the
  video whisper (8768) if needed and counts users; dropping the last lease
  schedules the existing 300 s idle stop (the generation counter stays), so
  camera and video transcription never stop the server under each other.
  `video_transcribe` moves to the lease too; `WhisperServer::transcribe` in `whisper.rs` is already
  public.
- `src-tauri/Cargo.toml` — `v4l` under the Linux target dependencies.
- `src-tauri/src/lib.rs` — register commands.
- `src/lib/stores/settings.ts` — `cameras`, `cameraTrustedServers`,
  `cameraEventRetentionDays` fields, defaults, `load()` merge, setters.
- `src/lib/stores/cameraSecrets.ts` — new: `accountSecrets('camera', …)`.
- `src/lib/ipc/gen/*` — regenerated.

## Steps

1. Types (ts-rs exported):
   - `CameraConfig { id, name, source: CameraSource, permission: 'ask' |
     'allow', ptz: 'none' | 'onvif' | 'uvc', onvif: Option<OnvifEndpoint>,
     watcher: WatcherConfig }`.
   - `CameraSource::Rtsp { url (no credentials), substream_url: Option,
     username, password_ref }` and `CameraSource::Usb { video_device,
     audio_device: Option }`. Credentials are injected into the URL at spawn
     time from `secrets::require(password_ref, "camera")` and never logged:
     every error string and log line built from a URL or ffmpeg stderr goes
     through `text_util::redact_secrets(text, &[password])`.
   - `OnvifEndpoint { xaddr, profile_token, presets: Vec<{token, name}> }`
     (filled in phase 05). ONVIF calls reuse the source's `username` and
     `password_ref`.
   - `CameraCaps { has_audio: bool, width, height, video_codec }`, stored as
     `caps: Option<CameraCaps>` on `CameraConfig` and refreshed by every
     successful probe.
   - `WatcherConfig { enabled: false, active_hours: Option<{start, end}>,
     motion_sensitivity: 'low'|'medium'|'high' = medium,
     sound_threshold_db: -35 }` (used in phase 07).
   - The settings blob holds `cameras: CameraConfig[]`; commands receive the
     config from the frontend, matching how video commands receive
     `VideoSettings`.
2. `capture::snapshot(cfg, max_width = 1280) -> Vec<u8>` (JPEG): RTSP via
   `-rtsp_transport tcp -timeout 10000000 -i <url> -frames:v 1 -vf
   scale='min(1280,iw)':-2 -f image2pipe -c:v mjpeg -q:v 3 -`; USB via
   `-f v4l2 -i /dev/videoN` (Linux), `-f avfoundation -i "<name>:none"`
   (macOS), `-f dshow -i video="<name>"` (Windows). Run through
   `video::prepare_child`, `-nostdin`, hard 15 s kill timeout.
3. `capture::record_audio(cfg, seconds ≤ 30) -> Vec<u8>` (16 kHz mono
   `pcm_s16le` WAV, same arguments as `transcribe::audio_wav`): RTSP takes the
   stream's audio; USB takes `audio_device` via `pulse`/`alsa` (Linux,
   pulse first), avfoundation `:<index>` (macOS), dshow `audio="<name>"`
   (Windows). Error "This camera has no microphone" when no audio stream or
   device.
4. `capture::probe(cfg) -> CameraCaps` with ffprobe; the frontend saves the
   result into the camera's `caps` (Test button and on save).
5. `usb::list_devices()` — on Linux, scan `/dev/video*` and keep nodes whose
   `VIDIOC_QUERYCAP` reports `V4L2_CAP_VIDEO_CAPTURE` (via the `v4l` crate,
   added here under the Linux target dependencies), with audio devices from
   `ffmpeg -sources pulse`;
   `-f avfoundation -list_devices true -i ""` (macOS), `-f dshow
   -list_devices true -i dummy` (Windows); returns video devices and audio
   devices, and pairs a webcam's mic by matching name.
6. Commands: `camera_snapshot(config) -> data:image/jpeg;base64`,
   `camera_listen(config, seconds, transcribe) -> { transcript, level_db }`
   (records, measures RMS level, transcribes while holding a `WhisperLease`; `transcribe: false` skips whisper for the Test button's level
   check), `camera_probe(config)`, `camera_usb_devices()`. Passwords are
   saved by the frontend through the existing `setSecret` path; no new
   secret command.
7. Settings fields and defaults: `cameras: []`, `cameraTrustedServers: []`,
   `cameraEventRetentionDays: 7`. Setters snapshot plain JSON.
8. Run `./scripts/export-ipc-types.sh`.

## Build gate

- `npm run check`, `npm run lint`, `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff

## Test plan

- Unit (Rust): argument builders for each source/platform; credential
  injection and redaction (URL with password never appears in error strings);
  WAV header/length for a lavfi-generated test source
  (`-f lavfi -i testsrc` / `sine`) standing in for a camera — runs with the
  bundled or PATH ffmpeg, skipped when none.
- Unit (TS): settings defaults, `load()` merge of an old blob without
  `cameras`, setter snapshotting.
- Manual: `camera_snapshot` and `camera_listen` against the Thingino D1
  (`rtsp://192.168.1.184:554/ch0`) and a USB webcam on Linux, via the dev
  console `invoke`.

## Commit

`feat(camera): add camera config, snapshot and listen commands over ffmpeg`

## Rollback

Revert: new module and fields only; old settings blobs ignore the extra
fields. Keychain entries created during testing are harmless.
