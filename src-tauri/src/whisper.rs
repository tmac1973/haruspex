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

/// Lifecycle state of the whisper-server sidecar. Kept as a type alias
/// onto `SidecarStatus` so the Tauri command surface (and frontend
/// `MicButton`) sees the same `{ type, message }` wire shape as the
/// other two sidecars.
pub type WhisperStatus = SidecarStatus;

pub struct WhisperServer {
    child: Mutex<Option<SidecarChild>>,
    status: Arc<Mutex<WhisperStatus>>,
    log_buffer: LogBuffer,
    port: u16,
    id: &'static str,
}

/// The whisper-server the video tools transcribe footage with: its own port
/// and model, so voice input keeps working while it runs.
pub struct VideoWhisper(pub WhisperServer);

/// One stretch of speech, in seconds from the start of the audio sent.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// The segments of a `response_format=verbose_json` answer.
pub fn parse_verbose(body: &str) -> Result<(Vec<Segment>, Option<String>), String> {
    #[derive(serde::Deserialize)]
    struct Raw {
        #[serde(default)]
        segments: Vec<RawSegment>,
        language: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct RawSegment {
        start: f64,
        end: f64,
        text: String,
    }
    let raw: Raw =
        serde_json::from_str(body).map_err(|e| format!("whisper-server's answer: {e}"))?;
    let segments = raw
        .segments
        .into_iter()
        .map(|s| Segment {
            start: s.start,
            end: s.end,
            text: s.text.trim().to_string(),
        })
        .filter(|s| !s.text.is_empty())
        .collect();
    Ok((segments, raw.language))
}

impl WhisperServer {
    pub fn new() -> Self {
        Self::on(ports::WHISPER, "whisper-server")
    }

    /// The video tools' instance.
    pub fn video() -> VideoWhisper {
        VideoWhisper(Self::on(ports::WHISPER_VIDEO, "whisper-video"))
    }

    fn on(port: u16, id: &'static str) -> Self {
        Self {
            child: Mutex::new(None),
            status: Arc::new(Mutex::new(WhisperStatus::Stopped)),
            log_buffer: new_log_buffer(),
            port,
            id,
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
            self.port.to_string(),
        ];
        let spec = SidecarStart {
            name: "whisper-server",
            id: self.id,
            port: self.port,
            args,
            env: Vec::new(),
            ready_markers: &[],
            health_url: health_url(self.port),
            accept_any: false,
        };
        start_sidecar(app, spec, &self.child, &self.status, &self.log_buffer).await
    }

    pub async fn stop(&self) -> Result<(), String> {
        kill_child(&self.child, self.id).await?;
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
            .post(format!("{}/inference", base_url(self.port)))
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

    /// Treat a server the test started itself as this one, once it answers.
    #[cfg(test)]
    pub async fn attach_ready_for_tests(&self, timeout: Duration) {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            let ok = reqwest::get(health_url(self.port))
                .await
                .is_ok_and(|r| r.status().is_success());
            if ok {
                *self.status.lock().await = WhisperStatus::Ready;
                return;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        panic!("whisper-server never answered");
    }

    /// Wait for the server to be ready, up to `timeout`.
    pub async fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
        let start = std::time::Instant::now();
        loop {
            match self.get_status().await {
                WhisperStatus::Ready => return Ok(()),
                WhisperStatus::Error(e) => return Err(format!("whisper-server failed: {e}")),
                WhisperStatus::Stopped => return Err("whisper-server is not running".into()),
                _ => {}
            }
            if start.elapsed() > timeout {
                return Err("whisper-server took too long to start".into());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    pub async fn is_running(&self) -> bool {
        matches!(
            self.get_status().await,
            WhisperStatus::Ready | WhisperStatus::Starting
        )
    }

    /// Transcribe a WAV with timestamps. Long audio takes minutes, so the
    /// request may take up to 15.
    pub async fn transcribe_segments(
        &self,
        wav: Vec<u8>,
        language: &str,
    ) -> Result<(Vec<Segment>, Option<String>), String> {
        require_ready(&self.status, "Whisper server is not ready").await?;
        let client = http_client(Duration::from_secs(15 * 60));
        let part = reqwest::multipart::Part::bytes(wav)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|e| format!("Multipart error: {e}"))?;
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("response_format", "verbose_json")
            .text("temperature", "0")
            .text("language", language.to_string());
        let resp = client
            .post(format!("{}/inference", base_url(self.port)))
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Transcription request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "Transcription failed with status: {}",
                resp.status()
            ));
        }
        let body = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {e}"))?;
        parse_verbose(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbose_segments_parse_and_trim() {
        let body = r#"{"task":"transcribe","language":"english","duration":12.0,"text":"x",
            "segments":[{"id":0,"text":" Hello there.","start":0.0,"end":2.5,"words":[]},
                        {"id":1,"text":"  ","start":2.5,"end":3.0},
                        {"id":2,"text":" Next bit","start":3.0,"end":5.25}]}"#;
        let (s, lang) = parse_verbose(body).unwrap();
        assert_eq!(lang.as_deref(), Some("english"));
        assert_eq!(s.len(), 2);
        assert_eq!(
            s[0],
            Segment {
                start: 0.0,
                end: 2.5,
                text: "Hello there.".into()
            }
        );
        assert_eq!(s[1].end, 5.25);
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
