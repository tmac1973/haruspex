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
    /// Type-specific config as opaque JSON, owned entirely by the frontend's
    /// job-type modules (audit knobs, guided-planning seed, ...). Rust never
    /// parses it — adding a job type requires no Rust changes. The legacy
    /// per-type columns (audit_*, initial_description, plan_output_dir) were
    /// folded into this by a one-time migration and are dead: never read or
    /// written again, left in the schema because DROP COLUMN isn't worth the
    /// risk on user DBs.
    pub type_config: Option<String>,
    // Per-job remote model override (applies to every job type). When
    // `model_remote_base_url` is non-empty the job's model calls route to this
    // remote server/model instead of the global Settings backend. NULL/empty =
    // use Settings. Remote-only by design — local jobs follow Settings.
    /// Remote base URL (no trailing slash, no /v1). Empty/NULL = use Settings.
    pub model_remote_base_url: Option<String>,
    /// Optional Bearer token for the override server.
    pub model_remote_api_key: Option<String>,
    /// Reference to a key in the Settings API-key store (by id). When set,
    /// the runner resolves the actual key value from the store at request
    /// time. Takes precedence over the legacy inline `model_remote_api_key`.
    /// New jobs use this; `model_remote_api_key` is kept for migration.
    pub model_remote_api_key_id: Option<String>,
    /// Model ID sent to the override server.
    pub model_remote_model_id: Option<String>,
    /// Context window (tokens/request) of the override model, for budget +
    /// compaction math. NULL = fall back to the global active context size.
    pub model_remote_context_size: Option<i64>,
    /// Whether the override model accepts image input. NULL = inherit the
    /// global Settings vision capability; Some(false) hides vision tools.
    pub model_remote_vision_supported: Option<bool>,
    /// Advanced per-job model behavior as opaque JSON, owned entirely by the
    /// frontend (`$lib/agent/jobs/modelAdvanced`): the reasoning override, the
    /// sampling source + custom params, and the capabilities discovered by the
    /// last probe of the override server. Rust never parses it — same contract
    /// as [`JobWithSteps::type_config`]. NULL = every default.
    pub model_advanced: Option<String>,
}

fn default_job_type() -> String {
    "research".to_string()
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
    /// Type-specific config JSON (see [`JobWithSteps::type_config`]).
    #[serde(default)]
    pub type_config: Option<String>,
    #[serde(default)]
    pub model_remote_base_url: Option<String>,
    #[serde(default)]
    pub model_remote_api_key: Option<String>,
    #[serde(default)]
    pub model_remote_api_key_id: Option<String>,
    #[serde(default)]
    pub model_remote_model_id: Option<String>,
    #[serde(default)]
    pub model_remote_context_size: Option<i64>,
    #[serde(default)]
    pub model_remote_vision_supported: Option<bool>,
    /// Advanced model behavior JSON (see [`JobWithSteps::model_advanced`]).
    #[serde(default)]
    pub model_advanced: Option<String>,
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
    /// Serialized guided_planning resume state (stage, milestone, approved
    /// outline). NULL for non-guided runs.
    pub planning_state: Option<String>,
    /// The model, reasoning settings and context window this run executed
    /// under. All NULL for runs that predate the recording.
    pub model_id: Option<String>,
    pub model_thinking: Option<bool>,
    pub model_effort: Option<String>,
    pub context_size: Option<i64>,
}

/// Token and timing totals for one finished step, summed across every model
/// call it made. `None` throughout when the step ran no model calls — a
/// checkpoint stage waiting on the user, say — so the UI can render "—"
/// rather than a row of confident zeros.
///
/// `tokens_prompt` is tokens *processed*: one step is many independent turns
/// and each re-sends its own prompt, so this counts re-sends by design. It is
/// not context size, and `peak_prompt_tokens` is what answers "how close to
/// the window did this get".
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StepStats {
    pub tokens_prompt: i64,
    pub tokens_completion: i64,
    pub tokens_reasoning: i64,
    /// Whether `tokens_reasoning` came from the backend rather than the
    /// client's character-ratio estimate.
    pub tokens_reasoning_exact: bool,
    pub peak_prompt_tokens: i64,
    pub model_calls: i64,
    pub reasoning_ms: i64,
    pub total_ms: i64,
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
    /// `None` for steps that ran no model calls, and for every step recorded
    /// before token accounting existed.
    pub stats: Option<StepStats>,
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
    pub planning_state: Option<String>,
    pub model_id: Option<String>,
    pub model_thinking: Option<bool>,
    pub model_effort: Option<String>,
    pub context_size: Option<i64>,
    pub steps: Vec<JobRunStep>,
}

