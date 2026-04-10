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

impl Log for AppLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= self.level
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

/// Minimal timestamp without pulling in the chrono crate.
/// Format: YYYY-MM-DD HH:MM:SS in local time.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Naive epoch → Y/M/D/H/M/S conversion (UTC). Close enough for a log
    // timestamp; we don't want to pull chrono just for this.
    let days = secs / 86_400;
    let time_of_day = secs % 86_400;
    let h = time_of_day / 3600;
    let m = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;

    // Days from 1970-01-01 → Y/M/D
    let (y, mo, d) = days_to_ymd(days as i64);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, m, s)
}

fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    // Howard Hinnant's date algorithm, simplified.
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (y, m, d)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_to_ymd_epoch() {
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
    }

    #[test]
    fn days_to_ymd_2020_leap() {
        // 2020-02-29 is day 18321 from 1970-01-01
        assert_eq!(days_to_ymd(18321), (2020, 2, 29));
    }

    #[test]
    fn days_to_ymd_2024_01_01() {
        // 2024-01-01 is day 19723
        assert_eq!(days_to_ymd(19723), (2024, 1, 1));
    }

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
}
