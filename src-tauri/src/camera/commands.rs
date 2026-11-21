//! Tauri commands for the cameras. Each gets the camera's config from the
//! frontend, and the ffmpeg and ffprobe paths set in Settings → Video editing
//! (`overrides`), which the cameras share with the video tools.

use super::aim::{self, Aim, CameraAimResult};
use super::alert_mail::{self, CameraAlert, MAX_ATTACHMENTS};
use super::capture::{self, SNAPSHOT_MAX_WIDTH};
use super::onvif::discovery::{self, DiscoveredCamera};
use super::onvif::{self, ptz::Ptz, OnvifConnection};
use super::reference::{self, Light, References};
use super::usb::{self, UsbDevices};
use super::watcher::{remove_files, CameraWatchStatus, WatcherRegistry};
use super::{CameraCaps, CameraConfig, Credentials, OnvifPreset};
use crate::db::{AlertLevel, CameraEvent, CameraEventFilter, Database, HourCounts};
use crate::integrations::email::auth::EmailAccount;
use crate::integrations::email::smtp_client;
use crate::video::binaries::{resolve_tool, BinaryOverrides, Tool};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// What `camera_listen` heard.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CameraListenResult {
    /// What was said; `None` when transcription was not asked for.
    pub transcript: Option<String>,
    /// The clip's overall loudness, RMS in dBFS; -120 is silence.
    pub level_db: f64,
}

/// One frame from the camera, as a `data:image/jpeg;base64,` URL.
#[tauri::command]
pub async fn camera_snapshot(
    config: CameraConfig,
    overrides: BinaryOverrides,
    max_width: Option<u32>,
) -> Result<String, String> {
    let ffmpeg = resolve_tool(Tool::Ffmpeg, &overrides).await?;
    // Smaller for a sweep's many pictures; never larger than a lone one.
    let width = max_width.map_or(SNAPSHOT_MAX_WIDTH, |w| w.clamp(320, SNAPSHOT_MAX_WIDTH));
    let jpeg = capture::snapshot(&ffmpeg, &config, width).await?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&jpeg);
    Ok(format!("data:image/jpeg;base64,{encoded}"))
}

/// Record `seconds` (at most 30) of the camera's sound and say how loud it
/// was; with `transcribe`, also what was said, through the video
/// whisper-server.
#[tauri::command]
pub async fn camera_listen(
    app: tauri::AppHandle,
    whisper: tauri::State<'_, crate::whisper::VideoWhisper>,
    models: tauri::State<'_, crate::models::ModelManager>,
    config: CameraConfig,
    seconds: u32,
    transcribe: bool,
    overrides: BinaryOverrides,
) -> Result<CameraListenResult, String> {
    use crate::video::transcribe::{language_for, lease_server, model_for};
    let ffmpeg = resolve_tool(Tool::Ffmpeg, &overrides).await?;
    // Found before recording, so a missing model doesn't waste the clip.
    let model = if transcribe {
        Some(
            model_for(models.models_dir())
                .ok_or("No speech model is installed. Settings → Audio downloads one.")?,
        )
    } else {
        None
    };
    let wav = capture::record_audio(&ffmpeg, &config, seconds).await?;
    let level_db = capture::level_db(&wav);
    let transcript = match model {
        Some(model) => {
            let _lease = lease_server(&app, &model).await?;
            let (segments, _) = whisper
                .0
                .transcribe_segments(wav, language_for(&model))
                .await?;
            let text: Vec<&str> = segments.iter().map(|s| s.text.trim()).collect();
            Some(text.join(" ").trim().to_string())
        }
        None => None,
    };
    Ok(CameraListenResult {
        transcript,
        level_db,
    })
}

/// What the camera's stream holds; the frontend saves it as the camera's `caps`.
#[tauri::command]
pub async fn camera_probe(
    config: CameraConfig,
    overrides: BinaryOverrides,
) -> Result<CameraCaps, String> {
    let ffprobe = resolve_tool(Tool::Ffprobe, &overrides).await?;
    capture::probe(&ffprobe, &config).await
}

