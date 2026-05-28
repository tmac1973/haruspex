use std::io::{Read, Write};
use std::sync::Mutex;

use base64::engine::general_purpose;
use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

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

pub struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

impl Session {
    pub fn spawn(
        app: AppHandle,
        id: SessionId,
        shell: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Self, String> {
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
        // Forward a minimal env so the shell behaves like a real login terminal.
        for var in &["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL"] {
            if let Ok(v) = std::env::var(var) {
                cmd.env(var, v);
            }
        }
        cmd.env(
            "TERM",
            std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string()),
        );
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn shell failed: {e}"))?;
        // Drop the slave handle in the parent so the PTY closes when the child exits.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer failed: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone_reader failed: {e}"))?;

        spawn_reader_thread(app, id, reader);

        Ok(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
        })
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
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

fn spawn_reader_thread(app: AppHandle, id: SessionId, mut reader: Box<dyn Read + Send>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
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
