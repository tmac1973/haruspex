use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose;
use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::context::SessionContext;
use super::integration::{CapturedRegion, Integration};
use super::pty::{plan_integration, SpawnPlan};

pub type SessionId = u32;

#[derive(Serialize, Clone)]
struct OutputEvent {
    session_id: SessionId,
    base64: String,
}

#[derive(Serialize, Clone)]
struct ExitEvent {
    session_id: SessionId,
}

/// Buffers PTY output until the frontend has wired up its `shell://output`
/// listener AND the xterm `onData` reply path. Without this, output the
/// shell emits during the spawn→attach gap (notably fish's startup Primary
/// Device Attributes query) is delivered to no listener and lost, so the
/// query goes unanswered and fish stalls ~10s on a compatibility check.
struct ReplayState {
    ready: bool,
    buffer: Vec<u8>,
}

/// How much raw terminal output to retain for scrollback replay. When a
/// shell tab is detached into its own window, the new webview's fresh xterm
/// has no history (the painted lines lived in the old webview's DOM). The
/// PTY itself never restarts, so cwd / env / running processes are intact —
/// this ring just lets the new window repaint recent output before going
/// live. 256 KiB is enough for a few screenfuls without unbounded growth.
const SCROLLBACK_CAP: usize = 256 * 1024;

/// Bounded FIFO of recent raw PTY bytes for detach/re-attach scrollback.
struct ScrollbackRing {
    buf: VecDeque<u8>,
}

impl ScrollbackRing {
    fn new() -> Self {
        Self {
            buf: VecDeque::new(),
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend(bytes.iter().copied());
        if self.buf.len() > SCROLLBACK_CAP {
            let overflow = self.buf.len() - SCROLLBACK_CAP;
            self.buf.drain(0..overflow);
        }
    }

    fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }
}

pub struct Session {
    pub context: SessionContext,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    integration: Arc<Mutex<Integration>>,
    replay: Arc<Mutex<ReplayState>>,
    scrollback: Arc<Mutex<ScrollbackRing>>,
    // Kept alive so the rcfile / zdotdir survive for the shell's
    // lifetime. Cleaned up in Drop.
    _tempdirs: Vec<PathBuf>,
}

