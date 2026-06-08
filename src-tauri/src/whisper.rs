use log::info;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use crate::sidecar_utils::{
    base_url, drive_status_on_health, health_url, http_client, kill_child, kill_process_on_port,
    new_log_buffer, poll_health, ports, spawn_log_reader, with_library_paths, LogBuffer,
    SidecarStatus,
};

const WHISPER_PORT: u16 = ports::WHISPER;
const HEALTH_POLL_TIMEOUT: Duration = Duration::from_secs(30);

/// Lifecycle state of the whisper-server sidecar. Kept as a type alias
/// onto `SidecarStatus` so the Tauri command surface (and frontend
/// `MicButton`) sees the same `{ type, message }` wire shape as the
/// other two sidecars.
pub type WhisperStatus = SidecarStatus;

pub struct WhisperServer {
    child: Mutex<Option<CommandChild>>,
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
        kill_process_on_port(WHISPER_PORT, "whisper-server").await;

        {
            let mut status = self.status.lock().await;
            *status = WhisperStatus::Starting;
        }

        info!("Starting whisper-server with model: {}", model_path);

        let args = vec![
            "--model".to_string(),
            model_path.to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            WHISPER_PORT.to_string(),
        ];

        let sidecar = app
            .shell()
            .sidecar("whisper-server")
            .map_err(|e| format!("Failed to create whisper sidecar: {}", e))?
            .args(&args);

        // Set library path so whisper-server can find its bundled shared libraries
        let sidecar = with_library_paths(sidecar, app);

        let (rx, child) = sidecar
            .spawn()
            .map_err(|e| format!("Failed to spawn whisper-server: {}", e))?;

        {
            let mut c = self.child.lock().await;
            *c = Some(child);
        }

        // Drain the log/event stream into the buffer + status.
        spawn_log_reader(
            "whisper-server",
            rx,
            Arc::clone(&self.status),
            Arc::clone(&self.log_buffer),
            &[],
        );

        // Health poll: drive the status from Starting → Ready (or Error
        // on timeout). Bails out early if another path (e.g. an explicit
        // stop()) moves the status away from Starting first.
        let status_for_health = Arc::clone(&self.status);
        tauri::async_runtime::spawn(async move {
            let url = health_url(WHISPER_PORT);
            let status_check = Arc::clone(&status_for_health);
            let ok = poll_health(
                &url,
                "whisper-server",
                HEALTH_POLL_TIMEOUT,
                false,
                move || {
                    let s = Arc::clone(&status_check);
                    async move { *s.lock().await == WhisperStatus::Starting }
                },
            )
            .await;
            drive_status_on_health(&status_for_health, ok, "whisper-server").await;
        });

        Ok(())
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
        let buffer = self.log_buffer.lock().await;
        buffer.iter().cloned().collect()
    }

    pub async fn clear_logs(&self) {
        let mut buffer = self.log_buffer.lock().await;
        buffer.clear();
    }

    pub async fn transcribe(&self, audio_data: Vec<u8>) -> Result<String, String> {
        let status = self.status.lock().await;
        if *status != WhisperStatus::Ready {
            return Err("Whisper server is not ready".to_string());
        }
        drop(status);

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
pub async fn stop_whisper(state: tauri::State<'_, WhisperServer>) -> Result<(), String> {
    state.stop().await
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