/// The webcams and microphones plugged in, each webcam with its own mic when
/// one matches by name.
#[tauri::command]
pub async fn camera_usb_devices(overrides: BinaryOverrides) -> Result<UsbDevices, String> {
    let ffmpeg = resolve_tool(Tool::Ffmpeg, &overrides).await.ok();
    usb::list_devices(ffmpeg.as_deref()).await
}

/// The ONVIF cameras that answer on the local network within 3 seconds.
#[tauri::command]
pub async fn camera_onvif_discover() -> Result<Vec<DiscoveredCamera>, String> {
    discovery::discover(discovery::PROBE_WAIT).await
}

/// Sign in to the camera at `xaddr` (its ONVIF device service) and read its
/// streams, and its pan/tilt and presets if it has them.
#[tauri::command]
pub async fn camera_onvif_connect(
    xaddr: String,
    username: String,
    password: String,
) -> Result<OnvifConnection, String> {
    let redactor = Credentials {
        username: username.clone(),
        password: password.clone(),
    };
    let creds = Credentials { username, password };
    onvif::connect(&xaddr, creds)
        .await
        .map_err(|e| redactor.redact(&e))
}

/// Read a saved camera's presets again, with its saved user name and password.
#[tauri::command]
pub async fn camera_onvif_presets(config: CameraConfig) -> Result<Vec<OnvifPreset>, String> {
    let endpoint = config
        .onvif
        .as_ref()
        .ok_or("This camera has no ONVIF service. Find it again under Settings → Cameras.")?;
    let creds = Credentials::for_source(&config.source).await?;
    Ptz::open(endpoint, creds).await?.presets().await
}

/// Turn the camera, or send it to a preset, and wait for it to settle.
#[tauri::command]
pub async fn camera_aim(
    config: CameraConfig,
    aim: Aim,
    overrides: BinaryOverrides,
) -> Result<CameraAimResult, String> {
    // A person or a chat turned it: room checks leave it alone for a while.
    reference::record_aim(&config.id, crate::time_util::now_ms());
    let ffmpeg = resolve_tool(Tool::Ffmpeg, &overrides).await.ok();
    aim::aim(&config, &aim, ffmpeg.as_deref()).await
}

/// Measure how far a network camera's pan turns go (see `calibrate`). Takes
/// about a minute, and leaves the camera at home.
#[tauri::command]
pub async fn camera_calibrate(
    config: CameraConfig,
    overrides: BinaryOverrides,
) -> Result<super::PtzCalibration, String> {
    reference::record_aim(&config.id, crate::time_util::now_ms());
    let ffmpeg = resolve_tool(Tool::Ffmpeg, &overrides).await?;
    super::calibrate::calibrate(&config, &ffmpeg).await
}

/// Whether the USB webcam at `device` can pan or tilt over UVC. Always false
/// off Linux.
#[tauri::command]
pub async fn camera_uvc_supported(device: String) -> bool {
    #[cfg(target_os = "linux")]
    {
        tokio::task::spawn_blocking(move || super::uvc::supported(&device))
            .await
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = device;
        false
    }
}

/// Take the cameras' watcher settings and how many days of events to keep:
/// delete older events, and start or stop watchers to match. The first call
/// starts the 30-second schedule.
#[tauri::command]
pub async fn camera_watch_set(
    app: tauri::AppHandle,
    registry: tauri::State<'_, WatcherRegistry>,
    configs: Vec<CameraConfig>,
    retention_days: u32,
    overrides: BinaryOverrides,
) -> Result<CameraWatchStatus, String> {
    let registry = registry.inner().clone();
    Ok(registry.set(&app, configs, retention_days, overrides).await)
}

