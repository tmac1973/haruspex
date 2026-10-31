//! In-memory app log capture.
//!
//! Implements a custom `log::Log` that writes log records to both stderr
//! (for dev / terminal-launched use) and an in-memory ring buffer that the
//! UI can display via the Log Viewer. This covers any log output from the
//! main Rust process — PDF extraction errors, file tool failures, database
//! issues, proxy errors, etc. — that previously had no user-visible surface.

use log::{Level, LevelFilter, Log, Metadata, Record};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

const RING_CAPACITY: usize = 2000;

static BUFFER: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();

fn buffer() -> &'static Mutex<VecDeque<String>> {
    BUFFER.get_or_init(|| Mutex::new(VecDeque::with_capacity(RING_CAPACITY)))
}

struct AppLogger {
    level: LevelFilter,
}

/// Message prefixes that indicate the line is sidecar stdout/stderr
/// being passed through the `log` crate. These already appear in their
/// own dedicated log viewer tabs (LLM / Whisper / TTS), so we filter them
/// out of the App log tab to keep it focused on the main app's own
/// activity (PDF extraction, file tools, agent loop, errors, etc.).
///
/// Note: this only affects the in-memory buffer that the App tab reads.
/// The lines are still printed to stderr for dev / terminal users, and
/// they still flow into the per-sidecar ring buffers in server.rs /
/// whisper.rs / tts.rs.
const SIDECAR_PASSTHROUGH_PREFIXES: &[&str] = &[
    "llama-server:",
    "llama-server stderr:",
    "whisper-server:",
    "koko:",
];

fn is_sidecar_passthrough(message: &str) -> bool {
    SIDECAR_PASSTHROUGH_PREFIXES
        .iter()
        .any(|prefix| message.starts_with(prefix))
}

/// Dependencies whose warnings say nothing the user can act on, so only
/// their errors are logged. html5ever warns once per misplaced node when a
/// fetched page or email has a malformed table ("foster parenting not
/// implemented"), which floods the log with hundreds of identical lines.
const QUIET_TARGETS: &[&str] = &["html5ever"];

fn is_quiet_dependency(target: &str, level: Level) -> bool {
    level > Level::Error
        && QUIET_TARGETS.iter().any(|quiet| {
            target
                .strip_prefix(quiet)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with("::"))
        })
}

impl Log for AppLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= self.level && !is_quiet_dependency(metadata.target(), metadata.level())
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let ts = chrono_now();
        let level_tag = match record.level() {
            Level::Error => "ERROR",
            Level::Warn => "WARN ",
            Level::Info => "INFO ",
            Level::Debug => "DEBUG",
            Level::Trace => "TRACE",
        };
        let target = record.target();
        let message = format!("{}", record.args());
        let line = format!("[{}] [{}] [{}] {}", ts, level_tag, target, message);

        // Mirror to stderr for dev / terminal launches (always — terminal
        // users want to see everything in one stream)
        eprintln!("{}", line);

        // Push into the ring buffer for the App log viewer tab — but skip
        // sidecar passthrough lines since they're already shown in their
        // own dedicated tabs. This keeps the App tab focused on what's
        // actually happening in the Rust app itself.
        if is_sidecar_passthrough(&message) {
            return;
        }

        if let Ok(mut buf) = buffer().lock() {
            if buf.len() >= RING_CAPACITY {
                buf.pop_front();
            }
            buf.push_back(line);
        }
    }

    fn flush(&self) {}
}

/// Log-consistent timestamp (`YYYY-MM-DD HH:MM:SS`) for other modules that
/// want to stamp their own output the same way the app log does — e.g. the
/// llama-server crash telemetry file.
pub fn timestamp() -> String {
    chrono_now()
}

/// Minimal timestamp without pulling in the chrono crate.
/// Format: YYYY-MM-DD HH:MM:SS in local time.
fn chrono_now() -> String {
    let secs = crate::time_util::now_secs_u64();

    // Naive epoch → Y/M/D/H/M/S conversion (UTC). Close enough for a log
    // timestamp; we don't want to pull chrono just for this.
    let days = secs / 86_400;
    let time_of_day = secs % 86_400;
    let h = time_of_day / 3600;
    let m = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;

    // Days from 1970-01-01 → Y/M/D (shared calendar math).
    let (y, mo, d) = crate::time_util::days_to_ymd(days as i64);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, m, s)
}

/// Initialize the global logger. Call once at app startup, before any
/// code that logs. Safe to call multiple times — subsequent calls are
/// no-ops if a logger is already installed.
pub fn init() {
    let logger = Box::new(AppLogger {
        level: LevelFilter::Info,
    });
    // Ignore error — set_boxed_logger fails if a logger is already set,
    // which is fine in tests or if the Tauri log plugin was initialized first.
    let _ = log::set_boxed_logger(logger);
    log::set_max_level(LevelFilter::Info);
}

