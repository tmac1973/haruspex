//! Rows for the background-task registry (`crate::tasks`). Progress fields
//! are memory-only, so a row holds what a restart needs: what the task is,
//! where it got to, and whether its owner has heard.

use super::*;
use crate::tasks::BackgroundTask;
use rusqlite::params;

/// An enum as its serde name: `"video_render"`, `"running"`, `"rust"`.
fn name<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// The enum a serde name stands for.
fn parse<T: serde::de::DeserializeOwned>(s: String) -> Result<T, String> {
    serde_json::from_value(serde_json::Value::String(s.clone()))
        .map_err(|_| format!("unknown task value {s}"))
}

fn json_text(v: &Option<serde_json::Value>) -> Option<String> {
    v.as_ref().map(|v| v.to_string())
}

fn json_value(s: Option<String>) -> Option<serde_json::Value> {
    s.and_then(|s| serde_json::from_str(&s).ok())
}

impl Database {
    /// Insert a task, or replace the row it already has.
    pub fn save_task(&self, t: &BackgroundTask) -> Result<(), String> {
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO background_tasks
                 (id, kind, owner, label, state, follower, spec, handle, result, error,
                  log_tail, started_ms, ended_ms, notice_delivered)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    t.id,
                    name(&t.kind),
                    t.owner,
                    t.label,
                    name(&t.state),
                    name(&t.follower),
                    t.spec.to_string(),
                    json_text(&t.handle),
                    json_text(&t.result),
                    t.error,
                    t.log_tail,
                    t.started_ms as i64,
                    t.ended_ms.map(|m| m as i64),
                    t.notice_delivered as i64,
                ],
            )
            .map_err(|e| format!("Task save failed: {e}"))?;
        Ok(())
    }

    /// Every task, oldest first. A row that no longer parses is skipped.
    pub fn load_tasks(&self) -> Result<Vec<BackgroundTask>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, owner, label, state, follower, spec, handle, result, error,
                        log_tail, started_ms, ended_ms, notice_delivered
                 FROM background_tasks ORDER BY started_ms",
            )
            .map_err(|e| format!("Query failed: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                    row.get::<_, i64>(13)?,
                ))
            })
            .map_err(|e| format!("Query failed: {e}"))?;
        let mut tasks = Vec::new();
        for row in rows {
            let (
                id,
                kind,
                owner,
                label,
                state,
                follower,
                spec,
                handle,
                result,
                error,
                log_tail,
                started,
                ended,
                delivered,
            ) = row.map_err(|e| format!("Row read failed: {e}"))?;
            let parsed = (|| -> Result<BackgroundTask, String> {
                Ok(BackgroundTask {
                    id: id.clone(),
                    kind: parse(kind)?,
                    owner,
                    label,
                    state: parse(state)?,
                    follower: parse(follower)?,
                    percent: None,
                    eta_secs: None,
                    phase: None,
                    queue_position: None,
                    spec: serde_json::from_str(&spec).unwrap_or(serde_json::Value::Null),
                    handle: json_value(handle),
                    result: json_value(result),
                    error,
                    log_tail,
                    started_ms: started.max(0) as u64,
                    ended_ms: ended.map(|m| m.max(0) as u64),
                    notice_delivered: delivered != 0,
                })
            })();
            match parsed {
                Ok(t) => tasks.push(t),
                Err(e) => log::warn!("skipping background task {id}: {e}"),
            }
        }
        Ok(tasks)
    }

    pub fn delete_task(&self, id: &str) -> Result<(), String> {
        self.conn()
            .execute("DELETE FROM background_tasks WHERE id = ?1", params![id])
            .map_err(|e| format!("Task delete failed: {e}"))?;
        Ok(())
    }

    pub fn delete_tasks_for_owner(&self, owner: &str) -> Result<(), String> {
        self.conn()
            .execute(
                "DELETE FROM background_tasks WHERE owner = ?1",
                params![owner],
            )
            .map_err(|e| format!("Task delete failed: {e}"))?;
        Ok(())
    }
}
