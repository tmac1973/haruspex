mod context;
mod integration;
mod pty;
mod session;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use context::{read_recent_history, SessionContext};
use integration::CapturedRegion;
use session::Session;
pub use session::SessionId;

#[derive(Default)]
pub struct ShellManager {
    sessions: Mutex<HashMap<SessionId, Session>>,
    next_id: AtomicU32,
}

impl ShellManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn alloc_id(&self) -> SessionId {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn shutdown_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
    }
}

#[derive(Serialize)]
pub struct ShellSpawnResult {
    pub session_id: SessionId,
    pub context: SessionContext,
}

fn integration_dir(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidate = resource_dir.join("resources/shell-integration");
    if candidate.is_dir() {
        return Some(candidate);
    }
    // Tauri 2 sometimes flattens the resource layout; try the leaf name too.
    let candidate = resource_dir.join("shell-integration");
    if candidate.is_dir() {
        return Some(candidate);
    }
    // Dev fallback: the source tree path relative to the manifest dir.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("shell-integration");
    if dev.is_dir() {
        return Some(dev);
    }
    None
}

#[tauri::command]
pub fn shell_spawn(
    app: AppHandle,
    state: State<'_, ShellManager>,
    cols: u16,
    rows: u16,
    shell_override: Option<String>,
) -> Result<ShellSpawnResult, String> {
    let id = state.alloc_id();
    let shell = pty::resolve_shell_with_override(shell_override.as_deref());
    let cwd = pty::resolve_cwd();
    let integration_dir = integration_dir(&app);
    let session = Session::spawn(
        app,
        id,
        &shell,
        &cwd,
        integration_dir.as_deref(),
        cols,
        rows,
    )?;
    let context = session.context.clone();
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);
    Ok(ShellSpawnResult {
        session_id: id,
        context,
    })
}

#[tauri::command]
pub fn shell_write(
    state: State<'_, ShellManager>,
    session_id: SessionId,
    data: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    session.write(data.as_bytes())
}

#[tauri::command]
pub fn shell_resize(
    state: State<'_, ShellManager>,
    session_id: SessionId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    session.resize(cols, rows)
}

#[tauri::command]
pub fn shell_kill(state: State<'_, ShellManager>, session_id: SessionId) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.remove(&session_id);
    Ok(())
}

#[derive(Serialize)]
pub struct ShellContextResponse {
    pub context: SessionContext,
    pub current_cwd: Option<String>,
}

#[tauri::command]
pub fn shell_get_context(
    state: State<'_, ShellManager>,
    session_id: SessionId,
) -> Result<ShellContextResponse, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    Ok(ShellContextResponse {
        context: session.context.clone(),
        current_cwd: session.current_cwd(),
    })
}

#[tauri::command]
pub fn shell_get_last_command(
    state: State<'_, ShellManager>,
    session_id: SessionId,
) -> Result<Option<CapturedRegion>, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    Ok(session.capture_last_command())
}

#[tauri::command]
pub fn shell_get_recent_history(
    state: State<'_, ShellManager>,
    session_id: SessionId,
    limit: usize,
) -> Result<Vec<String>, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    Ok(read_recent_history(&session.context.shell_name, limit))
}
