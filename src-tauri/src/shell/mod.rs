mod pty;
mod session;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, State};

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

#[tauri::command]
pub fn shell_spawn(
    app: AppHandle,
    state: State<'_, ShellManager>,
    cols: u16,
    rows: u16,
) -> Result<SessionId, String> {
    let id = state.alloc_id();
    let shell = pty::resolve_shell();
    let cwd = pty::resolve_cwd();
    let session = Session::spawn(app, id, &shell, &cwd, cols, rows)?;
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);
    Ok(id)
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
