use crate::sidecar_process::SidecarChild;
use log::{info, Level};
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
    /// The model and VAD paths the running server was started with, so a
    /// second start with the same ones leaves it alone.
    started_with: Mutex<Option<(String, Option<String>)>>,
}

/// whisper-server's arguments. With a VAD model it skips the parts of a
/// clip without speech, so silence comes back empty instead of invented.
fn server_args(port: u16, model_path: &str, vad_model_path: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--model".to_string(),
        model_path.to_string(),
        "--host".to_string(),
        LOOPBACK.to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
    if let Some(vad) = vad_model_path {
        args.extend([
            "--vad".to_string(),
            "--vad-model".to_string(),
            vad.to_string(),
        ]);
    }
    args
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
    /// Each word's time, inside the segment; empty when whisper gave none.
    #[serde(default)]
    pub words: Vec<Word>,
}

/// One spoken word, in the same seconds as its segment. Whisper gives a word
/// in pieces: punctuation, and the rest of a word ("isel" after " ch"), come
/// with no space before them and are joined to the word before.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A segment's words: whitespace-only pieces dropped, and a piece with no
/// space before it joined to the word before. Joined punctuation keeps the
/// word's times; the rest of a word extends its end.
fn words_of(raw: Vec<RawWord>) -> Vec<Word> {
    let mut out: Vec<Word> = Vec::new();
    // A whitespace-only piece ends the word before it.
    let mut after_space = true;
    for w in raw {
        let text = w.word.trim();
        if text.is_empty() {
            after_space = true;
            continue;
        }
        let spaced = after_space || w.word.starts_with(char::is_whitespace);
        after_space = w.word.ends_with(char::is_whitespace);
        let punct = text.chars().all(|c| !c.is_alphanumeric());
        match out.last_mut() {
            Some(last) if punct => last.text.push_str(text),
            Some(last) if !spaced => {
                last.text.push_str(text);
                last.end = last.end.max(w.end);
            }
            _ => out.push(Word {
                start: w.start,
                end: w.end.max(w.start),
                text: text.to_string(),
            }),
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct RawWord {
    word: String,
    start: f64,
    end: f64,
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
        #[serde(default)]
        words: Vec<RawWord>,
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
            words: words_of(s.words),
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
            started_with: Mutex::new(None),
        }
    }

    /// Start whisper-server on `model_path`, with Silero VAD when
    /// `vad_model_path` is given. Does nothing when it is already Ready
    /// with the same two paths.
    pub async fn start(
        &self,
        app: &AppHandle,
        model_path: &str,
        vad_model_path: Option<&str>,
    ) -> Result<(), String> {
        let wanted = (model_path.to_string(), vad_model_path.map(str::to_string));
        if self.started_with.lock().await.as_ref() == Some(&wanted)
            && matches!(self.get_status().await, WhisperStatus::Ready)
        {
            return Ok(());
        }
        self.stop().await?;
        info!(
            "Starting whisper-server with model: {} (VAD: {})",
            model_path,
            vad_model_path.unwrap_or("off")
        );
        *self.started_with.lock().await = Some(wanted);

        let args = server_args(self.port, model_path, vad_model_path);
        let spec = SidecarStart {
            name: "whisper-server",
            id: self.id,
            port: self.port,
            args,
            env: Vec::new(),
            ready_markers: &[],
            // Model loading and per-request progress, not errors.
            stderr_level: Level::Info,
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
            .text("split_on_word", "true")
            .text("token_timestamps", "true")
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
    fn server_args_add_vad_only_when_given() {
        let with = server_args(8766, "/m/base.bin", Some("/m/silero.bin"));
        let at = with.iter().position(|a| a == "--vad-model").unwrap();
        assert!(with.contains(&"--vad".to_string()));
        assert_eq!(with[at + 1], "/m/silero.bin");
        assert_eq!(
            with[with.iter().position(|a| a == "--model").unwrap() + 1],
            "/m/base.bin"
        );

        let without = server_args(8766, "/m/base.bin", None);
        assert!(!without.iter().any(|a| a.starts_with("--vad")));
        assert!(without.contains(&"8766".to_string()));
    }

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
                text: "Hello there.".into(),
                words: vec![]
            }
        );
        assert_eq!(s[1].end, 5.25);
        assert!(s[1].words.is_empty());
    }

    /// Part of a real whisper-server answer (split_on_word, token_timestamps).
    #[test]
    fn verbose_words_parse_and_join_punctuation() {
        let body = r#"{"language":"en","segments":[{"id":0,"text":" The quick fox, then.",
            "start":0.0,"end":3.6,"words":[
              {"word":" The","start":0.25,"end":0.25,"t_dtw":-1,"probability":0.9},
              {"word":" quick","start":0.31,"end":0.66,"t_dtw":-1,"probability":0.8},
              {"word":" fox","start":1.09,"end":1.34,"t_dtw":-1,"probability":0.9},
              {"word":",","start":3.08,"end":3.12,"t_dtw":-1,"probability":0.4},
              {"word":" ","start":3.12,"end":3.12,"t_dtw":-1,"probability":0.4},
              {"word":" then","start":3.12,"end":3.36,"t_dtw":-1,"probability":0.8},
              {"word":".","start":3.5,"end":3.6,"t_dtw":-1,"probability":0.9}]}]}"#;
        let (s, _) = parse_verbose(body).unwrap();
        let words: Vec<&str> = s[0].words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(words, ["The", "quick", "fox,", "then."]);
        assert!(s[0].words.windows(2).all(|w| w[0].start <= w[1].start));
        assert!(s[0]
            .words
            .iter()
            .all(|w| w.start >= s[0].start && w.end <= s[0].end));
        // A joined mark keeps the word's own times.
        assert_eq!(s[0].words[2].end, 1.34);
    }

    /// Pieces as whisper-server gave them for "sharpen a chisel. Today we're".
    #[test]
    fn verbose_words_join_pieces_of_a_word() {
        let body = r#"{"language":"en","segments":[{"id":0,"text":" a chisel. Today we're",
            "start":0.0,"end":4.0,"words":[
              {"word":" a","start":0.1,"end":0.2},
              {"word":" ch","start":0.2,"end":0.5},
              {"word":"isel","start":0.55,"end":0.9},
              {"word":".","start":0.9,"end":0.95},
              {"word":" Today","start":1.5,"end":1.7},
              {"word":" we","start":1.7,"end":1.8},
              {"word":"'re","start":1.9,"end":2.0},
              {"word":" ","start":2.0,"end":2.0},
              {"word":"h","start":2.1,"end":2.2}]}]}"#;
        let (s, _) = parse_verbose(body).unwrap();
        let words: Vec<(&str, f64, f64)> = s[0]
            .words
            .iter()
            .map(|w| (w.text.as_str(), w.start, w.end))
            .collect();
        assert_eq!(
            words,
            [
                ("a", 0.1, 0.2),
                ("chisel.", 0.2, 0.9),
                ("Today", 1.5, 1.7),
                ("we're", 1.7, 2.0),
                ("h", 2.1, 2.2)
            ]
        );
    }
}

// Tauri commands

#[tauri::command]
pub async fn start_whisper(
    app: AppHandle,
    state: tauri::State<'_, WhisperServer>,
    model_path: String,
    vad_model_path: Option<String>,
) -> Result<(), String> {
    state
        .start(&app, &model_path, vad_model_path.as_deref())
        .await
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

/// The video tools' whisper-server log, for its own log viewer tab.
#[tauri::command]
pub async fn whisper_video_logs(state: tauri::State<'_, VideoWhisper>) -> Result<Vec<String>, ()> {
    Ok(state.0.get_logs().await)
}

#[tauri::command]
pub async fn whisper_video_clear_logs(state: tauri::State<'_, VideoWhisper>) -> Result<(), ()> {
    state.0.clear_logs().await;
    Ok(())
}

#[tauri::command]
pub async fn transcribe_audio(
    state: tauri::State<'_, WhisperServer>,
    audio: Vec<u8>,
) -> Result<String, String> {
    state.transcribe(audio).await
}
