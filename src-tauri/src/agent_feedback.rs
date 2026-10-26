//! The model's own notes on Haruspex's tools, from `haruspex_feedback` and
//! the end-of-job reflection (Settings → Feedback → Model feedback on tools).
//!
//! One JSON object per line in `<app data>/agent_feedback/YYYY-MM.jsonl`. The
//! frontend builds the entry; this stamps when, which build and which OS.
//! Settings → Feedback lists them (`agent_feedback_list`), exports them as a
//! redacted zip for a GitHub issue (`agent_feedback_export`), and clears them.

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::Manager;

const DIR_NAME: &str = "agent_feedback";

fn feedback_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(DIR_NAME))
        .map_err(|e| format!("no app data dir: {e}"))
}

/// `entry` with the time, app version and OS added, as one line of JSON.
fn stamped_line(mut entry: serde_json::Value, now: chrono::DateTime<chrono::Utc>) -> String {
    if let Some(obj) = entry.as_object_mut() {
        obj.insert("recorded_at".into(), now.to_rfc3339().into());
        obj.insert("app_version".into(), env!("CARGO_PKG_VERSION").into());
        obj.insert("os".into(), std::env::consts::OS.into());
    }
    entry.to_string()
}

fn append_line(
    dir: &Path,
    line: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{}.jsonl", now.format("%Y-%m")));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    writeln!(file, "{line}").map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(path)
}

/// Append one report. Returns the file it went into.
#[tauri::command]
pub async fn agent_feedback_append(
    app: tauri::AppHandle,
    entry: serde_json::Value,
) -> Result<String, String> {
    if !entry.is_object() {
        return Err("a feedback entry must be a JSON object".into());
    }
    let dir = feedback_dir(&app)?;
    let now = chrono::Utc::now();
    let line = stamped_line(entry, now);
    tokio::task::spawn_blocking(move || append_line(&dir, &line, now))
        .await
        .map_err(|e| format!("feedback write panicked: {e}"))?
        .map(|p| p.to_string_lossy().into_owned())
}

/// The folder the reports go into, created so Open folder has somewhere to go.
#[tauri::command]
pub fn agent_feedback_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = feedback_dir(&app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// The report files, oldest month first.
fn report_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();
    files
}

/// Every report, newest first. A line that isn't a JSON object is skipped:
/// one bad write should not hide the rest.
fn read_reports(dir: &Path) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = report_files(dir)
        .iter()
        .filter_map(|f| std::fs::read_to_string(f).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
                .filter(serde_json::Value::is_object)
                .collect::<Vec<_>>()
        })
        .collect();
    out.reverse();
    out
}

/// Every report, newest first.
#[tauri::command]
pub async fn agent_feedback_list(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = feedback_dir(&app)?;
    tokio::task::spawn_blocking(move || read_reports(&dir))
        .await
        .map_err(|e| format!("reading feedback panicked: {e}"))
}

/// Every string in `value` redacted as the diagnostics bundle is: secrets read
/// this session, URL query strings and email addresses. Done on the parsed
/// value, because in a JSON line a result's newlines are `\n` and the redactor
/// works word by word.
fn redact_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => *s = crate::feedback::redact_for_report(s),
        serde_json::Value::Array(items) => items.iter_mut().for_each(redact_value),
        serde_json::Value::Object(map) => map.values_mut().for_each(redact_value),
        _ => {}
    }
}

