mod catalog;
mod context;
mod integration;
mod kind;
mod platform;
mod pty;
mod session;
mod winps;
mod wsl;

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
    /// Chat threads handed off across windows during shell-tab detach /
    /// re-attach, keyed by PTY session id. In-memory only (a detached chat
    /// survives the move but not an app restart) — see plan Phase 3.
    chat_stash: Mutex<HashMap<SessionId, String>>,
    /// Serialized terminal grid snapshot (xterm SerializeAddon output) handed
    /// off alongside the chat, so the adopting window repaints history cleanly
    /// rather than replaying the raw byte stream (which reflows badly at a
    /// different window width). Keyed by PTY session id; consumed once.
    scrollback_stash: Mutex<HashMap<SessionId, String>>,
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

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ShellSpawnResult {
    pub session_id: SessionId,
    pub context: SessionContext,
}

fn integration_dir(app: &AppHandle) -> Option<PathBuf> {
    // In dev the source tree is authoritative and always current. A staged
    // resource copy under target/ can be stale — e.g. it has the older
    // bash/zsh hooks but not a newly-added haruspex.ps1 — and would otherwise
    // shadow the source dir, so check the source FIRST in debug builds.
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("shell-integration");
        if dev.is_dir() {
            return Some(dev);
        }
    }
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
    // Fallback: the source tree path relative to the manifest dir (also covers
    // any release edge case where the bundled resources aren't found).
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("shell-integration");
    if dev.is_dir() {
        return Some(dev);
    }
    None
}

/// Resolve a spawn request to a `(program, leading-args)` pair. A `selection`
/// from the picker (Windows) wins; otherwise fall back to the legacy
/// `shell_override` string path (Linux/macOS), which takes no base args.
fn resolve_spawn_target(
    selection: Option<kind::ShellSelection>,
    shell_override: Option<String>,
) -> (String, Vec<String>) {
    match selection {
        Some(sel) => {
            let spec = sel.to_spec();
            (spec.program, spec.args)
        }
        None => (
            pty::resolve_shell_with_override(shell_override.as_deref()),
            Vec::new(),
        ),
    }
}

