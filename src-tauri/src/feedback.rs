//! Diagnostics gathering for the in-app feedback button.
//!
//! Exposes two Tauri commands:
//!   - `get_diagnostics` — assembles a snapshot of OS/arch, app version,
//!     and the tail of the Rust-side logs: app, llama-server and its crash
//!     log, whisper, koko, the bundled image engine and ComfyUI. MCP
//!     servers' logs are gathered by the frontend, which knows their names. The frontend merges this with settings + the debug-log
//!     ring buffer and either composes a pre-filled GitHub issue URL or
//!     a full-bundle file for the "Save Full Diagnostics" path.
//!   - `feedback_redact` — the same redaction for the webview's own debug
//!     log, which Rust never sees otherwise.
//!   - `save_export_file` — one-shot UTF-8 write to an absolute
//!     path. Used after the user picks a destination via the save
//!     dialog — the diagnostics bundle and the job-run stats export.
//!     Kept separate from `fs_write_text` because that command is
//!     workdir-sandboxed; a user-chosen destination lands anywhere.

use serde::Serialize;

use crate::app_log;
use crate::db::Database;
use crate::proxy::stats::LifetimeStatsSnapshot;
use crate::proxy::stats::{SearchStats, SessionStatsSnapshot};
use crate::server::LlamaServer;
use crate::tts::TtsEngine;
use crate::whisper::WhisperServer;

#[derive(Serialize)]
pub struct DiagnosticsSearchStats {
    pub session: SessionStatsSnapshot,
    pub lifetime: LifetimeStatsSnapshot,
}

#[derive(Serialize)]
pub struct Diagnostics {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub appimage: bool,
    pub app_log: Vec<String>,
    pub llama_log: Vec<String>,
    pub whisper_log: Vec<String>,
    pub tts_log: Vec<String>,
    /// The persisted llama-server crash log, one entry per line.
    pub crash_log: Vec<String>,
    /// The bundled image engine (sd-server) and the ComfyUI call log.
    pub image_engine_log: Vec<String>,
    pub comfy_log: Vec<String>,
    pub search_stats: DiagnosticsSearchStats,
}

#[tauri::command]
pub async fn get_diagnostics(
    app: tauri::AppHandle,
    llama: tauri::State<'_, LlamaServer>,
    image_engine: tauri::State<'_, crate::image_engine::ImageEngine>,
    whisper: tauri::State<'_, WhisperServer>,
    tts: tauri::State<'_, TtsEngine>,
    search_stats: tauri::State<'_, SearchStats>,
    db: tauri::State<'_, Database>,
) -> Result<Diagnostics, ()> {
    let session = search_stats.snapshot();
    let lifetime = db.lifetime_stats_snapshot().unwrap_or_default();
    Ok(Diagnostics {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        appimage: std::env::var("APPDIR")
            .map(|v| !v.is_empty())
            .unwrap_or(false),
        app_log: for_report(app_log::get_logs()),
        llama_log: for_report(llama.get_logs().await),
        whisper_log: for_report(whisper.get_logs().await),
        tts_log: for_report(tts.get_logs().await),
        crash_log: for_report(
            crate::server::get_llama_crash_log(app)
                .lines()
                .map(str::to_string)
                .collect(),
        ),
        image_engine_log: for_report(image_engine.logs().await),
        comfy_log: for_report(crate::comfy::comfy_logs().await),
        search_stats: DiagnosticsSearchStats { session, lifetime },
    })
}

/// The webview's debug log, redacted as the Rust logs are for a report.
#[tauri::command]
pub fn feedback_redact(lines: Vec<String>) -> Vec<String> {
    for_report(lines)
}

/// Log lines made fit for a public issue: anything credential-shaped and
/// every secret read this session ([`crate::text_util::redact_secrets`]),
/// URL query strings, which carry signed links and tokens under any name,
/// and email addresses.
/// One piece of text as [`for_report`] leaves it.
pub(crate) fn redact_for_report(text: &str) -> String {
    for_report(vec![text.to_string()]).remove(0)
}

fn for_report(lines: Vec<String>) -> Vec<String> {
    let known = crate::secrets::known_values();
    lines
        .into_iter()
        .map(|line| scrub_line(&crate::text_util::redact_secrets(&line, &known)))
        .collect()
}

fn scrub_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    for piece in line.split_inclusive(char::is_whitespace) {
        let word = piece.trim_end_matches(char::is_whitespace);
        let space = &piece[word.len()..];
        out.push_str(&scrub_word(word));
        out.push_str(space);
    }
    out
}

fn scrub_word(word: &str) -> String {
    if word.contains("://") {
        // A URL: everything from `?` or `#` to the end of the URL.
        let start = word.find("://").unwrap();
        let end = word[start..]
            .find(['"', '\'', ')', ']', '>', ','])
            .map_or(word.len(), |i| start + i);
        if let Some(q) = word[start..end].find(['?', '#']) {
            let q = start + q;
            return format!("{}{}", &word[..q], &word[end..]);
        }
        return word.to_string();
    }
    let bare = word.trim_matches(|c: char| "\"'`,;:()[]{}<>".contains(c));
    if looks_like_email(bare) {
        return word.replacen(bare, "<email>", 1);
    }
    word.to_string()
}

fn looks_like_email(s: &str) -> bool {
    let Some((user, domain)) = s.split_once('@') else {
        return false;
    };
    !user.is_empty()
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._%+-".contains(c))
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c))
}

#[tauri::command]
pub async fn save_export_file(path: String, contents: String) -> Result<(), String> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_line_keeps_what_diagnoses_and_drops_what_identifies() {
        let cases = [
            (
                "GET https://cdn.example.com/a.png?X-Amz-Signature=abc123&exp=9 failed",
                "GET https://cdn.example.com/a.png failed",
            ),
            (
                "fetch (\"https://x.example/p#frag\") ok",
                "fetch (\"https://x.example/p\") ok",
            ),
            (
                "IMAP login as me@example.com refused",
                "IMAP login as <email> refused",
            ),
            ("to: <a.b+c@mail.example.org>,", "to: <<email>>,"),
            ("paired hsx_0123456789abcdef0123", "paired [redacted]"),
            (
                "tool end: fs_read_text (12 ms)",
                "tool end: fs_read_text (12 ms)",
            ),
            ("ref main@{1} and x@y", "ref main@{1} and x@y"),
        ];
        for (input, want) in cases {
            assert_eq!(for_report(vec![input.to_string()]), vec![want.to_string()]);
        }
    }

    #[test]
    fn a_secret_read_this_session_is_blanked_wherever_it_appears() {
        crate::secrets::seed_for_test("apikey:test-report", "plain-looking-value-42");
        let out = feedback_redact(vec!["sent plain-looking-value-42 upstream".into()]);
        assert_eq!(out, vec!["sent [redacted] upstream".to_string()]);
    }
}
