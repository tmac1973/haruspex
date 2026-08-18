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

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::link::{self, QrMatrix};
use super::relay::{PromptRequest, SessionInfo, TurnStatus, EVENT_CANCEL, EVENT_PROMPT};
use super::server::{self, PromptSink, RemoteConfig, RemoteStatus};
use super::RemoteServer;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelEvent {
    turn_id: String,
}

/// Delivers prompts to the webview, which is the only thing in the process
/// that can run an agent turn.
struct WebviewSink(AppHandle);

impl PromptSink for WebviewSink {
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
}

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
    let sink = Arc::new(WebviewSink(app));
    let running = server::start(sink, state.relay(), config).await?;
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
        WebviewSink(app).cancel(&turn_id);
    }
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
