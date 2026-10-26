//! The model's own notes on Haruspex's tools, from `haruspex_feedback` and
//! the end-of-job reflection (Settings → Feedback → Model feedback on tools).
//!
//! One JSON object per line in `<app data>/agent_feedback/YYYY-MM.jsonl`, so a
//! month's reports can be read with `grep` or `scripts/agent-feedback.mjs`.
//! The frontend builds the entry; this stamps when, which build and which OS.

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
}
