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

/// One piece of text as [`for_report`] leaves it.
pub(crate) fn redact_for_report(text: &str) -> String {
    for_report(vec![text.to_string()]).remove(0)
}

/// Log lines made fit for a public issue: anything credential-shaped and
/// every secret read this session ([`crate::text_util::redact_secrets`]),
/// the home folder, which names the user, phone numbers, URL query strings,
/// which carry signed links and tokens under any name, and email addresses.
fn for_report(lines: Vec<String>) -> Vec<String> {
    let known = crate::secrets::known_values();
    let home = home_dir();
    lines
        .into_iter()
        .map(|line| {
            let line = crate::text_util::redact_secrets(&line, &known);
            let line = replace_home(&line, home.as_deref());
            scrub_line(&redact_phones(&line))
        })
        .collect()
}

/// The user's home directory: $HOME on Unix, %USERPROFILE% on Windows.
fn home_dir() -> Option<String> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var(key).ok()
}

/// `line` with the home folder written as `~`, in every spelling a log or a
/// JSON string gives it: as is, with forward slashes, and with `\\` escapes.
/// Only where the path ends, so `/home/tim` leaves `/home/timothy` alone.
fn replace_home(line: &str, home: Option<&str>) -> String {
    let Some(home) = home.map(|h| h.trim_end_matches(['/', '\\'])) else {
        return line.to_string();
    };
    if home.len() < 3 {
        return line.to_string();
    }
    let mut out = line.to_string();
    for form in [
        home.to_string(),
        home.replace('\\', "/"),
        home.replace('\\', "\\\\"),
    ] {
        out = replace_path_prefix(&out, &form);
    }
    out
}

fn replace_path_prefix(line: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(i) = rest.find(prefix) {
        let after = &rest[i + prefix.len()..];
        let ends = after
            .chars()
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || "_-.".contains(c)));
        out.push_str(&rest[..i]);
        out.push_str(if ends { "~" } else { prefix });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// `line` with each phone number written as `<phone>`. Three shapes, kept
/// narrow so dates, times, IP addresses and sizes pass: an international
/// number (`+` and 8 to 15 digits), a North American one (`555-123-4567`,
/// `(555) 123 4567`, an optional leading `1`), and a national one that
/// starts with a 0 (`020 7946 0958`, `0412 345 678`).
fn redact_phones(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        let starts = matches!(bytes[i], b'+' | b'(' | b'0'..=b'9')
            && (i == 0 || {
                // A `+` may follow `tel:`; a bare figure may not follow
                // anything that joins it to a word, a path or a time.
                let prev = bytes[i - 1];
                let joins: &[u8] = if bytes[i] == b'+' {
                    b""
                } else {
                    b"._-/\\:+@#$%&="
                };
                !(prev.is_ascii_alphanumeric() || joins.contains(&prev))
            });
        if let Some(end) = starts.then(|| phone_at(bytes, i)).flatten() {
            out.push_str(&line[copied..i]);
            out.push_str("<phone>");
            copied = end;
            i = end;
        } else {
            i += 1;
        }
    }
    out.push_str(&line[copied..]);
    out
}

/// Where a phone number that begins at `start` ends, if one does.
fn phone_at(bytes: &[u8], start: usize) -> Option<usize> {
    let plus = bytes[start] == b'+';
    let mut i = start + usize::from(plus);
    // Digit groups, each with the offset just past it. One group may be an
    // area code in brackets: `(555) 123-4567`, `+44 (20) 7946 0958`.
    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut bracketed = false;
    loop {
        let open = bytes.get(i) == Some(&b'(');
        if open && bracketed {
            break;
        }
        let from = i + usize::from(open);
        let len = bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        let mut end = from + len;
        if open {
            if bytes.get(end) != Some(&b')') || !(2..=4).contains(&len) {
                break;
            }
            bracketed = true;
            end += 1;
        } else if len == 0 {
            break;
        }
        groups.push((len, end));
        i = end;
        match (bytes.get(i), bytes.get(i + 1)) {
            (Some(b' ' | b'-' | b'.'), Some(d)) if d.is_ascii_digit() || *d == b'(' => i += 1,
            _ if open && bytes.get(i).is_some_and(u8::is_ascii_digit) => {}
            _ => break,
        }
    }
    if groups.is_empty() {
        return None;
    }
    // The longest run of groups that makes a number, so one followed by
    // another figure ("555 123 4567 3 times") is still found.
    for k in (1..=groups.len()).rev() {
        let (_, end) = groups[k - 1];
        if bytes.get(end).is_some_and(|b| b.is_ascii_alphanumeric()) {
            continue;
        }
        let lens: Vec<usize> = groups[..k].iter().map(|g| g.0).collect();
        let digits: usize = lens.iter().sum();
        let national = bytes[start] == b'0' && lens[0] >= 3 && (10..=11).contains(&digits);
        let american = matches!(lens.as_slice(), [3, 3, 4])
            || (matches!(lens.as_slice(), [1, 3, 3, 4]) && bytes[start] == b'1');
        let found = if plus {
            (8..=15).contains(&digits)
        } else {
            american || national
        };
        if found {
            return Some(end);
        }
    }
    None
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
        return crate::text_util::url_without_query(word);
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

/// Where a file for an issue is saved without asking: Downloads, or the home
/// folder when there is none. No save dialog, since GTK's file chooser once
/// crashed the app in glycin while loading thumbnails (2026-10-26).
pub(crate) fn downloads_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("no Downloads or home folder: {e}"))
}

