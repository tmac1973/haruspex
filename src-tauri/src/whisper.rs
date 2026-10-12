use crate::sidecar_process::SidecarChild;
use log::info;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::sidecar_util::{
    base_url, clear_logs, health_url, http_client, kill_child, new_log_buffer, ports,
    require_ready, snapshot_logs, start_sidecar, LogBuffer, SidecarStart, SidecarStatus, LOOPBACK,
};

const WHISPER_PORT: u16 = ports::WHISPER;

/// Lifecycle state of the whisper-server sidecar. Kept as a type alias
/// onto `SidecarStatus` so the Tauri command surface (and frontend
/// `MicButton`) sees the same `{ type, message }` wire shape as the
/// other two sidecars.
pub type WhisperStatus = SidecarStatus;

pub struct WhisperServer {
    child: Mutex<Option<SidecarChild>>,
    status: Arc<Mutex<WhisperStatus>>,
    log_buffer: LogBuffer,
}

impl WhisperServer {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            status: Arc::new(Mutex::new(WhisperStatus::Stopped)),
            log_buffer: new_log_buffer(),
        }
    }

    pub async fn start(&self, app: &AppHandle, model_path: &str) -> Result<(), String> {
        self.stop().await?;
        info!("Starting whisper-server with model: {}", model_path);

        let args = vec![
            "--model".to_string(),
            model_path.to_string(),
            "--host".to_string(),
            LOOPBACK.to_string(),
            "--port".to_string(),
            WHISPER_PORT.to_string(),
        ];
        let spec = SidecarStart {
            name: "whisper-server",
            port: WHISPER_PORT,
            args,
            env: Vec::new(),
            ready_markers: &[],
            health_url: health_url(WHISPER_PORT),
            accept_any: false,
        };
        start_sidecar(app, spec, &self.child, &self.status, &self.log_buffer).await
    }

    pub async fn stop(&self) -> Result<(), String> {
        kill_child(&self.child, "whisper-server").await?;
        *self.status.lock().await = WhisperStatus::Stopped;
        Ok(())
    }

    pub async fn get_status(&self) -> WhisperStatus {
        self.status.lock().await.clone()
    }

    pub async fn get_logs(&self) -> Vec<String> {
        snapshot_logs(&self.log_buffer).await
    }

    pub async fn clear_logs(&self) {
        clear_logs(&self.log_buffer).await;
    }

    pub async fn transcribe(&self, audio_data: Vec<u8>) -> Result<String, String> {
        require_ready(&self.status, "Whisper server is not ready").await?;

        let client = http_client(Duration::from_secs(30));

        let part = reqwest::multipart::Part::bytes(audio_data)
            .file_name("recording.wav")
            .mime_str("audio/wav")
            .map_err(|e| format!("Multipart error: {}", e))?;

        let form = reqwest::multipart::Form::new().part("file", part);

        let resp = client
            .post(format!("{}/inference", base_url(WHISPER_PORT)))
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Transcription request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!(
                "Transcription failed with status: {}",
                resp.status()
            ));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {}", e))?;

        // whisper-server returns JSON with "text" field
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(text) = parsed.get("text").and_then(|v| v.as_str()) {
                return Ok(text.trim().to_string());
            }
        }

        // Fallback: return raw body trimmed
        Ok(body.trim().to_string())
    }
}

// Tauri commands

#[tauri::command]
pub async fn start_whisper(
    app: AppHandle,
    state: tauri::State<'_, WhisperServer>,
    model_path: String,
) -> Result<(), String> {
    state.start(&app, &model_path).await
}

#[tauri::command]
pub async fn get_whisper_status(
    state: tauri::State<'_, WhisperServer>,
) -> Result<WhisperStatus, ()> {
    Ok(state.get_status().await)
}

#[tauri::command]
pub async fn get_whisper_logs(state: tauri::State<'_, WhisperServer>) -> Result<Vec<String>, ()> {
    Ok(state.get_logs().await)
}

#[tauri::command]
pub async fn clear_whisper_logs(state: tauri::State<'_, WhisperServer>) -> Result<(), ()> {
    state.clear_logs().await;
    Ok(())
}

#[tauri::command]
pub async fn transcribe_audio(
    state: tauri::State<'_, WhisperServer>,
    audio: Vec<u8>,
) -> Result<String, String> {
    state.transcribe(audio).await
}