/// Strip AppImage-bundled paths out of LD_LIBRARY_PATH for the spawned
/// shell. Without this, an AppImage build leaks its munged LD_LIBRARY_PATH
/// into the shell, so the shell (and tools it runs) load the AppImage's
/// bundled libs instead of the system ones — e.g. fish warning
/// `libpcre2-8.so.0: no version information available`. No-op when not
/// running inside an AppImage (APPDIR unset), so dev mode and .deb / .rpm
/// installs are unaffected. The filtering itself lives in `env_util`
/// (shared with the URL opener in `links.rs`); this just applies the
/// decision to a portable_pty CommandBuilder.
#[cfg(target_os = "linux")]
fn sanitize_appimage_env(cmd: &mut CommandBuilder) {
    match crate::env_util::appimage_cleaned_ld_path() {
        None => {}
        Some(None) => {
            cmd.env_remove("LD_LIBRARY_PATH");
        }
        Some(Some(cleaned)) => {
            cmd.env("LD_LIBRARY_PATH", cleaned);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn sanitize_appimage_env(_cmd: &mut CommandBuilder) {}

impl Session {
    // A spawn naturally takes many knobs (shell, cwd, integration, base args,
    // geometry); bundling them into a struct would just move the noise.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        app: AppHandle,
        id: SessionId,
        shell: &str,
        cwd: &str,
        integration_dir: Option<&std::path::Path>,
        // Leading args that come before any integration args — e.g.
        // `-d <distro>` for a `wsl.exe` session. Empty for a plain shell.
        base_args: &[String],
        // The WSL distro name when this is a WSL session, so context is probed
        // inside the distro rather than the Windows host. None otherwise.
        wsl_distro: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<Self, String> {
        let plan = integration_dir
            .map(|d| plan_integration(shell, d))
            .unwrap_or_else(SpawnPlan::passthrough);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        for var in &["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL"] {
            if let Ok(v) = std::env::var(var) {
                cmd.env(var, v);
            }
        }
        // The frontend is always an xterm.js emulator, so advertise its real
        // capabilities. Don't inherit the parent process's TERM: GUI launchers,
        // IDEs and build tools often set TERM=dumb, which breaks curses/TUI apps.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        sanitize_appimage_env(&mut cmd);
        for (k, v) in &plan.env {
            cmd.env(k, v);
        }
        // Base args (e.g. `wsl -d <distro>`) come before integration args.
        for arg in base_args {
            cmd.arg(arg);
        }
        for arg in &plan.args {
            cmd.arg(arg);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn shell failed: {e}"))?;
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer failed: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone_reader failed: {e}"))?;

        let integration = Arc::new(Mutex::new(Integration::new()));
        let replay = Arc::new(Mutex::new(ReplayState {
            ready: false,
            buffer: Vec::new(),
        }));
        let scrollback = Arc::new(Mutex::new(ScrollbackRing::new()));
        spawn_reader_thread(
            app,
            id,
            reader,
            integration.clone(),
            replay.clone(),
            scrollback.clone(),
        );

        let context = SessionContext::capture(shell, wsl_distro);

        Ok(Session {
            context,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            integration,
            replay,
            scrollback,
            _tempdirs: plan.tempdirs,
        })
    }

    /// Signal that the frontend has attached its output listener and reply
    /// path. Flushes any output buffered during the spawn→attach gap, then
    /// switches the reader thread to live emission. Idempotent.
    pub fn mark_ready(&self, app: &AppHandle, id: SessionId) {
        if let Ok(mut r) = self.replay.lock() {
            if r.ready {
                return;
            }
            if !r.buffer.is_empty() {
                let evt = OutputEvent {
                    session_id: id,
                    base64: general_purpose::STANDARD.encode(&r.buffer),
                };
                let _ = app.emit("shell://output", evt);
                r.buffer.clear();
            }
            r.ready = true;
        }
    }

    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|e| e.to_string())?;
        w.write_all(bytes)
            .map_err(|e| format!("write failed: {e}"))?;
        w.flush().map_err(|e| format!("flush failed: {e}"))?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))
    }

    pub fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }

    pub fn capture_last_command(&self) -> Option<CapturedRegion> {
        self.integration.lock().ok()?.capture_last_command()
    }

    /// Recent completed commands plus the in-flight command (if one is
    /// running) so the auto-attach can include what the user just started.
    pub fn capture_recent_commands_with_pending(&self, limit: usize) -> Vec<CapturedRegion> {
        self.integration
            .lock()
            .map(|i| i.capture_recent_commands_with_pending(limit))
            .unwrap_or_default()
    }

    pub fn marker_count(&self) -> usize {
        self.integration
            .lock()
            .map(|i| i.markers().count())
            .unwrap_or(0)
    }

    pub fn completed_command_count(&self) -> usize {
        self.integration
            .lock()
            .map(|i| i.completed_command_count())
            .unwrap_or(0)
    }

    /// Monotonic count of completed commands over the session's lifetime
    /// (never caps when the marker ring saturates). Used by the Run
    /// auto-submit to detect that the command it ran has finished.
    pub fn completed_command_total(&self) -> u64 {
        self.integration
            .lock()
            .map(|i| i.output_end_total())
            .unwrap_or(0)
    }

    pub fn current_cwd(&self) -> Option<String> {
        self.integration
            .lock()
            .ok()
            .and_then(|i| i.current_cwd().map(|s| s.to_string()))
    }

    /// Recent raw terminal output (base64) for repainting a detached window's
    /// fresh xterm before it goes live.
    pub fn scrollback_base64(&self) -> String {
        let bytes = self
            .scrollback
            .lock()
            .map(|s| s.snapshot())
            .unwrap_or_default();
        general_purpose::STANDARD.encode(&bytes)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
        for dir in &self._tempdirs {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_retains_recent_bytes_under_cap() {
        let mut ring = ScrollbackRing::new();
        ring.push(b"hello ");
        ring.push(b"world");
        assert_eq!(ring.snapshot(), b"hello world");
    }

    #[test]
    fn ring_evicts_oldest_past_cap() {
        let mut ring = ScrollbackRing::new();
        ring.push(&vec![b'a'; SCROLLBACK_CAP]);
        ring.push(&vec![b'b'; SCROLLBACK_CAP]);
        let snap = ring.snapshot();
        // Capped at SCROLLBACK_CAP; the first push is fully evicted by the
        // second, so only the newest bytes ('b') remain.
        assert_eq!(snap.len(), SCROLLBACK_CAP);
        assert!(snap.iter().all(|&b| b == b'b'));
    }
}

fn spawn_reader_thread(
    app: AppHandle,
    id: SessionId,
    mut reader: Box<dyn Read + Send>,
    integration: Arc<Mutex<Integration>>,
    replay: Arc<Mutex<ReplayState>>,
    scrollback: Arc<Mutex<ScrollbackRing>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut integ) = integration.lock() {
                        integ.ingest(&buf[..n]);
                    }
                    // Retain raw output for detach/re-attach scrollback,
                    // regardless of ready state — a new window replays the
                    // full ring, not the spawn-gap replay buffer.
                    if let Ok(mut sb) = scrollback.lock() {
                        sb.push(&buf[..n]);
                    }
                    // Until the frontend marks itself ready, buffer output
                    // instead of emitting it to a listener that doesn't exist
                    // yet (which would silently drop it).
                    let mut emit_live = true;
                    if let Ok(mut r) = replay.lock() {
                        if !r.ready {
                            r.buffer.extend_from_slice(&buf[..n]);
                            emit_live = false;
                        }
                    }
                    if !emit_live {
                        continue;
                    }
                    let evt = OutputEvent {
                        session_id: id,
                        base64: general_purpose::STANDARD.encode(&buf[..n]),
                    };
                    if app.emit("shell://output", evt).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    log::warn!("shell session {id} read error: {e}");
                    break;
                }
            }
        }
        let _ = app.emit("shell://exit", ExitEvent { session_id: id });
    });
}
