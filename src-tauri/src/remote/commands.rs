//! The IPC surface between the webview and the remote server.
//!
//! Two directions meet here. The frontend starts and stops the server (it owns
//! settings, including the token), and the frontend reports turn progress back
//! so the relay can fan it out to HTTP clients.
//!
//! All of these are `async` deliberately: a synchronous `#[tauri::command]`
//! runs on the main thread, where any stall shows up as a frozen window. None
//! of these block, but the async form removes the question.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::tts::TtsEngine;

use super::link::{self, QrMatrix};
use super::relay::{
    Answer, PromptRequest, Question, SessionInfo, Step, TurnStatus, EVENT_CANCEL, EVENT_PROMPT,
};
use super::server::{self, BoxFuture, Host, RemoteConfig, RemoteStatus};
use super::RemoteServer;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelEvent {
    turn_id: String,
}

/// Connects the HTTP server to the running app: prompts go to the webview,
/// which is the only thing in the process that can run an agent turn, and
/// speech goes through the same sidecar the host's own Listen button uses.
struct AppBridge(AppHandle);

impl Host for AppBridge {
    fn dispatch(&self, request: PromptRequest) -> Result<(), String> {
        self.0
            .emit(EVENT_PROMPT, request)
            .map_err(|e| e.to_string())
    }

    fn cancel(&self, turn_id: &str) {
        let _ = self.0.emit(
            EVENT_CANCEL,
            CancelEvent {
                turn_id: turn_id.to_string(),
            },
        );
    }

    fn answer(&self, turn_id: &str, answer: &Answer) {
        let _ = self.0.emit(EVENT_ANSWER, AnswerEvent { turn_id, answer });
    }

    fn ensure_speech(&self) -> BoxFuture<Result<(), String>> {
        let app = self.0.clone();
        Box::pin(async move {
            let engine = app.state::<TtsEngine>();
            if engine.is_ready().await {
                return Ok(());
            }
            log::info!("[remote] starting the speech engine for a guest");
            engine.start(&app).await?;
            // Same wait the local path allows: the sidecar loads a model.
            for _ in 0..SPEECH_START_ATTEMPTS {
                if engine.is_ready().await {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err("the speech engine did not become ready".to_string())
        })
    }
}

/// Emitted to the webview when a guest answers a question the model asked.
const EVENT_ANSWER: &str = "remote://answer";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnswerEvent<'a> {
    turn_id: &'a str,
    #[serde(flatten)]
    answer: &'a Answer,
}

/// 30 seconds at 500ms apart, matching what the app's own TTS startup allows.
const SPEECH_START_ATTEMPTS: usize = 60;

#[tauri::command]
pub async fn remote_start(
    app: AppHandle,
    state: State<'_, RemoteServer>,
    config: RemoteConfig,
) -> Result<RemoteStatus, String> {
    if state.matches(&config) {
        return Ok(state.status());
    }
    // Stop first: rebinding the same port while the old listener holds it is
    // the obvious way for a port change to fail on the way back.
    state.shutdown();
    let bridge = Arc::new(AppBridge(app));
    let running = server::start(bridge, state.relay(), config).await?;
    state.install(running);
    Ok(state.status())
}

#[tauri::command]
pub async fn remote_stop(state: State<'_, RemoteServer>) -> Result<RemoteStatus, String> {
    state.shutdown();
    Ok(state.status())
}

#[tauri::command]
pub async fn remote_status(state: State<'_, RemoteServer>) -> Result<RemoteStatus, String> {
    Ok(state.status())
}

/// The address to hand out, or `None` on a machine with no route to a network.
/// The settings page says so plainly rather than showing `127.0.0.1`, which
/// would look like a working link and reach nobody.
#[tauri::command]
pub async fn remote_lan_address() -> Result<Option<String>, String> {
    Ok(link::lan_address().map(|ip| ip.to_string()))
}

/// The link as a QR code, because the guest is holding a phone and the token is
/// 32 characters of noise.
#[tauri::command]
pub async fn remote_link_qr(text: String) -> Result<QrMatrix, String> {
    link::qr_matrix(&text)
}

#[tauri::command]
pub async fn remote_sessions(state: State<'_, RemoteServer>) -> Result<Vec<SessionInfo>, String> {
    Ok(state.relay().sessions())
}

/// Throw one guest off without disturbing anyone else.
#[tauri::command]
pub async fn remote_disconnect(
    app: AppHandle,
    state: State<'_, RemoteServer>,
    session_id: String,
) -> Result<(), String> {
    if let Some(turn_id) = state.relay().disconnect(&session_id) {
        AppBridge(app).cancel(&turn_id);
    }
    Ok(())
}

/// Report a tool call so the guest can see the turn working rather than
/// watching a cursor blink.
#[tauri::command]
pub async fn remote_turn_step(
    state: State<'_, RemoteServer>,
    turn_id: String,
    step: Step,
) -> Result<(), String> {
    let _ = state.relay().push_step(&turn_id, step);
    Ok(())
}

/// Park the turn on a question for the guest to answer.
#[tauri::command]
pub async fn remote_turn_question(
    state: State<'_, RemoteServer>,
    turn_id: String,
    question: Question,
) -> Result<(), String> {
    state
        .relay()
        .ask(&turn_id, question)
        .map_err(|e| e.message().to_string())
}

/// Take the question down — answered elsewhere, or waited out.
#[tauri::command]
pub async fn remote_turn_question_cleared(
    state: State<'_, RemoteServer>,
    turn_id: String,
) -> Result<(), String> {
    let _ = state.relay().clear_question(&turn_id);
    Ok(())
}

/// The whole answer so far, not the newest fragment. The relay derives the
/// suffix, which keeps one authoritative buffer instead of two that can drift.
#[tauri::command]
pub async fn remote_turn_delta(
    state: State<'_, RemoteServer>,
    turn_id: String,
    text: String,
) -> Result<(), String> {
    // A delta for a turn that has already ended is expected — the driver may
    // still be unwinding when a cancel lands — and is dropped, not an error.
    let _ = state.relay().push_text(&turn_id, &text);
    Ok(())
}

#[tauri::command]
pub async fn remote_turn_running(
    state: State<'_, RemoteServer>,
    turn_id: String,
) -> Result<(), String> {
    let _ = state.relay().set_status(&turn_id, TurnStatus::Running);
    Ok(())
}

#[tauri::command]
pub async fn remote_turn_done(
    state: State<'_, RemoteServer>,
    turn_id: String,
    text: String,
) -> Result<(), String> {
    let _ = state.relay().finish(&turn_id, text);
    Ok(())
}

#[tauri::command]
pub async fn remote_turn_error(
    state: State<'_, RemoteServer>,
    turn_id: String,
    message: String,
) -> Result<(), String> {
    let _ = state.relay().fail(&turn_id, message);
    Ok(())
}
