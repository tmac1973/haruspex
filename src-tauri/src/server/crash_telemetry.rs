//! Crash telemetry for the llama-server sidecar.
//!
//! llama-server occasionally dies abnormally (a GGML_ASSERT abort, an OOM, or
//! an outright SIGSEGV from the GPU backend). Those failures leave nothing
//! behind: the in-memory log ring buffers are lost on the next app restart and
//! the OS core dump (if any) is far too large to keep. This module captures a
//! small, persistent post-mortem instead — the exit signal/code, how long the
//! process had been up, the active config, and the last handful of stderr lines
//! (which is where llama.cpp prints the actual abort reason) — and appends it to
//! a size-capped `llama-crashes.log` in the app log directory.
//!
//! It deliberately does NOT touch the core dump file itself.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use log::{error, warn};
use tauri::{AppHandle, Manager};

/// Cap the crash log so it can't grow without bound. When it crosses this it's
/// rotated to `<name>.1` (single generation) and a fresh file is started.
const MAX_LOG_BYTES: u64 = 512 * 1024;

/// How many trailing log lines to keep with each crash record. llama.cpp prints
/// the assert / backend error in the last few lines before aborting, so a small
/// tail is almost always enough to see the cause.
pub const TAIL_LINES: usize = 60;

const CRASH_LOG_NAME: &str = "llama-crashes.log";

/// Everything we know about one abnormal llama-server exit.
pub struct CrashReport {
    pub generation: u64,
    /// Exit code, if the process exited normally with one.
    pub code: Option<i32>,
    /// Terminating signal, if it was killed by one (the core-dump indicator).
    pub signal: Option<i32>,
    /// Server status immediately before the exit (e.g. `Starting` vs `Ready`),
    /// which tells us whether it died during model load or mid-request.
    pub status_before: String,
    pub model_path: String,
    pub n_gpu_layers: i32,
    pub ctx_size: u32,
    pub flash_attn: bool,
    pub cpu_fallback_active: bool,
    /// Seconds the process had been running, if known.
    pub uptime_secs: Option<u64>,
    /// Tail of the sidecar log ring buffer (oldest first).
    pub recent_log: Vec<String>,
}

/// Human-readable name for the common terminating signals. Numbers 1–15 (minus
/// the two that differ across platforms) are identical on Linux and macOS.
pub fn signal_name(sig: i32) -> &'static str {
    match sig {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        15 => "SIGTERM",
        #[cfg(not(target_os = "macos"))]
        7 => "SIGBUS",
        #[cfg(target_os = "macos")]
        10 => "SIGBUS",
        _ => "signal",
    }
}

/// Whether a signal represents an abnormal, core-dumping crash (as opposed to a
/// clean/external stop like SIGTERM/SIGKILL/SIGINT that we or the user sent).
pub fn is_crash_signal(sig: i32) -> bool {
    match sig {
        // SIGILL, SIGTRAP, SIGABRT, SIGFPE, SIGSEGV — same numbers everywhere.
        4 | 5 | 6 | 8 | 11 => true,
        #[cfg(not(target_os = "macos"))]
        7 => true, // SIGBUS (Linux)
        #[cfg(target_os = "macos")]
        10 => true, // SIGBUS (macOS)
        _ => false,
    }
}

/// Pull the single most diagnostic line out of the tail (searching newest
/// first) so the one-line summary points at the actual cause.
fn highlight(lines: &[String]) -> Option<String> {
    const MARKERS: &[&str] = &[
        "GGML_ASSERT",
        "assert",
        "CUDA error",
        "cudaError",
        "vk::",
        "vulkan",
        "out of memory",
        "failed to allocate",
        "terminate called",
        "Segmentation",
        "abort",
        "error",
    ];
    lines.iter().rev().find_map(|l| {
        let lower = l.to_lowercase();
        if MARKERS.iter().any(|m| lower.contains(&m.to_lowercase())) {
            Some(l.trim().to_string())
        } else {
            None
        }
    })
}

fn crash_log_dir(app: &AppHandle) -> Option<PathBuf> {
    // Prefer the platform log dir; fall back to the app data dir. Both are
    // user-discoverable and survive a sidecar crash (the main app keeps running).
    app.path()
        .app_log_dir()
        .or_else(|_| app.path().app_data_dir())
        .ok()
}

/// Absolute path to the crash log, creating the parent directory if needed.
pub fn crash_log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = crash_log_dir(app)?;
    if fs::create_dir_all(&dir).is_err() {
        return None;
    }
    Some(dir.join(CRASH_LOG_NAME))
}

