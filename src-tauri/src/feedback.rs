//! Diagnostics gathering for the in-app feedback button.
//!
//! Exposes two Tauri commands:
//!   - `get_diagnostics` — assembles a snapshot of OS/arch, app version,
//!     and the tail of the four log buffers (app, llama-server, whisper,
//!     koko). The frontend merges this with settings + the debug-log
//!     ring buffer and either composes a pre-filled GitHub issue URL or
//!     a full-bundle file for the "Save Full Diagnostics" path.
//!   - `save_diagnostics_file` — one-shot UTF-8 write to an absolute
//!     path. Used after the user picks a destination via the save
//!     dialog. Kept separate from `fs_write_text` because that command
//!     is workdir-sandboxed; diagnostics export needs to land anywhere.

use serde::Serialize;

use crate::app_log;
use crate::server::LlamaServer;
use crate::tts::TtsEngine;
use crate::whisper::WhisperServer;

#[derive(Serialize)]
pub struct Diagnostics {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub appimage: bool,
    pub app_log: Vec<String>,
    pub llama_log: Vec<String>,
    pub whisper_log: Vec<String>,
    pub tts_log: Vec<String>,
}

#[tauri::command]
pub async fn get_diagnostics(
    llama: tauri::State<'_, LlamaServer>,
    whisper: tauri::State<'_, WhisperServer>,
    tts: tauri::State<'_, TtsEngine>,
) -> Result<Diagnostics, ()> {
    Ok(Diagnostics {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        appimage: std::env::var("APPDIR")
            .map(|v| !v.is_empty())
            .unwrap_or(false),
        app_log: app_log::get_logs(),
        llama_log: llama.get_logs().await,
        whisper_log: whisper.get_logs().await,
        tts_log: tts.get_logs().await,
    })
}

#[tauri::command]
pub async fn save_diagnostics_file(path: String, contents: String) -> Result<(), String> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| format!("Failed to write diagnostics file: {}", e))
}