/// The zip a user attaches to an issue: `summary.md` and `reports`, redacted,
/// one per line as `reports.jsonl`. Both come from the viewer, so a filtered
/// list shares only what was shown.
fn write_export(
    out: &Path,
    summary: &str,
    reports: Vec<serde_json::Value>,
) -> Result<usize, String> {
    use zip::write::SimpleFileOptions;
    let count = reports.len();
    let summary = crate::feedback::redact_for_report(summary);
    let mut lines = String::new();
    for mut r in reports {
        redact_value(&mut r);
        lines.push_str(&r.to_string());
        lines.push('\n');
    }
    let file = std::fs::File::create(out)
        .map_err(|e| format!("could not create {}: {e}", out.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, body) in [
        ("summary.md", summary.as_str()),
        ("reports.jsonl", lines.as_str()),
    ] {
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(count)
}

/// A saved export: where it went and how many reports it holds.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct AgentFeedbackExport {
    pub path: String,
    #[ts(type = "number")]
    pub count: usize,
}

/// Write the redacted zip into Downloads (see `feedback::downloads_dir`).
#[tauri::command]
pub async fn agent_feedback_export(
    app: tauri::AppHandle,
    summary: String,
    reports: Vec<serde_json::Value>,
) -> Result<AgentFeedbackExport, String> {
    let dir = crate::feedback::downloads_dir(&app)?;
    let stem = format!(
        "haruspex-model-feedback-{}",
        chrono::Local::now().format("%Y-%m-%d")
    );
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let out = crate::feedback::unique_path(&dir, &stem, "zip");
        let count = write_export(&out, &summary, reports)?;
        Ok(AgentFeedbackExport {
            path: out.to_string_lossy().into_owned(),
            count,
        })
    })
    .await
    .map_err(|e| format!("feedback export panicked: {e}"))?
}

/// Delete every report. The user confirms first, in Settings → Feedback.
#[tauri::command]
pub async fn agent_feedback_clear(app: tauri::AppHandle) -> Result<(), String> {
    let dir = feedback_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        for f in report_files(&dir) {
            std::fs::remove_file(&f)
                .map_err(|e| format!("could not delete {}: {e}", f.display()))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("clearing feedback panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn an_entry_is_stamped_and_lands_in_its_months_file() {
        let tmp = tempfile::tempdir().unwrap();
        let now = chrono::Utc
            .with_ymd_and_hms(2026, 10, 26, 12, 0, 0)
            .unwrap();
        let line = stamped_line(serde_json::json!({ "tool": "fs_read_text" }), now);
        let path = append_line(tmp.path(), &line, now).unwrap();
        append_line(tmp.path(), &line, now).unwrap();
        assert_eq!(path.file_name().unwrap(), "2026-10.jsonl");
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let v: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(v["tool"], "fs_read_text");
        assert_eq!(v["recorded_at"], "2026-10-26T12:00:00+00:00");
        assert_eq!(v["app_version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn reports_are_listed_newest_first_across_months_skipping_bad_lines() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("2026-09.jsonl"), "{\"n\":1}\nnot json\n").unwrap();
        std::fs::write(
            tmp.path().join("2026-10.jsonl"),
            "{\"n\":2}\n[3]\n{\"n\":4}\n",
        )
        .unwrap();
        std::fs::write(tmp.path().join("notes.txt"), "{\"n\":9}\n").unwrap();
        let n: Vec<i64> = read_reports(tmp.path())
            .iter()
            .map(|v| v["n"].as_i64().unwrap())
            .collect();
        assert_eq!(n, vec![4, 2, 1]);
    }

    #[test]
    fn the_export_is_a_zip_of_the_summary_and_the_redacted_reports() {
        let tmp = tempfile::tempdir().unwrap();
        let report = serde_json::json!({
            "tool": "fetch_url",
            "trace": [{ "result": "line one\nsee https://a.test/x?token=abc and mail me@example.com" }]
        });
        let out = tmp.path().join("out.zip");
        let summary = "# Summary\nfrom you@example.com";
        assert_eq!(write_export(&out, summary, vec![report]).unwrap(), 1);

        let mut zip = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let mut summary = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("summary.md").unwrap(), &mut summary)
            .unwrap();
        assert_eq!(summary, "# Summary\nfrom <email>");
        let mut lines = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("reports.jsonl").unwrap(), &mut lines)
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(lines.trim()).unwrap();
        let result = v["trace"][0]["result"].as_str().unwrap();
        assert!(result.contains("https://a.test/x"), "{result}");
        assert!(!result.contains("token=abc"), "{result}");
        assert!(!result.contains("me@example.com"), "{result}");
    }

    #[test]
    fn clearing_leaves_other_files_alone() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("2026-10.jsonl"), "{}\n").unwrap();
        std::fs::write(tmp.path().join("keep.txt"), "x").unwrap();
        for f in report_files(tmp.path()) {
            std::fs::remove_file(f).unwrap();
        }
        assert!(read_reports(tmp.path()).is_empty());
        assert!(tmp.path().join("keep.txt").exists());
    }
}