/// One remembered fact, as the frontend sees it.
///
/// The embedding is deliberately absent: it is several KB of f32 per row that
/// no caller outside Rust can do anything with, and shipping it over IPC
/// would make listing the manager UI's rows cost megabytes.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct MemoryMeta {
    pub id: String,
    pub content: String,
    pub category: String,
    pub source_conversation_id: Option<String>,
    /// Title of the conversation this was learned from, when that
    /// conversation still exists. None once it has been deleted — the memory
    /// outlives its source by design, so the manager can say "a deleted chat"
    /// rather than pretending the provenance is unknown.
    pub source_title: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub last_seen_at: i64,
    #[ts(type = "number")]
    pub use_count: i64,
    /// How this memory came to exist: `"extracted"` when the background pass
    /// distilled it from a finished conversation, `"explicit"` when the user
    /// asked for it in so many words and the model called `remember_this`.
    ///
    /// Shown in the manager because the two deserve different scrutiny: one
    /// the user said, the other the app inferred.
    pub origin: String,
}

/// A search hit: the memory plus why it was returned.
///
/// `score` is the reranked value actually used for ordering (similarity
/// discounted by age), not raw cosine — Phase 05 shows it to answer "why did
/// it say that?", and showing a number the ranking did not use would be a
/// lie with extra steps.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct MemoryHit {
    #[serde(flatten)]
    #[ts(flatten)]
    pub memory: MemoryMeta,
    pub score: f32,
    pub similarity: f32,
}