/// The cameras being watched, and what last went wrong for each.
#[tauri::command]
pub async fn camera_watch_status(
    registry: tauri::State<'_, WatcherRegistry>,
) -> Result<CameraWatchStatus, String> {
    Ok(registry.status())
}

/// Run a database read or write off the main thread.
async fn on_db<T: Send + 'static>(
    db: &tauri::State<'_, Database>,
    f: impl FnOnce(Database) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || f(db))
        .await
        .map_err(|e| format!("db task panicked: {e}"))?
}

/// The newest events, of one camera or all, started within `since`..`until`
/// (epoch ms) if given; without thumbnails.
#[tauri::command]
pub async fn camera_events_list(
    db: tauri::State<'_, Database>,
    camera_id: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
    limit: u32,
) -> Result<Vec<CameraEvent>, String> {
    let filter = CameraEventFilter {
        camera_id,
        since,
        until,
        limit,
    };
    on_db(&db, move |db| db.list_camera_events(&filter)).await
}

/// The newest events whose transcript or caption has every word of `query`.
#[tauri::command]
pub async fn camera_events_search(
    db: tauri::State<'_, Database>,
    query: String,
    camera_id: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
    limit: u32,
) -> Result<Vec<CameraEvent>, String> {
    let filter = CameraEventFilter {
        camera_id,
        since,
        until,
        limit,
    };
    on_db(&db, move |db| db.search_camera_events(&query, &filter)).await
}

/// An event's thumbnail as a `data:image/jpeg;base64,` URL.
#[tauri::command]
pub async fn camera_event_thumb(db: tauri::State<'_, Database>, id: i64) -> Result<String, String> {
    on_db(&db, move |db| {
        let path = db
            .camera_event_thumb_path(id)?
            .ok_or("This event has no picture.")?;
        let jpeg = std::fs::read(&path).map_err(|_| "This event's picture is missing.")?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        Ok(format!("data:image/jpeg;base64,{encoded}"))
    })
    .await
}

/// Save an event's caption, or mark it skipped with none.
#[tauri::command]
pub async fn camera_event_set_caption(
    db: tauri::State<'_, Database>,
    id: i64,
    caption: Option<String>,
) -> Result<(), String> {
    on_db(&db, move |db| {
        db.set_camera_event_caption(id, caption.as_deref())
    })
    .await
}

/// Save an event's caption and its camera-alerts judgement together.
#[tauri::command]
pub async fn camera_event_set_judgement(
    db: tauri::State<'_, Database>,
    id: i64,
    caption: Option<String>,
    level: AlertLevel,
    reason: String,
) -> Result<(), String> {
    on_db(&db, move |db| {
        db.set_camera_event_judgement(id, caption.as_deref(), level, &reason)
    })
    .await
}

/// Mark an event's alert dismissed, with the user's note.
#[tauri::command]
pub async fn camera_event_dismiss(
    db: tauri::State<'_, Database>,
    id: i64,
    note: String,
) -> Result<(), String> {
    on_db(&db, move |db| {
        db.dismiss_camera_event(id, &note, crate::time_util::now_ms())
    })
    .await
}

/// A camera's events per local hour since `since` (epoch ms), weekdays and
/// weekends apart; camera alerts learn its quiet hours from them.
#[tauri::command]
pub async fn camera_event_hour_counts(
    db: tauri::State<'_, Database>,
    camera_id: String,
    since: i64,
) -> Result<HourCounts, String> {
    let offset_ms = i64::from(chrono::Local::now().offset().local_minus_utc()) * 1000;
    on_db(&db, move |db| {
        db.camera_event_hour_counts(&camera_id, since, offset_ms)
    })
    .await
}