#[tauri::command]
pub fn shell_spawn(
    app: AppHandle,
    state: State<'_, ShellManager>,
    cols: u16,
    rows: u16,
    shell_override: Option<String>,
    selection: Option<kind::ShellSelection>,
) -> Result<ShellSpawnResult, String> {
    let id = state.alloc_id();
    let (program, base_args) = resolve_spawn_target(selection, shell_override);
    let cwd = pty::resolve_cwd();
    let integration_dir = integration_dir(&app);
    let session = Session::spawn(
        app,
        id,
        &program,
        &cwd,
        integration_dir.as_deref(),
        &base_args,
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

/// Called by the frontend once it has attached its `shell://output`
/// listener and the xterm reply path. Flushes output buffered during the
/// spawn→attach gap so startup terminal queries (e.g. fish's Primary
/// Device Attributes probe) reach xterm and get answered.
#[tauri::command]
pub fn shell_mark_ready(
    app: AppHandle,
    state: State<'_, ShellManager>,
    session_id: SessionId,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    session.mark_ready(&app, session_id);
    Ok(())
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

/// Kill the given session and start a fresh one with the same id-namespace
/// allocator. Returns the new session id + freshly captured context (so a
/// kernel/distro upgrade since the last spawn picks up here too) the same
/// way shell_spawn does. Used by the "Restart shell" UI affordance — also
/// the recovery path when the integration script gets updated and the user
/// needs a new bash session to source it.
#[tauri::command]
pub fn shell_restart(
    app: AppHandle,
    state: State<'_, ShellManager>,
    session_id: SessionId,
    cols: u16,
    rows: u16,
    shell_override: Option<String>,
    selection: Option<kind::ShellSelection>,
) -> Result<ShellSpawnResult, String> {
    // Drop the old session (its Drop impl kills the PTY + cleans tempdirs).
    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&session_id);
    }
    let new_id = state.alloc_id();
    let (program, base_args) = resolve_spawn_target(selection, shell_override);
    let cwd = pty::resolve_cwd();
    let integration_dir = integration_dir(&app);
    let session = Session::spawn(
        app,
        new_id,
        &program,
        &cwd,
        integration_dir.as_deref(),
        &base_args,
        cols,
        rows,
    )?;
    let context = session.context.clone();
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(new_id, session);
    Ok(ShellSpawnResult {
        session_id: new_id,
        context,
    })
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ShellContextResponse {
    pub context: SessionContext,
    pub current_cwd: Option<String>,
    /// Number of OSC 133 markers seen in the session ring so far.
    /// 0 means the shell-integration script almost certainly didn't
    /// load — the badge in the sidebar surfaces this to the user.
    #[ts(type = "number")]
    pub marker_count: usize,
    /// Number of complete B→C→D cycles available to the auto-attach.
    /// Distinct from marker_count because A+B pairs (prompt redraws
    /// without a following command) inflate marker_count but don't
    /// contribute to captures. When this is 0 but marker_count > 0,
    /// the integration is loaded but the user hasn't run anything
    /// yet in this session — the badge calls that out.
    #[ts(type = "number")]
    pub completed_commands: usize,
    /// Monotonic lifetime count of completed commands — never caps when the
    /// marker ring saturates. The Run auto-submit polls this to detect the
    /// command it launched finishing (marker_count can't, once saturated).
    #[ts(type = "number")]
    pub completed_total: u64,
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
        marker_count: session.marker_count(),
        completed_commands: session.completed_command_count(),
        completed_total: session.completed_command_total(),
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
pub fn shell_get_recent_commands(
    state: State<'_, ShellManager>,
    session_id: SessionId,
    limit: usize,
) -> Result<Vec<CapturedRegion>, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    // Include the in-flight command so asking about something still
    // running attaches its output-so-far, not just completed commands.
    Ok(session.capture_recent_commands_with_pending(limit))
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

/// Recent raw terminal output (base64) for the given session, used to
/// repaint a detached window's fresh xterm before it subscribes to live
/// output. The PTY is untouched — this is purely cosmetic history.
#[tauri::command]
pub fn shell_get_scrollback(
    state: State<'_, ShellManager>,
    session_id: SessionId,
) -> Result<String, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    Ok(session.scrollback_base64())
}

/// Stash a shell tab's chat thread (JSON) so the window taking over the
/// session can re-hydrate it. Overwrites any prior stash for this id.
#[tauri::command]
pub fn shell_stash_chat(
    state: State<'_, ShellManager>,
    session_id: SessionId,
    chat: String,
) -> Result<(), String> {
    state
        .chat_stash
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, chat);
    Ok(())
}

/// Take (and clear) a stashed chat thread for the given session id.
#[tauri::command]
pub fn shell_take_chat(
    state: State<'_, ShellManager>,
    session_id: SessionId,
) -> Result<Option<String>, String> {
    Ok(state
        .chat_stash
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id))
}

/// Stash a serialized terminal-grid snapshot for cross-window handoff.
#[tauri::command]
pub fn shell_stash_scrollback(
    state: State<'_, ShellManager>,
    session_id: SessionId,
    data: String,
) -> Result<(), String> {
    state
        .scrollback_stash
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, data);
    Ok(())
}

/// Take (and clear) a stashed terminal-grid snapshot for the given session.
#[tauri::command]
pub fn shell_take_scrollback(
    state: State<'_, ShellManager>,
    session_id: SessionId,
) -> Result<Option<String>, String> {
    Ok(state
        .scrollback_stash
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id))
}

/// The shells the user can pick in the toolbar: on Windows, PowerShell 7 /
/// Windows PowerShell / each WSL2 distro (uninstalled ones greyed-out with an
/// install hint); on other platforms, a single native entry. Never errors.
#[tauri::command]
pub fn shell_list_shells() -> Vec<catalog::ShellCatalogEntry> {
    catalog::enumerate_shells()
}

/// Returns whether the Shell tab is supported on the current host.
/// Linux and macOS are supported (PTY via portable-pty + bash/zsh OSC 133
/// capture). On Windows it's gated behind the HARUSPEX_WIN_SHELL dev flag
/// during the Phase 17 port. The frontend uses this to swap the xterm mount
/// for a placeholder. Delegates to the per-OS `platform` module so the gate
/// lives in one place.
#[tauri::command]
pub fn shell_platform_supported() -> bool {
    platform::platform_supported()
}