/// Per-conversation memory state: the incognito flag and the extraction
/// watermark, read together because every caller needs both.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct MemoryCursor {
    pub memory_enabled: bool,
    #[ts(type = "number")]
    pub memory_extracted_to: i64,
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
             PRAGMA synchronous=NORMAL;
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
                model_remote_vision_supported INTEGER,
                initial_description TEXT,
                plan_output_dir TEXT
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
                error TEXT,
                planning_state TEXT
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

            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'fact',
                embedding BLOB NOT NULL,
                embedding_model TEXT NOT NULL,
                source_conversation_id TEXT,
                created_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                use_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_memories_model
                ON memories(embedding_model);

            CREATE TABLE IF NOT EXISTS prompt_catalog (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                scope TEXT NOT NULL,
                prompt TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_prompt_catalog_scope
                ON prompt_catalog(scope, name);

            CREATE TABLE IF NOT EXISTS images (
                hash TEXT PRIMARY KEY,
                source_url TEXT NOT NULL,
                source TEXT NOT NULL,
                mime TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                bytes INTEGER NOT NULL,
                license TEXT,
                attribution TEXT,
                description_url TEXT,
                embeddable INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_images_source_url
                ON images(source_url);

            CREATE INDEX IF NOT EXISTS idx_images_last_used
                ON images(last_used_at);

            CREATE TABLE IF NOT EXISTS conversation_images (
                conversation_id TEXT NOT NULL
                    REFERENCES conversations(id) ON DELETE CASCADE,
                image_hash TEXT NOT NULL
                    REFERENCES images(hash) ON DELETE CASCADE,
                PRIMARY KEY (conversation_id, image_hash)
            );

            CREATE INDEX IF NOT EXISTS idx_conversation_images_hash
                ON conversation_images(image_hash);",
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
            "ALTER TABLE jobs ADD COLUMN model_remote_api_key_id TEXT",
            "ALTER TABLE jobs ADD COLUMN model_remote_model_id TEXT",
            "ALTER TABLE jobs ADD COLUMN model_remote_context_size INTEGER",
            "ALTER TABLE jobs ADD COLUMN model_remote_vision_supported INTEGER",
            "ALTER TABLE jobs ADD COLUMN initial_description TEXT",
            "ALTER TABLE jobs ADD COLUMN plan_output_dir TEXT",
            "ALTER TABLE job_runs ADD COLUMN planning_state TEXT",
            "ALTER TABLE jobs ADD COLUMN type_config TEXT",
            "ALTER TABLE jobs ADD COLUMN model_advanced TEXT",
            // Per-step token accounting. All nullable: rows written before
            // this read back as "not recorded", which is a different thing
            // from a step that ran no model calls and spent zero.
            "ALTER TABLE job_run_steps ADD COLUMN tokens_prompt INTEGER",
            "ALTER TABLE job_run_steps ADD COLUMN tokens_completion INTEGER",
            "ALTER TABLE job_run_steps ADD COLUMN tokens_reasoning INTEGER",
            "ALTER TABLE job_run_steps ADD COLUMN tokens_reasoning_exact INTEGER",
            "ALTER TABLE job_run_steps ADD COLUMN peak_prompt_tokens INTEGER",
            "ALTER TABLE job_run_steps ADD COLUMN model_calls INTEGER",
            "ALTER TABLE job_run_steps ADD COLUMN reasoning_ms INTEGER",
            "ALTER TABLE job_run_steps ADD COLUMN total_ms INTEGER",
            // What the run actually ran on. Recorded per RUN, not read from
            // the job at display time: a job's model/reasoning settings can be
            // edited after a run finishes, and a token table attributed to the
            // wrong model is worse than one with no attribution at all.
            "ALTER TABLE job_runs ADD COLUMN model_id TEXT",
            "ALTER TABLE job_runs ADD COLUMN model_thinking INTEGER",
            "ALTER TABLE job_runs ADD COLUMN model_effort TEXT",
            "ALTER TABLE job_runs ADD COLUMN context_size INTEGER",
            // Agentic memory, per conversation. Both land now so phases 03-05
            // need no further migration.
            //
            // memory_enabled: incognito is per chat and persisted, so it
            // survives a restart — a session-only toggle is a privacy footgun.
            // Default 1: an ordinary chat participates once the global switch
            // is on. Remote web-chat threads are created with 0, because a
            // guest must not seed the owner's memory (see the plan's D3).
            //
            // memory_extracted_to: the max message sort_order already
            // distilled. -1 means nothing yet, and sort_order starts at 0.
            "ALTER TABLE conversations ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE conversations ADD COLUMN memory_extracted_to INTEGER NOT NULL DEFAULT -1",
            // origin: "extracted" (the background pass distilled it) or
            // "explicit" (the user asked and remember_this wrote it). Default
            // "extracted" is right for every row written before this column
            // existed — the tool did not exist then.
            "ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'extracted'",
        ] {
            if let Err(e) = conn.execute(stmt, []) {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(format!("Migration ({stmt}) failed: {msg}"));
                }
            }
        }

        Self::migrate_type_config(&conn)?;

        info!("Database migration complete");
        Ok(())
    }

    /// One-time data migration: fold the legacy per-type job columns into
    /// `type_config` JSON. Only touches rows that predate the column
    /// (`type_config IS NULL`), so it is idempotent; the JSON shapes must
    /// match what the frontend job-type modules' `configFromJob` parsers
    /// expect. The legacy columns are dead afterwards — never read or
    /// written again (dropping them isn't worth the risk on user DBs).
    fn migrate_type_config(conn: &Connection) -> Result<(), String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, job_type, audit_num_runs, audit_output_file, audit_read_only,
                        audit_max_iterations, audit_sample_instructions,
                        audit_verify_instructions, initial_description, plan_output_dir
                 FROM jobs
                 WHERE type_config IS NULL AND job_type IN ('audit', 'guided_planning')",
            )
            .map_err(|e| format!("type_config migration query failed: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let job_type: String = row.get(1)?;
                let json = if job_type == "audit" {
                    serde_json::json!({
                        "num_runs": row.get::<_, Option<i64>>(2)?,
                        "output_file": row.get::<_, Option<String>>(3)?,
                        "read_only": row.get::<_, i64>(4)? != 0,
                        "max_iterations": row.get::<_, Option<i64>>(5)?,
                        "sample_instructions": row.get::<_, Option<String>>(6)?,
                        "verify_instructions": row.get::<_, Option<String>>(7)?,
                    })
                } else {
                    serde_json::json!({
                        "initial_description": row.get::<_, Option<String>>(8)?,
                        "plan_output_dir": row.get::<_, Option<String>>(9)?,
                    })
                };
                Ok((id, json.to_string()))
            })
            .map_err(|e| format!("type_config migration read failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("type_config migration row failed: {e}"))?;
        drop(stmt);

        for (id, json) in rows {
            conn.execute(
                "UPDATE jobs SET type_config = ?1 WHERE id = ?2",
                rusqlite::params![json, id],
            )
            .map_err(|e| format!("type_config migration update failed: {e}"))?;
        }
        Ok(())
    }
}

fn chrono_now() -> i64 {
    crate::time_util::now_ms()
}

mod commands;
mod conversations;
mod images;
mod jobs;
mod memories;
mod memory_commands;
mod prompts;
mod runs;
mod stats;

pub use commands::*;
pub use images::ImageRow;
pub use memory_commands::*;

#[cfg(test)]
mod tests;