/// `dir/stem.ext`, or `stem-2.ext` and so on when that is taken.
pub(crate) fn unique_path(dir: &std::path::Path, stem: &str, ext: &str) -> std::path::PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{stem}-{n}.{ext}")))
        .find(|p| !p.exists())
        .expect("an unused name")
}

/// Save `contents` into Downloads as `stem.extension`, never over an earlier
/// file. Returns the path. The diagnostics bundle a Report issue button
/// leaves for the user to drag onto the issue.
#[tauri::command]
pub async fn feedback_save_download(
    app: tauri::AppHandle,
    stem: String,
    extension: String,
    contents: String,
) -> Result<String, String> {
    if stem.contains(['/', '\\']) || extension.contains(['/', '\\', '.']) {
        return Err("a file name, not a path".into());
    }
    let dir = downloads_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let path = unique_path(&dir, &stem, &extension);
        std::fs::write(&path, contents)
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("saving the file panicked: {e}"))?
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
    fn a_phone_number_is_removed_and_other_figures_are_not() {
        let cases = [
            ("call +1 555 123 4567 now", "call <phone> now"),
            ("tel:+447700900123", "tel:<phone>"),
            ("+44 (20) 7946 0958", "<phone>"),
            ("ring 555-123-4567.", "ring <phone>."),
            ("ring (555) 123-4567,", "ring <phone>,"),
            ("1 555 123 4567 or 555.123.4567", "<phone> or <phone>"),
            ("mobile 0412 345 678", "mobile <phone>"),
            ("office 020 7946 0958", "office <phone>"),
            ("555 123 4567 3 times", "<phone> 3 times"),
            (
                "2026-10-26 12:34:56 run 01-02-2026 12 ok",
                "2026-10-26 12:34:56 run 01-02-2026 12 ok",
            ),
            (
                "127.0.0.1:8765 and 192.168.100.200",
                "127.0.0.1:8765 and 192.168.100.200",
            ),
            (
                "took (12 ms), 1 234 567 bytes",
                "took (12 ms), 1 234 567 bytes",
            ),
            ("at 12:00 +0100, v1.2.3", "at 12:00 +0100, v1.2.3"),
            (
                "id-555-123-4567 abc5551234567",
                "id-555-123-4567 abc5551234567",
            ),
            ("1700000000123 ms", "1700000000123 ms"),
        ];
        for (input, want) in cases {
            assert_eq!(redact_phones(input), want, "{input}");
        }
    }

    #[test]
    fn the_home_folder_becomes_a_tilde_in_every_spelling() {
        let unix = Some("/home/tim");
        assert_eq!(
            replace_home("read /home/tim/notes.md and /home/tim", unix),
            "read ~/notes.md and ~"
        );
        assert_eq!(
            replace_home("/home/timothy/x and \"/home/tim\"", unix),
            "/home/timothy/x and \"~\""
        );
        let windows = Some(r"C:\Users\tim");
        assert_eq!(
            replace_home(
                r#"C:\Users\tim\a, C:/Users/tim/b, "C:\\Users\\tim\\c""#,
                windows
            ),
            r#"~\a, ~/b, "~\\c""#
        );
        assert_eq!(replace_home("/ stays", Some("/")), "/ stays");
        assert_eq!(replace_home("no home", None), "no home");
    }

    #[test]
    fn a_saved_file_never_overwrites_an_earlier_one() {
        let tmp = tempfile::tempdir().unwrap();
        let first = unique_path(tmp.path(), "f", "md");
        assert_eq!(first.file_name().unwrap(), "f.md");
        std::fs::write(&first, "").unwrap();
        std::fs::write(tmp.path().join("f-2.md"), "").unwrap();
        assert_eq!(
            unique_path(tmp.path(), "f", "md").file_name().unwrap(),
            "f-3.md"
        );
    }

    #[test]
    fn a_secret_read_this_session_is_blanked_wherever_it_appears() {
        crate::secrets::seed_for_test("apikey:test-report", "plain-looking-value-42");
        let out = feedback_redact(vec!["sent plain-looking-value-42 upstream".into()]);
        assert_eq!(out, vec!["sent [redacted] upstream".to_string()]);
    }
}