/// Return a snapshot of the current log buffer (oldest first).
pub fn get_logs() -> Vec<String> {
    buffer()
        .lock()
        .map(|b| b.iter().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn get_app_logs() -> Result<Vec<String>, ()> {
    Ok(get_logs())
}

#[tauri::command]
pub async fn clear_app_logs() -> Result<(), ()> {
    if let Ok(mut b) = buffer().lock() {
        b.clear();
    }
    Ok(())
}

/// Where dev builds mirror the webview's agent debug log (`debugLog.ts`),
/// so a session can be read after the fact instead of being copied out of the
/// Log Viewer before the app closes. Off in release builds unless
/// `HARUSPEX_DEBUG_LOG_FILE` is set: a whole agent turn's log is large, and it
/// holds the conversation.
const DEBUG_LOG_FILE: &str = "agent-debug.log";

/// Past this the file is rotated to `agent-debug.log.1`, replacing the old one.
const DEBUG_LOG_CAP: u64 = 20 * 1024 * 1024;

fn debug_log_file_enabled() -> bool {
    cfg!(debug_assertions) || crate::env_util::debug_log_file_requested()
}

fn debug_log_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("logs");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join(DEBUG_LOG_FILE))
}

/// Append `lines` to `path`, rotating it first when it has grown past `cap`.
/// Each line goes through [`crate::text_util::redact_secrets`] with `known`,
/// as a feedback report does: the lines hold prompts and tool output, which
/// can carry a key the user pasted. The file is created readable by the owner
/// only on Unix.
fn append_debug_lines(
    path: &std::path::Path,
    lines: &[String],
    known: &[String],
    cap: u64,
) -> std::io::Result<()> {
    use std::io::Write;
    if std::fs::metadata(path).is_ok_and(|m| m.len() > cap) {
        std::fs::rename(path, path.with_extension("log.1"))?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    // A file an older build created stays as it was without this.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    let mut out = String::new();
    for line in lines {
        out.push_str(&crate::text_util::redact_secrets(line, known));
        out.push('\n');
    }
    file.write_all(out.as_bytes())
}

/// The mirror file's path, or None when mirroring is off for this build.
#[tauri::command]
pub async fn debug_log_file_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    if !debug_log_file_enabled() {
        return Ok(None);
    }
    Ok(Some(debug_log_path(&app)?.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn debug_log_append(app: tauri::AppHandle, lines: Vec<String>) -> Result<(), String> {
    if !debug_log_file_enabled() || lines.is_empty() {
        return Ok(());
    }
    let path = debug_log_path(&app)?;
    let known = crate::secrets::known_values();
    append_debug_lines(&path, &lines, &known, DEBUG_LOG_CAP).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Calendar math moved to crate::time_util — tested there.

    #[test]
    fn sidecar_passthrough_filter_catches_all_three_sidecars() {
        assert!(is_sidecar_passthrough(
            "llama-server: srv  log_server: model loaded"
        ));
        assert!(is_sidecar_passthrough(
            "llama-server stderr: srv update_slots: kv cache rm"
        ));
        assert!(is_sidecar_passthrough(
            "whisper-server: whisper_init_from_file_no_state"
        ));
        assert!(is_sidecar_passthrough("koko: starting kokoros"));
    }

    #[test]
    fn sidecar_passthrough_filter_does_not_catch_app_messages() {
        assert!(!is_sidecar_passthrough(
            "Starting llama-server with args: [...]"
        ));
        assert!(!is_sidecar_passthrough("PDFium initialized from /path"));
        assert!(!is_sidecar_passthrough(
            "Auto-search rotation order for 'foo': [...]"
        ));
        assert!(!is_sidecar_passthrough(
            "find_mmproj_for_model returned None"
        ));
        // Edge case: a message that mentions a sidecar name but isn't passthrough
        assert!(!is_sidecar_passthrough(
            "Spawning llama-server child process"
        ));
    }

    #[test]
    fn quiet_dependencies_log_only_errors() {
        assert!(is_quiet_dependency("html5ever::tree_builder", Level::Warn));
        assert!(is_quiet_dependency("html5ever", Level::Info));
        assert!(!is_quiet_dependency(
            "html5ever::tree_builder",
            Level::Error
        ));
        assert!(!is_quiet_dependency("html5everything", Level::Warn));
        assert!(!is_quiet_dependency(
            "haruspex::proxy::extract",
            Level::Warn
        ));
    }

    #[test]
    fn debug_lines_append_and_rotate_past_the_cap() {
        let dir = crate::test_util::temp_dir("debuglog");
        let path = dir.join(DEBUG_LOG_FILE);
        append_debug_lines(&path, &["one".into(), "two".into()], &[], 1024).unwrap();
        append_debug_lines(&path, &["three".into()], &[], 1024).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\nthree\n");
        // Over the cap: the next append starts a fresh file and keeps one old one.
        append_debug_lines(&path, &["four".into()], &[], 4).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "four\n");
        assert_eq!(
            std::fs::read_to_string(dir.join("agent-debug.log.1")).unwrap(),
            "one\ntwo\nthree\n"
        );
    }

    #[test]
    fn debug_lines_are_redacted() {
        let dir = crate::test_util::temp_dir("debuglog-redact");
        let path = dir.join(DEBUG_LOG_FILE);
        let lines = [
            "tool output: Authorization: Bearer abc123def456".to_string(),
            "the user pasted my-stored-key-value here".to_string(),
            "plain line".to_string(),
        ];
        append_debug_lines(&path, &lines, &["my-stored-key-value".into()], 1024).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("abc123def456"), "{text}");
        assert!(!text.contains("my-stored-key-value"), "{text}");
        assert!(text.contains("plain line"));
        assert_eq!(text.matches(crate::text_util::REDACTED).count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn debug_log_is_created_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::test_util::temp_dir("debuglog-mode");
        let path = dir.join(DEBUG_LOG_FILE);
        append_debug_lines(&path, &["one".into()], &[], 1024).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