/// Send a camera alert email from `account` to `to`, the addresses set in
/// Settings → Cameras → Alerts, with the pictures of `alert.event_ids`
/// attached. Its subject is fixed by its kind; nothing in it chooses who it
/// goes to. No copy goes to Sent. Returns the new Message-ID, for the next
/// alert to thread under.
#[tauri::command]
pub async fn camera_alert_send(
    db: tauri::State<'_, Database>,
    account: EmailAccount,
    to: Vec<String>,
    alert: CameraAlert,
) -> Result<String, String> {
    let mailboxes = alert_mail::recipients(&to)?;
    let ids: Vec<i64> = alert
        .event_ids
        .iter()
        .copied()
        .take(MAX_ATTACHMENTS)
        .collect();
    let pictures = on_db(&db, move |db| {
        let mut out = Vec::new();
        for id in ids {
            let Some(path) = db.camera_event_thumb_path(id)? else {
                continue;
            };
            if let Ok(jpeg) = std::fs::read(&path) {
                out.push((format!("event-{id}.jpg"), jpeg));
            }
        }
        Ok(out)
    })
    .await?;
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let sent = smtp_client::send_built(&account, |from, message_id| {
        alert_mail::build(from, &mailboxes, &alert, pictures, message_id, &date)
    })
    .await?;
    Ok(sent.message_id)
}

fn app_data(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| format!("No app data folder: {e}"))
}

/// The JPEG bytes in a `data:image/jpeg;base64,` URL (or bare base64).
fn jpeg_from_data_url(url: &str) -> Result<Vec<u8>, String> {
    let b64 = url.split_once(',').map_or(url, |(_, b)| b);
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|_| "The picture is not valid base64.".to_string())
}

fn data_url(jpeg: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(jpeg);
    format!("data:image/jpeg;base64,{encoded}")
}

/// Save a picture as a camera's room reference for its light (camera
/// alerts' This is normal); which light it was for.
#[tauri::command]
pub async fn camera_reference_set(
    app: tauri::AppHandle,
    camera_id: String,
    jpeg: String,
) -> Result<Light, String> {
    let dir = reference::refs_dir(&app_data(&app)?, &camera_id);
    let bytes = jpeg_from_data_url(&jpeg)?;
    tokio::task::spawn_blocking(move || reference::save(&dir, &bytes))
        .await
        .map_err(|e| e.to_string())?
}

