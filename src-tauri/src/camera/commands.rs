//! Tauri commands for the cameras. Each gets the camera's config from the
//! frontend, and the ffmpeg and ffprobe paths set in Settings → Video editing
//! (`overrides`), which the cameras share with the video tools.

use super::aim::{self, Aim, CameraAimResult};
use super::capture::{self, SNAPSHOT_MAX_WIDTH};
use super::onvif::discovery::{self, DiscoveredCamera};
use super::onvif::{self, ptz::Ptz, OnvifConnection};
use super::usb::{self, UsbDevices};
use super::{CameraCaps, CameraConfig, Credentials, OnvifPreset};
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
) -> Result<String, String> {
    let ffmpeg = resolve_tool(Tool::Ffmpeg, &overrides).await?;
    let jpeg = capture::snapshot(&ffmpeg, &config, SNAPSHOT_MAX_WIDTH).await?;
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
pub async fn camera_aim(config: CameraConfig, aim: Aim) -> Result<CameraAimResult, String> {
    aim::aim(&config, &aim).await
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