/// Append a crash report to the on-disk log and emit a one-line summary into the
/// app log so it's visible immediately in the App log tab. Best-effort: any I/O
/// failure is logged and swallowed (telemetry must never destabilise the app).
pub fn record(app: &AppHandle, report: &CrashReport) {
    let sig_desc = match report.signal {
        Some(s) => format!("signal {} ({})", s, signal_name(s)),
        None => "no signal".to_string(),
    };
    let code_desc = match report.code {
        Some(c) => c.to_string(),
        None => "none".to_string(),
    };
    let uptime_desc = match report.uptime_secs {
        Some(s) => format!("{}s", s),
        None => "unknown".to_string(),
    };
    let hint = highlight(&report.recent_log);

    // One-line summary for the in-app log (must NOT start with the sidecar
    // passthrough prefixes or app_log would filter it out of the App tab).
    error!(
        "llama-server CRASH — {} (exit code {}), up {}, status {}, ngl {}{}",
        sig_desc,
        code_desc,
        uptime_desc,
        report.status_before,
        report.n_gpu_layers,
        hint.as_ref()
            .map(|h| format!(" — {}", h))
            .unwrap_or_default(),
    );

    let path = match crash_log_path(app) {
        Some(p) => p,
        None => {
            warn!("crash telemetry: could not resolve a writable log directory");
            return;
        }
    };

    // Rotate if the file got large, keeping one previous generation.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = fs::rename(&path, path.with_extension("log.1"));
        }
    }

    let mut block = String::new();
    block.push_str(&format!("===== {} =====\n", crate::app_log::timestamp()));
    block.push_str(&format!("generation : {}\n", report.generation));
    block.push_str(&format!("signal     : {}\n", sig_desc));
    block.push_str(&format!("exit code  : {}\n", code_desc));
    block.push_str(&format!(
        "core dump  : {}\n",
        report
            .signal
            .map(|s| if is_crash_signal(s) { "likely" } else { "no" })
            .unwrap_or("no")
    ));
    block.push_str(&format!("uptime     : {}\n", uptime_desc));
    block.push_str(&format!("status     : {}\n", report.status_before));
    block.push_str(&format!("model      : {}\n", report.model_path));
    block.push_str(&format!(
        "config     : n_gpu_layers={} ctx_size={} flash_attn={} cpu_fallback={}\n",
        report.n_gpu_layers, report.ctx_size, report.flash_attn, report.cpu_fallback_active
    ));
    if let Some(h) = &hint {
        block.push_str(&format!("likely cause: {}\n", h));
    }
    block.push_str("---- last log lines ----\n");
    for line in &report.recent_log {
        block.push_str(line);
        block.push('\n');
    }
    block.push('\n');

    match fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            if let Err(e) = f.write_all(block.as_bytes()) {
                warn!("crash telemetry: failed to write {}: {}", path.display(), e);
            } else {
                warn!("llama-server crash recorded to {}", path.display());
            }
        }
        Err(e) => warn!("crash telemetry: failed to open {}: {}", path.display(), e),
    }
}

/// Read the crash log back (for the UI). Returns an empty string if it doesn't
/// exist yet.
pub fn read(app: &AppHandle) -> String {
    crash_log_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .unwrap_or_default()
}

/// Delete the crash log (and its rotated generation).
pub fn clear(app: &AppHandle) {
    if let Some(p) = crash_log_path(app) {
        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(p.with_extension("log.1"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_signals_exclude_clean_stops() {
        // SIGSEGV / SIGABRT are crashes; SIGTERM / SIGKILL / SIGINT are not.
        assert!(is_crash_signal(11)); // SIGSEGV
        assert!(is_crash_signal(6)); // SIGABRT
        assert!(!is_crash_signal(15)); // SIGTERM
        assert!(!is_crash_signal(9)); // SIGKILL (our stop())
        assert!(!is_crash_signal(2)); // SIGINT
    }

    #[test]
    fn signal_names_cover_the_common_ones() {
        assert_eq!(signal_name(11), "SIGSEGV");
        assert_eq!(signal_name(6), "SIGABRT");
        assert_eq!(signal_name(9), "SIGKILL");
        assert_eq!(signal_name(999), "signal");
    }

    #[test]
    fn highlight_picks_the_most_recent_marker_line() {
        let lines = vec![
            "loading model".to_string(),
            "[stderr] GGML_ASSERT: kv cache failed".to_string(),
            "[stderr] some later noise".to_string(),
        ];
        // Newest-first scan: "noise" matches no marker, the assert line does.
        assert_eq!(
            highlight(&lines).as_deref(),
            Some("[stderr] GGML_ASSERT: kv cache failed")
        );
    }

    #[test]
    fn highlight_is_none_without_markers() {
        let lines = vec!["all good".to_string(), "still fine".to_string()];
        assert_eq!(highlight(&lines), None);
    }
}
