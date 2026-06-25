//! SQLite persistence for conversations, search stats, jobs, and job runs.
//!
//! Split by domain: this module owns the shared types, the `Database`
//! handle, schema migration, and the small `chrono_now` helper. The
//! per-domain method impls live in sibling files (`conversations`,
//! `stats`, `jobs`, `runs`), the Tauri command wrappers in `commands`,
//! and the test suite in `tests`. All are children of this module, so
//! they share access to the private `conn` field.

use log::info;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Deserialize)]
pub struct MessageInput {
    pub role: String,
    pub content: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub steps: Option<String>,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DbMessage {
    #[ts(type = "number")]
    pub id: i64,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub sort_order: i64,
    /// JSON-serialized SearchStep[] captured for this assistant message.
    /// Holds image artifact data URLs + thumbDataUrl + HTML artifact
    /// bodies so the chat can re-render inline plots / DataFrames after
    /// app restart. Null for non-assistant rows.
    pub steps: Option<String>,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ConversationWithMessages {
    pub id: String,
    pub title: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    pub messages: Vec<DbMessage>,
}

#[derive(Clone, Debug, Serialize)]
pub struct JobStep {
    pub id: i64,
    pub ordering: i64,
    pub prompt: String,
    pub deep_research: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct JobStepInput {
    pub prompt: String,
    pub deep_research: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct JobSummary {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub working_dir: String,
    pub auto_approve_tools: bool,
    /// `'research'` (the default, sequential-step pipeline) or `'audit'`
    /// (run one prompt N times, then cluster + verify into a meta-report).
    pub job_type: String,
    pub schedule_kind: String,
    pub schedule_config: Option<String>,
    pub next_due_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub step_count: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct JobWithSteps {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub working_dir: String,
    pub auto_approve_tools: bool,
    pub job_type: String,
    pub schedule_kind: String,
    pub schedule_config: Option<String>,
    pub next_due_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub steps: Vec<JobStep>,
    // Audit-job config (ignored when job_type != 'audit'). The audit prompt
    // itself reuses the single job_steps row.
    /// How many independent sample runs to execute.
    pub audit_num_runs: Option<i64>,
    /// File the final meta-report is written to (relative to working_dir).
    pub audit_output_file: Option<String>,
    /// Run sample + verification turns with a read-only tool subset.
    pub audit_read_only: bool,
    /// Per-sample agent-loop turn budget. NULL = runner default. The bigger
    /// the codebase, the more grep/read turns a thorough audit needs.
    pub audit_max_iterations: Option<i64>,
    /// Custom sample-run instructions (appended to the audit prompt). NULL = default.
    pub audit_sample_instructions: Option<String>,
    /// Custom verification rubric. NULL = default.
    pub audit_verify_instructions: Option<String>,
    // Per-job remote model override (applies to every job type). When
    // `model_remote_base_url` is non-empty the job's model calls route to this
    // remote server/model instead of the global Settings backend. NULL/empty =
    // use Settings. Remote-only by design — local jobs follow Settings.
    /// Remote base URL (no trailing slash, no /v1). Empty/NULL = use Settings.
    pub model_remote_base_url: Option<String>,
    /// Optional Bearer token for the override server.
    pub model_remote_api_key: Option<String>,
    /// Model ID sent to the override server.
    pub model_remote_model_id: Option<String>,
    /// Context window (tokens/request) of the override model, for budget +
    /// compaction math. NULL = fall back to the global active context size.
    pub model_remote_context_size: Option<i64>,
    /// Whether the override model accepts image input. NULL = inherit the
    /// global Settings vision capability; Some(false) hides vision tools.
    pub model_remote_vision_supported: Option<bool>,
}

fn default_job_type() -> String {
    "research".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
pub struct JobInput {
    pub name: String,
    pub description: Option<String>,
    pub working_dir: String,
    pub auto_approve_tools: bool,
    #[serde(default = "default_job_type")]
    pub job_type: String,
    pub schedule_kind: String,
    pub schedule_config: Option<String>,
    /// Pre-computed unix ms when this job is next due. The frontend
    /// (jobs store) owns the date math so we don't need chrono on the
    /// Rust side. NULL for `manual` schedules.
    #[serde(default)]
    pub next_due_at: Option<i64>,
    #[serde(default)]
    pub audit_num_runs: Option<i64>,
    #[serde(default)]
    pub audit_output_file: Option<String>,
    #[serde(default = "default_true")]
    pub audit_read_only: bool,
    #[serde(default)]
    pub audit_max_iterations: Option<i64>,
    #[serde(default)]
    pub audit_sample_instructions: Option<String>,
    #[serde(default)]
    pub audit_verify_instructions: Option<String>,
    #[serde(default)]
    pub model_remote_base_url: Option<String>,
    #[serde(default)]
    pub model_remote_api_key: Option<String>,
    #[serde(default)]
    pub model_remote_model_id: Option<String>,
    #[serde(default)]
    pub model_remote_context_size: Option<i64>,
    #[serde(default)]
    pub model_remote_vision_supported: Option<bool>,
}

/// A user-saved catalog prompt. `scope` is "audit" | "research" | "any".
#[derive(Clone, Debug, Serialize)]
pub struct SavedPrompt {
    pub id: i64,
    pub name: String,
    pub scope: String,
    pub prompt: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SavedPromptInput {
    pub name: String,
    pub scope: String,
    pub prompt: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct JobRunSummary {
    pub id: i64,
    pub job_id: i64,
    pub status: String,
    pub trigger: String,
    pub queued_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct JobRunStep {
    pub id: i64,
    pub run_id: i64,
    pub ordering: i64,
    pub prompt_authored: String,
    pub prompt_rendered: String,
    pub status: String,
    pub output: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct JobRunWithSteps {
    pub id: i64,
    pub job_id: i64,
    pub status: String,
    pub trigger: String,
    pub queued_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
    pub steps: Vec<JobRunStep>,
}

/// Cloneable handle to the single SQLite connection. Cloning shares the
/// connection (and its mutex), so the same instance can be managed as
/// Tauri state *and* registered as the proxy's `StatSink`.
#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let db_path = Self::db_path(app)?;

        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create database directory: {}", e))?;
        }

        let conn =
            Connection::open(&db_path).map_err(|e| format!("Failed to open database: {}", e))?;

        // Set pragmas for performance
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA busy_timeout=5000;",
        )
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.migrate()?;

        info!("Database initialized at {:?}", db_path);
        Ok(db)
    }

    fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
        Ok(data_dir.join("haruspex.db"))
    }

    /// Lock the connection, recovering from a poisoned mutex.
    ///
    /// A panic inside any DB critical section poisons the mutex. With the
    /// bare `.lock().unwrap()` that used to be at every call site, the first
    /// such panic would make every subsequent DB call panic too, taking down
    /// all persistence for the rest of the session. The SQLite handle stays
    /// valid across a panic — rusqlite `Transaction`s roll back on unwind —
    /// so we recover the guard instead of cascading.
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| {
            log::warn!("recovered from a poisoned DB connection mutex");
            poisoned.into_inner()
        })
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self.conn();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                tool_calls TEXT,
                tool_call_id TEXT,
                created_at INTEGER NOT NULL,
                sort_order INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conversation
                ON messages(conversation_id, sort_order);

            CREATE TABLE IF NOT EXISTS search_stats_engines (
                engine TEXT PRIMARY KEY,
                attempts INTEGER NOT NULL DEFAULT 0,
                successes INTEGER NOT NULL DEFAULT 0,
                fail_http INTEGER NOT NULL DEFAULT 0,
                fail_rate_limited INTEGER NOT NULL DEFAULT 0,
                fail_parse INTEGER NOT NULL DEFAULT 0,
                fail_empty INTEGER NOT NULL DEFAULT 0,
                fail_network INTEGER NOT NULL DEFAULT 0,
                fail_timeout INTEGER NOT NULL DEFAULT 0,
                fail_other INTEGER NOT NULL DEFAULT 0,
                total_latency_ms INTEGER NOT NULL DEFAULT 0,
                max_latency_ms INTEGER NOT NULL DEFAULT 0,
                last_success_at INTEGER,
                last_failure_at INTEGER,
                first_choice_attempts INTEGER NOT NULL DEFAULT 0,
                fallback_attempts INTEGER NOT NULL DEFAULT 0,
                fallback_successes INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS search_stats_globals (
                key TEXT PRIMARY KEY,
                value INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                working_dir TEXT NOT NULL,
                auto_approve_tools INTEGER NOT NULL DEFAULT 0,
                schedule_kind TEXT NOT NULL DEFAULT 'manual',
                schedule_config TEXT,
                next_due_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                job_type TEXT NOT NULL DEFAULT 'research',
                audit_num_runs INTEGER,
                audit_output_file TEXT,
                audit_read_only INTEGER NOT NULL DEFAULT 1,
                audit_max_iterations INTEGER,
                audit_sample_instructions TEXT,
                audit_verify_instructions TEXT,
                model_remote_base_url TEXT,
                model_remote_api_key TEXT,
                model_remote_model_id TEXT,
                model_remote_context_size INTEGER,
                model_remote_vision_supported INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_next_due
                ON jobs(next_due_at) WHERE next_due_at IS NOT NULL;

            CREATE TABLE IF NOT EXISTS job_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                ordering INTEGER NOT NULL,
                prompt TEXT NOT NULL,
                deep_research INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_job_steps_job
                ON job_steps(job_id, ordering);

            CREATE TABLE IF NOT EXISTS job_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                trigger TEXT NOT NULL,
                queued_at INTEGER NOT NULL,
                started_at INTEGER,
                finished_at INTEGER,
                error TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_job_runs_job
                ON job_runs(job_id, queued_at DESC);

            CREATE TABLE IF NOT EXISTS job_run_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
                ordering INTEGER NOT NULL,
                prompt_authored TEXT NOT NULL,
                prompt_rendered TEXT NOT NULL,
                status TEXT NOT NULL,
                output TEXT,
                started_at INTEGER,
                finished_at INTEGER,
                error TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_job_run_steps_run
                ON job_run_steps(run_id, ordering);

            CREATE TABLE IF NOT EXISTS prompt_catalog (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                scope TEXT NOT NULL,
                prompt TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_prompt_catalog_scope
                ON prompt_catalog(scope, name);",
        )
        .map_err(|e| format!("Migration failed: {}", e))?;

        // Idempotent ALTERs for older DBs. SQLite has no ADD COLUMN IF NOT
        // EXISTS, so we swallow the duplicate-column error on re-runs. Existing
        // jobs predate the audit feature, so they backfill to job_type =
        // 'research' via the column default.
        for stmt in [
            "ALTER TABLE messages ADD COLUMN steps TEXT",
            "ALTER TABLE jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'research'",
            "ALTER TABLE jobs ADD COLUMN audit_num_runs INTEGER",
            "ALTER TABLE jobs ADD COLUMN audit_output_file TEXT",
            "ALTER TABLE jobs ADD COLUMN audit_read_only INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE jobs ADD COLUMN audit_max_iterations INTEGER",
            "ALTER TABLE jobs ADD COLUMN audit_sample_instructions TEXT",
            "ALTER TABLE jobs ADD COLUMN audit_verify_instructions TEXT",
            "ALTER TABLE jobs ADD COLUMN model_remote_base_url TEXT",
            "ALTER TABLE jobs ADD COLUMN model_remote_api_key TEXT",
            "ALTER TABLE jobs ADD COLUMN model_remote_model_id TEXT",
            "ALTER TABLE jobs ADD COLUMN model_remote_context_size INTEGER",
            "ALTER TABLE jobs ADD COLUMN model_remote_vision_supported INTEGER",
        ] {
            if let Err(e) = conn.execute(stmt, []) {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(format!("Migration ({stmt}) failed: {msg}"));
                }
            }
        }

        info!("Database migration complete");
        Ok(())
    }
}

fn chrono_now() -> i64 {
    crate::time_util::now_ms()
}

mod commands;
mod conversations;
mod jobs;
mod prompts;
mod runs;
mod stats;

pub use commands::*;

#[cfg(test)]
mod tests;
