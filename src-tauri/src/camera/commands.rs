//! Tauri commands for the cameras. Each gets the camera's config from the
//! frontend, and the ffmpeg and ffprobe paths set in Settings → Video editing
//! (`overrides`), which the cameras share with the video tools.

use super::capture::{self, SNAPSHOT_MAX_WIDTH};
use super::usb::{self, UsbDevices};
use super::{CameraCaps, CameraConfig};
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