/// A camera's day and night room references, with when each was saved.
#[tauri::command]
pub async fn camera_reference_get(
    app: tauri::AppHandle,
    camera_id: String,
) -> Result<References, String> {
    let dir = reference::refs_dir(&app_data(&app)?, &camera_id);
    tokio::task::spawn_blocking(move || {
        let one = |light| {
            reference::load(&dir, light).map(|(jpeg, set_at)| reference::Reference {
                set_at,
                data_url: data_url(&jpeg),
            })
        };
        References {
            day: one(Light::Day),
            night: one(Light::Night),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Remove a camera's reference for one light, or both when none is named.
#[tauri::command]
pub async fn camera_reference_clear(
    app: tauri::AppHandle,
    camera_id: String,
    light: Option<Light>,
) -> Result<(), String> {
    let dir = reference::refs_dir(&app_data(&app)?, &camera_id);
    match light {
        Some(l) => reference::clear(&dir, l),
        None => {
            reference::clear(&dir, Light::Day)?;
            reference::clear(&dir, Light::Night)
        }
    }
}

/// What a room check's picture found.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RoomShot {
    /// Someone turned the camera in the last five minutes: no picture taken.
    pub busy: bool,
    /// The picture, as a data URL; empty when busy.
    pub jpeg: String,
    pub night: bool,
    /// How alike it is to the reference for its light, -1 to 1; `None` when
    /// there is no such reference.
    pub similarity: Option<f64>,
    /// When that reference was saved, epoch ms.
    #[ts(type = "number | null")]
    pub reference_at: Option<i64>,
    /// The reference, as a data URL, when there is one.
    pub reference: Option<String>,
    /// Whether the camera has a reference for either light: none means the
    /// user hasn't set one with This is normal yet.
    pub has_references: bool,
}

/// A room check's picture: the camera sent home first if it turns (unless
/// someone turned it in the last five minutes), then compared with its
/// reference. Its own turn home doesn't count as someone turning it.
#[tauri::command]
pub async fn camera_room_shot(
    app: tauri::AppHandle,
    config: CameraConfig,
    overrides: BinaryOverrides,
) -> Result<RoomShot, String> {
    let busy = RoomShot {
        busy: true,
        jpeg: String::new(),
        night: false,
        similarity: None,
        reference_at: None,
        reference: None,
        has_references: false,
    };
    if config.ptz != super::PtzKind::None {
        if reference::busy(&config.id, crate::time_util::now_ms()) {
            return Ok(busy);
        }
        let home = Aim::Move {
            direction: aim::AimDirection::Home,
            amount: Default::default(),
        };
        aim::aim(&config, &home, None).await?;
    }
    let ffmpeg = resolve_tool(Tool::Ffmpeg, &overrides).await?;
    let jpeg = capture::snapshot(&ffmpeg, &config, ROOM_SHOT_WIDTH).await?;
    let dir = reference::refs_dir(&app_data(&app)?, &config.id);
    tokio::task::spawn_blocking(move || {
        let has_references = reference::load(&dir, Light::Day).is_some()
            || reference::load(&dir, Light::Night).is_some();
        let night = reference::is_night(&jpeg)?;
        let light = if night { Light::Night } else { Light::Day };
        let (similarity, reference_at, reference) = match reference::load(&dir, light) {
            Some((r, at)) => (
                Some(reference::similarity(&r, &jpeg)?),
                Some(at),
                Some(data_url(&r)),
            ),
            None => (None, None, None),
        };
        Ok(RoomShot {
            busy: false,
            jpeg: data_url(&jpeg),
            night,
            similarity,
            reference_at,
            reference,
            has_references,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How wide a room check's picture is.
const ROOM_SHOT_WIDTH: u32 = 1280;

/// Log a room check that found the room changed: a `room` entry with its
/// picture and judgement already set. Returns the entry.
#[tauri::command]
pub async fn camera_room_event_add(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    camera_id: String,
    jpeg: String,
    caption: String,
    level: AlertLevel,
    reason: String,
) -> Result<CameraEvent, String> {
    let events_dir = app_data(&app)?.join("camera_events");
    let bytes = jpeg_from_data_url(&jpeg)?;
    on_db(&db, move |db| {
        let now = crate::time_util::now_ms();
        let id = super::watcher::store_event(
            &db,
            &events_dir,
            &crate::db::NewCameraEvent {
                camera_id,
                started_at: now,
                ended_at: now,
                trigger: "room".into(),
                level_db: -120.0,
                transcript: String::new(),
            },
            Some(&bytes),
        )?;
        db.set_camera_event_judgement(id, Some(&caption), level, &reason)?;
        db.camera_event(id)?
            .ok_or_else(|| "The room entry was not saved.".to_string())
    })
    .await
}

/// The events waiting for a caption, oldest first.
#[tauri::command]
pub async fn camera_events_pending(
    db: tauri::State<'_, Database>,
    limit: u32,
) -> Result<Vec<CameraEvent>, String> {
    on_db(&db, move |db| db.pending_camera_events(limit)).await
}

/// Delete one event and its thumbnail.
#[tauri::command]
pub async fn camera_event_delete(db: tauri::State<'_, Database>, id: i64) -> Result<(), String> {
    on_db(&db, move |db| {
        remove_files(&db.delete_camera_event(id)?);
        Ok(())
    })
    .await
}

/// Delete one camera's events, or every camera's, and their thumbnails; how
/// many were deleted.
#[tauri::command]
pub async fn camera_events_clear(
    db: tauri::State<'_, Database>,
    camera_id: Option<String>,
) -> Result<u32, String> {
    on_db(&db, move |db| {
        let (count, thumbs) = db.clear_camera_events(camera_id.as_deref())?;
        remove_files(&thumbs);
        Ok(count as u32)
    })
    .await
}
