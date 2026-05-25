use log::info;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Deserialize)]
pub struct MessageInput {
    pub role: String,
    pub content: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct DbMessage {
    pub id: i64,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub created_at: i64,
    pub sort_order: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConversationWithMessages {
    pub id: String,
    pub title: String,
    pub created_at: i64,
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
    pub schedule_kind: String,
    pub schedule_config: Option<String>,
    pub next_due_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub steps: Vec<JobStep>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct JobInput {
    pub name: String,
    pub description: Option<String>,
    pub working_dir: String,
    pub auto_approve_tools: bool,
    pub schedule_kind: String,
    pub schedule_config: Option<String>,
    /// Pre-computed unix ms when this job is next due. The frontend
    /// (jobs store) owns the date math so we don't need chrono on the
    /// Rust side. NULL for `manual` schedules.
    #[serde(default)]
    pub next_due_at: Option<i64>,
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

/// Incremental change to a single engine's lifetime stats row.
///
/// Caller is expected to set `attempt = true` for every recorded outcome and
/// exactly one of: `success = true` OR `failure_column = Some(...)`. The
/// `failure_column` must be one of the seven `fail_*` column names defined
/// in `search_stats_engines`; passing anything else returns an error rather
/// than silently corrupting the SQL.
#[derive(Clone, Debug, Default)]
pub struct EngineStatDelta {
    pub attempt: bool,
    pub success: bool,
    pub latency_ms: u64,
    pub failure_column: Option<&'static str>,
    pub now_ms: i64,
    pub first_choice: bool,
    pub fallback: bool,
    pub fallback_success: bool,
}

/// Snapshot of a single engine's lifetime stats row. Mirrors the column
/// layout so the frontend can render it without re-fetching per row.
#[derive(Clone, Debug, Default, Serialize)]
pub struct EngineLifetimeStats {
    pub engine: String,
    pub attempts: u64,
    pub successes: u64,
    pub fail_http: u64,
    pub fail_rate_limited: u64,
    pub fail_parse: u64,
    pub fail_empty: u64,
    pub fail_network: u64,
    pub fail_timeout: u64,
    pub fail_other: u64,
    pub total_latency_ms: u64,
    pub max_latency_ms: u64,
    pub last_success_at: Option<i64>,
    pub last_failure_at: Option<i64>,
    pub first_choice_attempts: u64,
    pub fallback_attempts: u64,
    pub fallback_successes: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct LifetimeStatsSnapshot {
    pub engines: Vec<EngineLifetimeStats>,
    pub globals: HashMap<String, u64>,
}

const VALID_FAILURE_COLUMNS: &[&str] = &[
    "fail_http",
    "fail_rate_limited",
    "fail_parse",
    "fail_empty",
    "fail_network",
    "fail_timeout",
    "fail_other",
];

pub struct Database {
    conn: Mutex<Connection>,
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
            conn: Mutex::new(conn),
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

    fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
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
                updated_at INTEGER NOT NULL
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
                ON job_run_steps(run_id, ordering);",
        )
        .map_err(|e| format!("Migration failed: {}", e))?;

        info!("Database migration complete");
        Ok(())
    }

    pub fn list_conversations(&self) -> Result<Vec<ConversationSummary>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
            .map_err(|e| format!("Query failed: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| format!("Query failed: {}", e))?;

        let mut conversations = Vec::new();
        for row in rows {
            conversations.push(row.map_err(|e| format!("Row read failed: {}", e))?);
        }
        Ok(conversations)
    }

    pub fn get_conversation(&self, id: &str) -> Result<ConversationWithMessages, String> {
        let conn = self.conn.lock().unwrap();

        let (title, created_at, updated_at) = conn
            .query_row(
                "SELECT title, created_at, updated_at FROM conversations WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(|e| format!("Conversation not found: {}", e))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, role, content, tool_calls, tool_call_id, created_at, sort_order
                 FROM messages WHERE conversation_id = ?1 ORDER BY sort_order ASC",
            )
            .map_err(|e| format!("Query failed: {}", e))?;

        let messages = stmt
            .query_map(params![id], |row| {
                Ok(DbMessage {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    tool_calls: row.get(4)?,
                    tool_call_id: row.get(5)?,
                    created_at: row.get(6)?,
                    sort_order: row.get(7)?,
                })
            })
            .map_err(|e| format!("Query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Row read failed: {}", e))?;

        Ok(ConversationWithMessages {
            id: id.to_string(),
            title,
            created_at,
            updated_at,
            messages,
        })
    }

    pub fn create_conversation(&self, id: &str, title: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let now = chrono_now();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, now, now],
        )
        .map_err(|e| format!("Insert failed: {}", e))?;
        Ok(())
    }

    pub fn save_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        tool_calls: Option<&str>,
        tool_call_id: Option<&str>,
    ) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        let now = chrono_now();

        // Get next sort_order
        let sort_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM messages WHERE conversation_id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Query failed: {}", e))?;

        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id, created_at, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![conversation_id, role, content, tool_calls, tool_call_id, now, sort_order],
        )
        .map_err(|e| format!("Insert failed: {}", e))?;

        // Update conversation timestamp
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )
        .map_err(|e| format!("Update failed: {}", e))?;

        Ok(conn.last_insert_rowid())
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET title = ?1 WHERE id = ?2",
            params![title, id],
        )
        .map_err(|e| format!("Update failed: {}", e))?;
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])
            .map_err(|e| format!("Delete failed: {}", e))?;
        Ok(())
    }

    pub fn clear_all_conversations(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM messages; DELETE FROM conversations;")
            .map_err(|e| format!("Clear failed: {}", e))?;
        Ok(())
    }

    /// UPSERT a single engine's stats row with the given delta. Runs as
    /// two statements (INSERT-OR-IGNORE then UPDATE) under the connection
    /// Mutex, so other writers can't race in between. The failure column
    /// name is validated against a whitelist — passing an unknown name
    /// returns an error rather than constructing arbitrary SQL.
    pub fn update_engine_stat(&self, engine: &str, delta: &EngineStatDelta) -> Result<(), String> {
        if let Some(col) = delta.failure_column {
            if !VALID_FAILURE_COLUMNS.contains(&col) {
                return Err(format!("Unknown failure column: {}", col));
            }
        }

        let conn = self.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO search_stats_engines (engine) VALUES (?1) ON CONFLICT(engine) DO NOTHING",
            params![engine],
        )
        .map_err(|e| format!("Stats insert failed: {}", e))?;

        // Translate the delta into per-column increments. Only one fail_*
        // counter is non-zero per call; the rest are 0.
        let mut fail_http = 0u64;
        let mut fail_rate_limited = 0u64;
        let mut fail_parse = 0u64;
        let mut fail_empty = 0u64;
        let mut fail_network = 0u64;
        let mut fail_timeout = 0u64;
        let mut fail_other = 0u64;

        if let Some(col) = delta.failure_column {
            match col {
                "fail_http" => fail_http = 1,
                "fail_rate_limited" => fail_rate_limited = 1,
                "fail_parse" => fail_parse = 1,
                "fail_empty" => fail_empty = 1,
                "fail_network" => fail_network = 1,
                "fail_timeout" => fail_timeout = 1,
                "fail_other" => fail_other = 1,
                _ => unreachable!(),
            }
        }

        let attempt_inc: u64 = if delta.attempt { 1 } else { 0 };
        let success_inc: u64 = if delta.success { 1 } else { 0 };
        let first_choice_inc: u64 = if delta.first_choice { 1 } else { 0 };
        let fallback_inc: u64 = if delta.fallback { 1 } else { 0 };
        let fallback_success_inc: u64 = if delta.fallback_success { 1 } else { 0 };
        let latency = if delta.success { delta.latency_ms } else { 0 };
        let success_ts: i64 = if delta.success && delta.now_ms > 0 {
            delta.now_ms
        } else {
            0
        };
        let failure_ts: i64 = if delta.failure_column.is_some() && delta.now_ms > 0 {
            delta.now_ms
        } else {
            0
        };

        conn.execute(
            "UPDATE search_stats_engines SET
                attempts = attempts + ?1,
                successes = successes + ?2,
                fail_http = fail_http + ?3,
                fail_rate_limited = fail_rate_limited + ?4,
                fail_parse = fail_parse + ?5,
                fail_empty = fail_empty + ?6,
                fail_network = fail_network + ?7,
                fail_timeout = fail_timeout + ?8,
                fail_other = fail_other + ?9,
                total_latency_ms = total_latency_ms + ?10,
                max_latency_ms = MAX(max_latency_ms, ?11),
                last_success_at = CASE WHEN ?12 > 0 THEN ?12 ELSE last_success_at END,
                last_failure_at = CASE WHEN ?13 > 0 THEN ?13 ELSE last_failure_at END,
                first_choice_attempts = first_choice_attempts + ?14,
                fallback_attempts = fallback_attempts + ?15,
                fallback_successes = fallback_successes + ?16
             WHERE engine = ?17",
            params![
                attempt_inc as i64,
                success_inc as i64,
                fail_http as i64,
                fail_rate_limited as i64,
                fail_parse as i64,
                fail_empty as i64,
                fail_network as i64,
                fail_timeout as i64,
                fail_other as i64,
                latency as i64,
                latency as i64,
                success_ts,
                failure_ts,
                first_choice_inc as i64,
                fallback_inc as i64,
                fallback_success_inc as i64,
                engine,
            ],
        )
        .map_err(|e| format!("Stats update failed: {}", e))?;

        Ok(())
    }

    pub fn increment_global(&self, key: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO search_stats_globals (key, value) VALUES (?1, 1)
             ON CONFLICT(key) DO UPDATE SET value = value + 1",
            params![key],
        )
        .map_err(|e| format!("Globals upsert failed: {}", e))?;
        Ok(())
    }

    pub fn lifetime_stats_snapshot(&self) -> Result<LifetimeStatsSnapshot, String> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT engine, attempts, successes,
                        fail_http, fail_rate_limited, fail_parse, fail_empty,
                        fail_network, fail_timeout, fail_other,
                        total_latency_ms, max_latency_ms,
                        last_success_at, last_failure_at,
                        first_choice_attempts, fallback_attempts, fallback_successes
                 FROM search_stats_engines
                 ORDER BY engine",
            )
            .map_err(|e| format!("Snapshot prepare failed: {}", e))?;

        let engines = stmt
            .query_map([], |row| {
                Ok(EngineLifetimeStats {
                    engine: row.get(0)?,
                    attempts: row.get::<_, i64>(1)? as u64,
                    successes: row.get::<_, i64>(2)? as u64,
                    fail_http: row.get::<_, i64>(3)? as u64,
                    fail_rate_limited: row.get::<_, i64>(4)? as u64,
                    fail_parse: row.get::<_, i64>(5)? as u64,
                    fail_empty: row.get::<_, i64>(6)? as u64,
                    fail_network: row.get::<_, i64>(7)? as u64,
                    fail_timeout: row.get::<_, i64>(8)? as u64,
                    fail_other: row.get::<_, i64>(9)? as u64,
                    total_latency_ms: row.get::<_, i64>(10)? as u64,
                    max_latency_ms: row.get::<_, i64>(11)? as u64,
                    last_success_at: row.get::<_, Option<i64>>(12)?,
                    last_failure_at: row.get::<_, Option<i64>>(13)?,
                    first_choice_attempts: row.get::<_, i64>(14)? as u64,
                    fallback_attempts: row.get::<_, i64>(15)? as u64,
                    fallback_successes: row.get::<_, i64>(16)? as u64,
                })
            })
            .map_err(|e| format!("Snapshot query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Snapshot row read failed: {}", e))?;

        let mut globals = HashMap::new();
        let mut gstmt = conn
            .prepare("SELECT key, value FROM search_stats_globals")
            .map_err(|e| format!("Globals prepare failed: {}", e))?;
        let rows = gstmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })
            .map_err(|e| format!("Globals query failed: {}", e))?;
        for r in rows {
            let (k, v) = r.map_err(|e| format!("Globals row read failed: {}", e))?;
            globals.insert(k, v);
        }

        Ok(LifetimeStatsSnapshot { engines, globals })
    }

    pub fn reset_lifetime_stats(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM search_stats_engines; DELETE FROM search_stats_globals;")
            .map_err(|e| format!("Reset failed: {}", e))?;
        Ok(())
    }

    pub fn replace_messages(
        &self,
        conversation_id: &str,
        messages: &[MessageInput],
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let now = chrono_now();

        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )
        .map_err(|e| format!("Delete failed: {}", e))?;

        for (i, msg) in messages.iter().enumerate() {
            conn.execute(
                "INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id, created_at, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    conversation_id,
                    msg.role,
                    msg.content,
                    msg.tool_calls,
                    msg.tool_call_id,
                    now,
                    i as i64 + 1
                ],
            )
            .map_err(|e| format!("Insert failed: {}", e))?;
        }

        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )
        .map_err(|e| format!("Update failed: {}", e))?;

        Ok(())
    }

    pub fn create_job(&self, input: &JobInput) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        let now = chrono_now();
        conn.execute(
            "INSERT INTO jobs
                (name, description, working_dir, auto_approve_tools,
                 schedule_kind, schedule_config, next_due_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                input.name,
                input.description,
                input.working_dir,
                input.auto_approve_tools as i64,
                input.schedule_kind,
                input.schedule_config,
                input.next_due_at,
                now,
            ],
        )
        .map_err(|e| format!("Job insert failed: {}", e))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_jobs(&self) -> Result<Vec<JobSummary>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT j.id, j.name, j.description, j.working_dir, j.auto_approve_tools,
                        j.schedule_kind, j.schedule_config, j.next_due_at,
                        j.created_at, j.updated_at,
                        (SELECT COUNT(*) FROM job_steps s WHERE s.job_id = j.id) AS step_count
                 FROM jobs j
                 ORDER BY j.updated_at DESC",
            )
            .map_err(|e| format!("Jobs query failed: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(JobSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    working_dir: row.get(3)?,
                    auto_approve_tools: row.get::<_, i64>(4)? != 0,
                    schedule_kind: row.get(5)?,
                    schedule_config: row.get(6)?,
                    next_due_at: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    step_count: row.get(10)?,
                })
            })
            .map_err(|e| format!("Jobs query failed: {}", e))?;

        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(row.map_err(|e| format!("Jobs row read failed: {}", e))?);
        }
        Ok(jobs)
    }

    pub fn get_job(&self, id: i64) -> Result<JobWithSteps, String> {
        let conn = self.conn.lock().unwrap();

        let (
            name,
            description,
            working_dir,
            auto_approve_tools,
            schedule_kind,
            schedule_config,
            next_due_at,
            created_at,
            updated_at,
        ) = conn
            .query_row(
                "SELECT name, description, working_dir, auto_approve_tools,
                        schedule_kind, schedule_config, next_due_at,
                        created_at, updated_at
                 FROM jobs WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)? != 0,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                    ))
                },
            )
            .map_err(|e| format!("Job not found: {}", e))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, ordering, prompt, deep_research
                 FROM job_steps WHERE job_id = ?1 ORDER BY ordering ASC",
            )
            .map_err(|e| format!("Steps query failed: {}", e))?;

        let steps = stmt
            .query_map(params![id], |row| {
                Ok(JobStep {
                    id: row.get(0)?,
                    ordering: row.get(1)?,
                    prompt: row.get(2)?,
                    deep_research: row.get::<_, i64>(3)? != 0,
                })
            })
            .map_err(|e| format!("Steps query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Steps row read failed: {}", e))?;

        Ok(JobWithSteps {
            id,
            name,
            description,
            working_dir,
            auto_approve_tools,
            schedule_kind,
            schedule_config,
            next_due_at,
            created_at,
            updated_at,
            steps,
        })
    }

    pub fn update_job(&self, id: i64, input: &JobInput) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let now = chrono_now();
        let affected = conn
            .execute(
                "UPDATE jobs SET
                    name = ?1,
                    description = ?2,
                    working_dir = ?3,
                    auto_approve_tools = ?4,
                    schedule_kind = ?5,
                    schedule_config = ?6,
                    next_due_at = ?7,
                    updated_at = ?8
                 WHERE id = ?9",
                params![
                    input.name,
                    input.description,
                    input.working_dir,
                    input.auto_approve_tools as i64,
                    input.schedule_kind,
                    input.schedule_config,
                    input.next_due_at,
                    now,
                    id,
                ],
            )
            .map_err(|e| format!("Job update failed: {}", e))?;
        if affected == 0 {
            return Err(format!("No job with id {}", id));
        }
        Ok(())
    }

    pub fn set_job_next_due_at(&self, job_id: i64, next_due_at: Option<i64>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let affected = conn
            .execute(
                "UPDATE jobs SET next_due_at = ?1 WHERE id = ?2",
                params![next_due_at, job_id],
            )
            .map_err(|e| format!("next_due_at update failed: {}", e))?;
        if affected == 0 {
            return Err(format!("No job with id {}", job_id));
        }
        Ok(())
    }

    pub fn list_due_jobs(&self, now_ms: i64) -> Result<Vec<JobSummary>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT j.id, j.name, j.description, j.working_dir, j.auto_approve_tools,
                        j.schedule_kind, j.schedule_config, j.next_due_at,
                        j.created_at, j.updated_at,
                        (SELECT COUNT(*) FROM job_steps s WHERE s.job_id = j.id) AS step_count
                 FROM jobs j
                 WHERE j.schedule_kind != 'manual'
                   AND j.next_due_at IS NOT NULL
                   AND j.next_due_at <= ?1
                 ORDER BY j.next_due_at ASC",
            )
            .map_err(|e| format!("Due jobs query failed: {}", e))?;

        let rows = stmt
            .query_map(params![now_ms], |row| {
                Ok(JobSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    working_dir: row.get(3)?,
                    auto_approve_tools: row.get::<_, i64>(4)? != 0,
                    schedule_kind: row.get(5)?,
                    schedule_config: row.get(6)?,
                    next_due_at: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    step_count: row.get(10)?,
                })
            })
            .map_err(|e| format!("Due jobs query failed: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Due jobs row read failed: {}", e))
    }

    pub fn delete_job(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM jobs WHERE id = ?1", params![id])
            .map_err(|e| format!("Job delete failed: {}", e))?;
        Ok(())
    }

    pub fn replace_job_steps(&self, job_id: i64, steps: &[JobStepInput]) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("Transaction failed: {}", e))?;

        tx.execute("DELETE FROM job_steps WHERE job_id = ?1", params![job_id])
            .map_err(|e| format!("Step delete failed: {}", e))?;

        for (i, step) in steps.iter().enumerate() {
            tx.execute(
                "INSERT INTO job_steps (job_id, ordering, prompt, deep_research)
                 VALUES (?1, ?2, ?3, ?4)",
                params![job_id, i as i64, step.prompt, step.deep_research as i64],
            )
            .map_err(|e| format!("Step insert failed: {}", e))?;
        }

        let now = chrono_now();
        tx.execute(
            "UPDATE jobs SET updated_at = ?1 WHERE id = ?2",
            params![now, job_id],
        )
        .map_err(|e| format!("Job timestamp update failed: {}", e))?;

        tx.commit().map_err(|e| format!("Commit failed: {}", e))?;
        Ok(())
    }

    pub fn create_job_run(
        &self,
        job_id: i64,
        trigger: &str,
        step_prompts: &[String],
    ) -> Result<i64, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("Transaction failed: {}", e))?;

        let now = chrono_now();
        tx.execute(
            "INSERT INTO job_runs (job_id, status, trigger, queued_at)
             VALUES (?1, 'queued', ?2, ?3)",
            params![job_id, trigger, now],
        )
        .map_err(|e| format!("Run insert failed: {}", e))?;
        let run_id = tx.last_insert_rowid();

        for (i, prompt) in step_prompts.iter().enumerate() {
            tx.execute(
                "INSERT INTO job_run_steps
                    (run_id, ordering, prompt_authored, prompt_rendered, status)
                 VALUES (?1, ?2, ?3, ?3, 'pending')",
                params![run_id, i as i64, prompt],
            )
            .map_err(|e| format!("Run step insert failed: {}", e))?;
        }

        tx.commit().map_err(|e| format!("Commit failed: {}", e))?;
        Ok(run_id)
    }

    pub fn mark_run_started(&self, run_id: i64, started_at: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE job_runs SET status = 'running', started_at = ?1
             WHERE id = ?2 AND status = 'queued'",
            params![started_at, run_id],
        )
        .map_err(|e| format!("Run started update failed: {}", e))?;
        Ok(())
    }

    pub fn mark_run_finished(
        &self,
        run_id: i64,
        status: &str,
        finished_at: i64,
        error: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE job_runs SET status = ?1, finished_at = ?2, error = ?3
             WHERE id = ?4",
            params![status, finished_at, error, run_id],
        )
        .map_err(|e| format!("Run finish update failed: {}", e))?;
        Ok(())
    }

    pub fn mark_run_step_started(
        &self,
        run_id: i64,
        ordering: i64,
        started_at: i64,
        prompt_rendered: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE job_run_steps
                SET status = 'running', started_at = ?1, prompt_rendered = ?2
                WHERE run_id = ?3 AND ordering = ?4",
            params![started_at, prompt_rendered, run_id, ordering],
        )
        .map_err(|e| format!("Step started update failed: {}", e))?;
        Ok(())
    }

    pub fn mark_run_step_finished(
        &self,
        run_id: i64,
        ordering: i64,
        status: &str,
        output: Option<&str>,
        error: Option<&str>,
        finished_at: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE job_run_steps
                SET status = ?1, output = ?2, error = ?3, finished_at = ?4
                WHERE run_id = ?5 AND ordering = ?6",
            params![status, output, error, finished_at, run_id, ordering],
        )
        .map_err(|e| format!("Step finished update failed: {}", e))?;
        Ok(())
    }

    pub fn list_job_runs(&self, job_id: i64) -> Result<Vec<JobRunSummary>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, job_id, status, trigger, queued_at, started_at, finished_at, error
                 FROM job_runs WHERE job_id = ?1
                 ORDER BY queued_at DESC",
            )
            .map_err(|e| format!("Runs query failed: {}", e))?;

        let rows = stmt
            .query_map(params![job_id], |row| {
                Ok(JobRunSummary {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    status: row.get(2)?,
                    trigger: row.get(3)?,
                    queued_at: row.get(4)?,
                    started_at: row.get(5)?,
                    finished_at: row.get(6)?,
                    error: row.get(7)?,
                })
            })
            .map_err(|e| format!("Runs query failed: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Runs row read failed: {}", e))
    }

    pub fn get_job_run(&self, run_id: i64) -> Result<JobRunWithSteps, String> {
        let conn = self.conn.lock().unwrap();
        let (job_id, status, trigger, queued_at, started_at, finished_at, error) = conn
            .query_row(
                "SELECT job_id, status, trigger, queued_at, started_at, finished_at, error
                 FROM job_runs WHERE id = ?1",
                params![run_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .map_err(|e| format!("Run not found: {}", e))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, run_id, ordering, prompt_authored, prompt_rendered,
                        status, output, started_at, finished_at, error
                 FROM job_run_steps WHERE run_id = ?1
                 ORDER BY ordering ASC",
            )
            .map_err(|e| format!("Run steps query failed: {}", e))?;

        let steps = stmt
            .query_map(params![run_id], |row| {
                Ok(JobRunStep {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    ordering: row.get(2)?,
                    prompt_authored: row.get(3)?,
                    prompt_rendered: row.get(4)?,
                    status: row.get(5)?,
                    output: row.get(6)?,
                    started_at: row.get(7)?,
                    finished_at: row.get(8)?,
                    error: row.get(9)?,
                })
            })
            .map_err(|e| format!("Run steps query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Run steps row read failed: {}", e))?;

        Ok(JobRunWithSteps {
            id: run_id,
            job_id,
            status,
            trigger,
            queued_at,
            started_at,
            finished_at,
            error,
            steps,
        })
    }

    pub fn delete_job_run(&self, run_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM job_runs WHERE id = ?1", params![run_id])
            .map_err(|e| format!("Run delete failed: {}", e))?;
        Ok(())
    }

    pub fn delete_all_job_runs(&self, job_id: i64) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        let n = conn
            .execute("DELETE FROM job_runs WHERE job_id = ?1", params![job_id])
            .map_err(|e| format!("Run bulk delete failed: {}", e))?;
        Ok(n as i64)
    }

    /// Sweep run rows orphaned by a previous-session crash or hard close.
    /// Runs left in 'queued' or 'running' are marked 'interrupted' and any
    /// in-flight steps are marked the same. Idempotent — calling it on a
    /// clean DB does nothing. Returns the number of runs swept.
    pub fn recover_orphan_runs(&self) -> Result<i64, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("Transaction failed: {}", e))?;
        let now = chrono_now();
        let msg = "App was closed during this run.";

        let swept = tx
            .execute(
                "UPDATE job_runs
                    SET status = 'interrupted',
                        finished_at = COALESCE(finished_at, ?1),
                        error = COALESCE(error, ?2)
                 WHERE status IN ('queued', 'running')",
                params![now, msg],
            )
            .map_err(|e| format!("Run sweep failed: {}", e))? as i64;

        tx.execute(
            "UPDATE job_run_steps
                SET status = 'cancelled',
                    finished_at = COALESCE(finished_at, ?1),
                    error = COALESCE(error, ?2)
                WHERE status = 'running'",
            params![now, msg],
        )
        .map_err(|e| format!("Step sweep failed: {}", e))?;

        tx.commit().map_err(|e| format!("Commit failed: {}", e))?;
        Ok(swept)
    }
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

// Tauri commands

#[tauri::command]
pub fn db_list_conversations(
    state: tauri::State<'_, Database>,
) -> Result<Vec<ConversationSummary>, String> {
    state.list_conversations()
}

#[tauri::command]
pub fn db_get_conversation(
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<ConversationWithMessages, String> {
    state.get_conversation(&id)
}

#[tauri::command]
pub fn db_create_conversation(
    state: tauri::State<'_, Database>,
    id: String,
    title: String,
) -> Result<(), String> {
    state.create_conversation(&id, &title)
}

#[tauri::command]
pub fn db_save_message(
    state: tauri::State<'_, Database>,
    conversation_id: String,
    role: String,
    content: String,
    tool_calls: Option<String>,
    tool_call_id: Option<String>,
) -> Result<i64, String> {
    state.save_message(
        &conversation_id,
        &role,
        &content,
        tool_calls.as_deref(),
        tool_call_id.as_deref(),
    )
}

#[tauri::command]
pub fn db_rename_conversation(
    state: tauri::State<'_, Database>,
    id: String,
    title: String,
) -> Result<(), String> {
    state.rename_conversation(&id, &title)
}

#[tauri::command]
pub fn db_delete_conversation(state: tauri::State<'_, Database>, id: String) -> Result<(), String> {
    state.delete_conversation(&id)
}

#[tauri::command]
pub fn db_clear_all_conversations(state: tauri::State<'_, Database>) -> Result<(), String> {
    state.clear_all_conversations()
}

#[tauri::command]
pub fn db_replace_messages(
    state: tauri::State<'_, Database>,
    conversation_id: String,
    messages: Vec<MessageInput>,
) -> Result<(), String> {
    state.replace_messages(&conversation_id, &messages)
}

#[tauri::command]
pub fn db_create_job(state: tauri::State<'_, Database>, input: JobInput) -> Result<i64, String> {
    state.create_job(&input)
}

#[tauri::command]
pub fn db_list_jobs(state: tauri::State<'_, Database>) -> Result<Vec<JobSummary>, String> {
    state.list_jobs()
}

#[tauri::command]
pub fn db_get_job(state: tauri::State<'_, Database>, id: i64) -> Result<JobWithSteps, String> {
    state.get_job(id)
}

#[tauri::command]
pub fn db_update_job(
    state: tauri::State<'_, Database>,
    id: i64,
    input: JobInput,
) -> Result<(), String> {
    state.update_job(id, &input)
}

#[tauri::command]
pub fn db_delete_job(state: tauri::State<'_, Database>, id: i64) -> Result<(), String> {
    state.delete_job(id)
}

#[tauri::command]
pub fn db_replace_job_steps(
    state: tauri::State<'_, Database>,
    job_id: i64,
    steps: Vec<JobStepInput>,
) -> Result<(), String> {
    state.replace_job_steps(job_id, &steps)
}

#[tauri::command]
pub fn db_create_job_run(
    state: tauri::State<'_, Database>,
    job_id: i64,
    trigger: String,
    step_prompts: Vec<String>,
) -> Result<i64, String> {
    state.create_job_run(job_id, &trigger, &step_prompts)
}

#[tauri::command]
pub fn db_mark_run_started(
    state: tauri::State<'_, Database>,
    run_id: i64,
    started_at: i64,
) -> Result<(), String> {
    state.mark_run_started(run_id, started_at)
}

#[tauri::command]
pub fn db_mark_run_finished(
    state: tauri::State<'_, Database>,
    run_id: i64,
    status: String,
    finished_at: i64,
    error: Option<String>,
) -> Result<(), String> {
    state.mark_run_finished(run_id, &status, finished_at, error.as_deref())
}

#[tauri::command]
pub fn db_mark_run_step_started(
    state: tauri::State<'_, Database>,
    run_id: i64,
    ordering: i64,
    started_at: i64,
    prompt_rendered: String,
) -> Result<(), String> {
    state.mark_run_step_started(run_id, ordering, started_at, &prompt_rendered)
}

#[tauri::command]
pub fn db_mark_run_step_finished(
    state: tauri::State<'_, Database>,
    run_id: i64,
    ordering: i64,
    status: String,
    output: Option<String>,
    error: Option<String>,
    finished_at: i64,
) -> Result<(), String> {
    state.mark_run_step_finished(
        run_id,
        ordering,
        &status,
        output.as_deref(),
        error.as_deref(),
        finished_at,
    )
}

#[tauri::command]
pub fn db_list_job_runs(
    state: tauri::State<'_, Database>,
    job_id: i64,
) -> Result<Vec<JobRunSummary>, String> {
    state.list_job_runs(job_id)
}

#[tauri::command]
pub fn db_get_job_run(
    state: tauri::State<'_, Database>,
    run_id: i64,
) -> Result<JobRunWithSteps, String> {
    state.get_job_run(run_id)
}

#[tauri::command]
pub fn db_recover_orphan_runs(state: tauri::State<'_, Database>) -> Result<i64, String> {
    state.recover_orphan_runs()
}

#[tauri::command]
pub fn db_delete_job_run(state: tauri::State<'_, Database>, run_id: i64) -> Result<(), String> {
    state.delete_job_run(run_id)
}

#[tauri::command]
pub fn db_delete_all_job_runs(
    state: tauri::State<'_, Database>,
    job_id: i64,
) -> Result<i64, String> {
    state.delete_all_job_runs(job_id)
}

#[tauri::command]
pub fn db_set_job_next_due_at(
    state: tauri::State<'_, Database>,
    job_id: i64,
    next_due_at: Option<i64>,
) -> Result<(), String> {
    state.set_job_next_due_at(job_id, next_due_at)
}

#[tauri::command]
pub fn db_list_due_jobs(
    state: tauri::State<'_, Database>,
    now_ms: i64,
) -> Result<Vec<JobSummary>, String> {
    state.list_due_jobs(now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_db() -> Database {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let db = Database {
            conn: Mutex::new(conn),
        };
        db.migrate().unwrap();
        db
    }

    #[test]
    fn migration_creates_tables() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let _: i64 = conn
            .query_row("SELECT count(*) FROM conversations", [], |r| r.get(0))
            .unwrap();
        let _: i64 = conn
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
    }

    #[test]
    fn create_and_list_conversations() {
        let db = test_db();
        db.create_conversation("id1", "First chat").unwrap();
        db.create_conversation("id2", "Second chat").unwrap();

        let convs = db.list_conversations().unwrap();
        assert_eq!(convs.len(), 2);
        let ids: Vec<&str> = convs.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"id1"));
        assert!(ids.contains(&"id2"));
    }

    #[test]
    fn save_and_get_messages() {
        let db = test_db();
        db.create_conversation("c1", "Test").unwrap();
        db.save_message("c1", "user", "Hello", None, None).unwrap();
        db.save_message("c1", "assistant", "Hi there!", None, None)
            .unwrap();

        let conv = db.get_conversation("c1").unwrap();
        assert_eq!(conv.messages.len(), 2);
        assert_eq!(conv.messages[0].role, "user");
        assert_eq!(conv.messages[0].content, "Hello");
        assert_eq!(conv.messages[1].role, "assistant");
        assert_eq!(conv.messages[0].sort_order, 1);
        assert_eq!(conv.messages[1].sort_order, 2);
    }

    #[test]
    fn cascade_delete() {
        let db = test_db();
        db.create_conversation("c1", "Test").unwrap();
        db.save_message("c1", "user", "msg1", None, None).unwrap();
        db.save_message("c1", "assistant", "msg2", None, None)
            .unwrap();

        db.delete_conversation("c1").unwrap();

        let convs = db.list_conversations().unwrap();
        assert_eq!(convs.len(), 0);

        // Messages should be gone too
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn rename_conversation() {
        let db = test_db();
        db.create_conversation("c1", "Old title").unwrap();
        db.rename_conversation("c1", "New title").unwrap();

        let convs = db.list_conversations().unwrap();
        assert_eq!(convs[0].title, "New title");
    }

    #[test]
    fn clear_all() {
        let db = test_db();
        db.create_conversation("c1", "Chat 1").unwrap();
        db.create_conversation("c2", "Chat 2").unwrap();
        db.save_message("c1", "user", "msg", None, None).unwrap();

        db.clear_all_conversations().unwrap();

        assert_eq!(db.list_conversations().unwrap().len(), 0);
    }

    #[test]
    fn stats_upsert_creates_row_then_accumulates() {
        let db = test_db();
        let now = 1_700_000_000_000_i64;

        // First success: row didn't exist, gets created and counters bumped.
        db.update_engine_stat(
            "duckduckgo",
            &EngineStatDelta {
                attempt: true,
                success: true,
                latency_ms: 250,
                now_ms: now,
                first_choice: true,
                ..Default::default()
            },
        )
        .unwrap();

        // Second success: row exists, counters accumulate.
        db.update_engine_stat(
            "duckduckgo",
            &EngineStatDelta {
                attempt: true,
                success: true,
                latency_ms: 500,
                now_ms: now + 1000,
                fallback: true,
                fallback_success: true,
                ..Default::default()
            },
        )
        .unwrap();

        // Third call: failure (rate-limited).
        db.update_engine_stat(
            "duckduckgo",
            &EngineStatDelta {
                attempt: true,
                failure_column: Some("fail_rate_limited"),
                now_ms: now + 2000,
                first_choice: true,
                ..Default::default()
            },
        )
        .unwrap();

        let snap = db.lifetime_stats_snapshot().unwrap();
        assert_eq!(snap.engines.len(), 1);
        let e = &snap.engines[0];
        assert_eq!(e.engine, "duckduckgo");
        assert_eq!(e.attempts, 3);
        assert_eq!(e.successes, 2);
        assert_eq!(e.fail_rate_limited, 1);
        assert_eq!(e.fail_http, 0);
        assert_eq!(e.total_latency_ms, 750);
        assert_eq!(e.max_latency_ms, 500);
        assert_eq!(e.last_success_at, Some(now + 1000));
        assert_eq!(e.last_failure_at, Some(now + 2000));
        assert_eq!(e.first_choice_attempts, 2);
        assert_eq!(e.fallback_attempts, 1);
        assert_eq!(e.fallback_successes, 1);
    }

    #[test]
    fn stats_invalid_failure_column_rejected() {
        let db = test_db();
        let result = db.update_engine_stat(
            "x",
            &EngineStatDelta {
                attempt: true,
                failure_column: Some("fail_drop_tables"),
                ..Default::default()
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn stats_globals_increment() {
        let db = test_db();
        db.increment_global("cache_hits").unwrap();
        db.increment_global("cache_hits").unwrap();
        db.increment_global("total_queries").unwrap();

        let snap = db.lifetime_stats_snapshot().unwrap();
        assert_eq!(snap.globals.get("cache_hits"), Some(&2));
        assert_eq!(snap.globals.get("total_queries"), Some(&1));
    }

    #[test]
    fn stats_reset_clears_everything() {
        let db = test_db();
        db.update_engine_stat(
            "brave_html",
            &EngineStatDelta {
                attempt: true,
                success: true,
                latency_ms: 100,
                now_ms: 1,
                ..Default::default()
            },
        )
        .unwrap();
        db.increment_global("cache_hits").unwrap();

        db.reset_lifetime_stats().unwrap();

        let snap = db.lifetime_stats_snapshot().unwrap();
        assert!(snap.engines.is_empty());
        assert!(snap.globals.is_empty());
    }

    fn sample_job_input(name: &str) -> JobInput {
        JobInput {
            name: name.to_string(),
            description: Some("desc".to_string()),
            working_dir: "/tmp/work".to_string(),
            auto_approve_tools: false,
            schedule_kind: "manual".to_string(),
            schedule_config: None,
            next_due_at: None,
        }
    }

    fn step(prompt: &str) -> JobStepInput {
        JobStepInput {
            prompt: prompt.to_string(),
            deep_research: false,
        }
    }

    fn deep_step(prompt: &str) -> JobStepInput {
        JobStepInput {
            prompt: prompt.to_string(),
            deep_research: true,
        }
    }

    #[test]
    fn jobs_migration_creates_tables() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        for table in ["jobs", "job_steps", "job_runs", "job_run_steps"] {
            let count: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {}", table), [], |r| r.get(0))
                .unwrap_or_else(|e| panic!("missing table {}: {}", table, e));
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn create_and_list_jobs() {
        let db = test_db();
        let id1 = db
            .create_job(&sample_job_input("Morning headlines"))
            .unwrap();
        let id2 = db.create_job(&sample_job_input("Weekly digest")).unwrap();
        assert_ne!(id1, id2);

        let jobs = db.list_jobs().unwrap();
        assert_eq!(jobs.len(), 2);
        let names: Vec<&str> = jobs.iter().map(|j| j.name.as_str()).collect();
        assert!(names.contains(&"Morning headlines"));
        assert!(names.contains(&"Weekly digest"));
        // newly created jobs report zero steps
        assert!(jobs.iter().all(|j| j.step_count == 0));
    }

    #[test]
    fn get_job_returns_ordered_steps() {
        let db = test_db();
        let id = db.create_job(&sample_job_input("Job A")).unwrap();
        db.replace_job_steps(
            id,
            &[
                step("first prompt"),
                deep_step("second prompt"),
                step("third prompt"),
            ],
        )
        .unwrap();

        let job = db.get_job(id).unwrap();
        assert_eq!(job.steps.len(), 3);
        assert_eq!(job.steps[0].ordering, 0);
        assert_eq!(job.steps[0].prompt, "first prompt");
        assert!(!job.steps[0].deep_research);
        assert_eq!(job.steps[1].ordering, 1);
        assert!(job.steps[1].deep_research);
        assert_eq!(job.steps[2].prompt, "third prompt");
        assert!(!job.steps[2].deep_research);
    }

    #[test]
    fn replace_job_steps_overwrites_previous_set() {
        let db = test_db();
        let id = db.create_job(&sample_job_input("Job B")).unwrap();
        db.replace_job_steps(id, &[step("a"), step("b"), step("c")])
            .unwrap();
        db.replace_job_steps(id, &[deep_step("only one")]).unwrap();

        let job = db.get_job(id).unwrap();
        assert_eq!(job.steps.len(), 1);
        assert_eq!(job.steps[0].ordering, 0);
        assert_eq!(job.steps[0].prompt, "only one");
        assert!(job.steps[0].deep_research);
    }

    #[test]
    fn update_job_changes_fields_and_bumps_timestamp() {
        let db = test_db();
        let id = db.create_job(&sample_job_input("Original")).unwrap();
        let before = db.get_job(id).unwrap();

        // Wait a millisecond so updated_at can actually advance
        std::thread::sleep(std::time::Duration::from_millis(2));

        db.update_job(
            id,
            &JobInput {
                name: "Renamed".to_string(),
                description: None,
                working_dir: "/tmp/other".to_string(),
                auto_approve_tools: true,
                schedule_kind: "daily".to_string(),
                schedule_config: Some(r#"{"time":"09:00"}"#.to_string()),
                next_due_at: Some(1234567890),
            },
        )
        .unwrap();

        let after = db.get_job(id).unwrap();
        assert_eq!(after.name, "Renamed");
        assert_eq!(after.description, None);
        assert_eq!(after.working_dir, "/tmp/other");
        assert!(after.auto_approve_tools);
        assert_eq!(after.schedule_kind, "daily");
        assert_eq!(
            after.schedule_config.as_deref(),
            Some(r#"{"time":"09:00"}"#)
        );
        assert_eq!(after.next_due_at, Some(1234567890));
        assert!(after.updated_at > before.updated_at);
        assert_eq!(after.created_at, before.created_at);
    }

    #[test]
    fn set_job_next_due_at_updates_only_that_column() {
        let db = test_db();
        let id = db.create_job(&sample_job_input("A")).unwrap();
        let before = db.get_job(id).unwrap();

        db.set_job_next_due_at(id, Some(42000)).unwrap();
        let after = db.get_job(id).unwrap();
        assert_eq!(after.next_due_at, Some(42000));
        // Other fields are untouched.
        assert_eq!(after.name, before.name);
        assert_eq!(after.schedule_kind, before.schedule_kind);

        db.set_job_next_due_at(id, None).unwrap();
        let cleared = db.get_job(id).unwrap();
        assert!(cleared.next_due_at.is_none());
    }

    #[test]
    fn set_job_next_due_at_errors_for_missing_job() {
        let db = test_db();
        let result = db.set_job_next_due_at(9999, Some(1));
        assert!(result.is_err());
    }

    #[test]
    fn list_due_jobs_returns_only_past_due_non_manual_rows() {
        let db = test_db();

        let mut due_now = sample_job_input("Past due");
        due_now.schedule_kind = "interval".to_string();
        due_now.schedule_config = Some(r#"{"minutes":5}"#.to_string());
        due_now.next_due_at = Some(100);
        let id_past = db.create_job(&due_now).unwrap();

        let mut future = sample_job_input("Future");
        future.schedule_kind = "daily".to_string();
        future.schedule_config = Some(r#"{"time":"09:00"}"#.to_string());
        future.next_due_at = Some(10_000);
        let _id_future = db.create_job(&future).unwrap();

        // Manual job with a (nonsense) next_due_at — must be excluded
        // because the scheduler should never fire manual jobs.
        let mut manual = sample_job_input("Manual");
        manual.schedule_kind = "manual".to_string();
        manual.next_due_at = Some(0);
        db.create_job(&manual).unwrap();

        // Scheduled but next_due_at is NULL — also excluded.
        let mut null_due = sample_job_input("Null");
        null_due.schedule_kind = "hourly".to_string();
        null_due.next_due_at = None;
        db.create_job(&null_due).unwrap();

        let due = db.list_due_jobs(500).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, id_past);
    }

    #[test]
    fn list_due_jobs_orders_by_next_due_ascending() {
        let db = test_db();
        let mut a = sample_job_input("A");
        a.schedule_kind = "interval".to_string();
        a.schedule_config = Some(r#"{"minutes":1}"#.to_string());
        a.next_due_at = Some(300);
        let id_a = db.create_job(&a).unwrap();

        let mut b = sample_job_input("B");
        b.schedule_kind = "interval".to_string();
        b.schedule_config = Some(r#"{"minutes":1}"#.to_string());
        b.next_due_at = Some(100);
        let id_b = db.create_job(&b).unwrap();

        let mut c = sample_job_input("C");
        c.schedule_kind = "interval".to_string();
        c.schedule_config = Some(r#"{"minutes":1}"#.to_string());
        c.next_due_at = Some(200);
        let id_c = db.create_job(&c).unwrap();

        let due = db.list_due_jobs(1_000).unwrap();
        let ids: Vec<i64> = due.iter().map(|j| j.id).collect();
        assert_eq!(ids, vec![id_b, id_c, id_a]);
    }

    #[test]
    fn update_missing_job_errors() {
        let db = test_db();
        let result = db.update_job(9999, &sample_job_input("ghost"));
        assert!(result.is_err());
    }

    #[test]
    fn delete_job_cascades_to_steps() {
        let db = test_db();
        let id = db.create_job(&sample_job_input("Doomed")).unwrap();
        db.replace_job_steps(id, &[step("x"), step("y")]).unwrap();

        db.delete_job(id).unwrap();

        assert_eq!(db.list_jobs().unwrap().len(), 0);
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM job_steps", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn delete_job_cascades_to_runs_and_run_steps() {
        let db = test_db();
        let id = db.create_job(&sample_job_input("Run-bearing")).unwrap();
        // Insert a synthetic run + run step directly; the runner that
        // populates these lands in a later phase, but FK cascade should
        // already be in place.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO job_runs (job_id, status, trigger, queued_at)
                 VALUES (?1, 'succeeded', 'manual', 0)",
                params![id],
            )
            .unwrap();
            let run_id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO job_run_steps
                    (run_id, ordering, prompt_authored, prompt_rendered, status)
                 VALUES (?1, 0, 'p', 'p', 'succeeded')",
                params![run_id],
            )
            .unwrap();
        }

        db.delete_job(id).unwrap();
        let conn = db.conn.lock().unwrap();
        let runs: i64 = conn
            .query_row("SELECT count(*) FROM job_runs", [], |r| r.get(0))
            .unwrap();
        let run_steps: i64 = conn
            .query_row("SELECT count(*) FROM job_run_steps", [], |r| r.get(0))
            .unwrap();
        assert_eq!(runs, 0);
        assert_eq!(run_steps, 0);
    }

    #[test]
    fn delete_job_run_removes_one_and_cascades_steps() {
        let db = test_db();
        let job_id = db.create_job(&sample_job_input("rj")).unwrap();
        let mut run_ids = vec![];
        {
            let conn = db.conn.lock().unwrap();
            for _ in 0..2 {
                conn.execute(
                    "INSERT INTO job_runs (job_id, status, trigger, queued_at)
                     VALUES (?1, 'succeeded', 'manual', 0)",
                    params![job_id],
                )
                .unwrap();
                let run_id = conn.last_insert_rowid();
                run_ids.push(run_id);
                conn.execute(
                    "INSERT INTO job_run_steps
                        (run_id, ordering, prompt_authored, prompt_rendered, status)
                     VALUES (?1, 0, 'p', 'p', 'succeeded')",
                    params![run_id],
                )
                .unwrap();
            }
        }

        db.delete_job_run(run_ids[0]).unwrap();

        let remaining = db.list_job_runs(job_id).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, run_ids[1]);

        let conn = db.conn.lock().unwrap();
        let orphan_steps: i64 = conn
            .query_row(
                "SELECT count(*) FROM job_run_steps WHERE run_id = ?1",
                params![run_ids[0]],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan_steps, 0);
    }

    #[test]
    fn delete_all_job_runs_clears_only_target_job() {
        let db = test_db();
        let keep_id = db.create_job(&sample_job_input("keep")).unwrap();
        let wipe_id = db.create_job(&sample_job_input("wipe")).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            for jid in [keep_id, wipe_id, wipe_id] {
                conn.execute(
                    "INSERT INTO job_runs (job_id, status, trigger, queued_at)
                     VALUES (?1, 'succeeded', 'manual', 0)",
                    params![jid],
                )
                .unwrap();
            }
        }

        let n = db.delete_all_job_runs(wipe_id).unwrap();
        assert_eq!(n, 2);
        assert_eq!(db.list_job_runs(wipe_id).unwrap().len(), 0);
        assert_eq!(db.list_job_runs(keep_id).unwrap().len(), 1);
    }

    #[test]
    fn list_jobs_reports_step_count() {
        let db = test_db();
        let id_a = db.create_job(&sample_job_input("A")).unwrap();
        let id_b = db.create_job(&sample_job_input("B")).unwrap();
        db.replace_job_steps(id_a, &[step("s1"), step("s2")])
            .unwrap();
        db.replace_job_steps(id_b, &[step("only")]).unwrap();

        let jobs = db.list_jobs().unwrap();
        let by_id: HashMap<i64, &JobSummary> = jobs.iter().map(|j| (j.id, j)).collect();
        assert_eq!(by_id[&id_a].step_count, 2);
        assert_eq!(by_id[&id_b].step_count, 1);
    }

    #[test]
    fn schedule_config_round_trips_as_opaque_json() {
        let db = test_db();
        let json = r#"{"day":"mon","time":"09:30"}"#.to_string();
        let id = db
            .create_job(&JobInput {
                name: "Weekly".to_string(),
                description: None,
                working_dir: "/x".to_string(),
                auto_approve_tools: false,
                schedule_kind: "weekly".to_string(),
                schedule_config: Some(json.clone()),
                next_due_at: None,
            })
            .unwrap();
        let job = db.get_job(id).unwrap();
        assert_eq!(job.schedule_config, Some(json));
    }

    fn job_with_steps(db: &Database, name: &str, prompts: &[&str]) -> i64 {
        let job_id = db.create_job(&sample_job_input(name)).unwrap();
        let steps: Vec<JobStepInput> = prompts.iter().map(|p| step(p)).collect();
        db.replace_job_steps(job_id, &steps).unwrap();
        job_id
    }

    #[test]
    fn create_job_run_inserts_run_plus_pending_steps() {
        let db = test_db();
        let job_id = job_with_steps(&db, "Pipelined", &["step a", "step b"]);

        let run_id = db
            .create_job_run(
                job_id,
                "manual",
                &["step a".to_string(), "step b".to_string()],
            )
            .unwrap();

        let run = db.get_job_run(run_id).unwrap();
        assert_eq!(run.job_id, job_id);
        assert_eq!(run.status, "queued");
        assert_eq!(run.trigger, "manual");
        assert!(run.started_at.is_none());
        assert!(run.finished_at.is_none());
        assert_eq!(run.steps.len(), 2);
        for (i, s) in run.steps.iter().enumerate() {
            assert_eq!(s.ordering, i as i64);
            assert_eq!(s.status, "pending");
            assert_eq!(s.prompt_authored, s.prompt_rendered);
            assert!(s.output.is_none());
            assert!(s.started_at.is_none());
            assert!(s.finished_at.is_none());
        }
    }

    #[test]
    fn run_lifecycle_transitions_persist_correctly() {
        let db = test_db();
        let job_id = job_with_steps(&db, "Two-step", &["a", "b"]);
        let run_id = db
            .create_job_run(job_id, "manual", &["a".to_string(), "b".to_string()])
            .unwrap();

        db.mark_run_started(run_id, 100).unwrap();
        db.mark_run_step_started(run_id, 0, 100, "a").unwrap();
        db.mark_run_step_finished(run_id, 0, "succeeded", Some("a-output"), None, 200)
            .unwrap();
        db.mark_run_step_started(run_id, 1, 200, "a-output\n\nb")
            .unwrap();
        db.mark_run_step_finished(run_id, 1, "succeeded", Some("b-output"), None, 300)
            .unwrap();
        db.mark_run_finished(run_id, "succeeded", 300, None)
            .unwrap();

        let run = db.get_job_run(run_id).unwrap();
        assert_eq!(run.status, "succeeded");
        assert_eq!(run.started_at, Some(100));
        assert_eq!(run.finished_at, Some(300));
        assert!(run.error.is_none());
        assert_eq!(run.steps[0].status, "succeeded");
        assert_eq!(run.steps[0].output.as_deref(), Some("a-output"));
        assert_eq!(run.steps[1].status, "succeeded");
        assert_eq!(run.steps[1].prompt_rendered, "a-output\n\nb");
        assert_eq!(run.steps[1].output.as_deref(), Some("b-output"));
    }

    #[test]
    fn failure_path_records_error_on_run_and_step() {
        let db = test_db();
        let job_id = job_with_steps(&db, "Will fail", &["a", "b"]);
        let run_id = db
            .create_job_run(job_id, "scheduled", &["a".to_string(), "b".to_string()])
            .unwrap();

        db.mark_run_started(run_id, 10).unwrap();
        db.mark_run_step_started(run_id, 0, 10, "a").unwrap();
        db.mark_run_step_finished(run_id, 0, "succeeded", Some("ok"), None, 20)
            .unwrap();
        db.mark_run_step_started(run_id, 1, 20, "ok\n\nb").unwrap();
        db.mark_run_step_finished(run_id, 1, "failed", None, Some("boom"), 30)
            .unwrap();
        db.mark_run_finished(run_id, "failed", 30, Some("boom"))
            .unwrap();

        let run = db.get_job_run(run_id).unwrap();
        assert_eq!(run.status, "failed");
        assert_eq!(run.trigger, "scheduled");
        assert_eq!(run.error.as_deref(), Some("boom"));
        assert_eq!(run.steps[1].status, "failed");
        assert_eq!(run.steps[1].error.as_deref(), Some("boom"));
    }

    #[test]
    fn list_job_runs_orders_newest_first() {
        let db = test_db();
        let job_id = job_with_steps(&db, "Many runs", &["a"]);

        let r1 = db
            .create_job_run(job_id, "manual", &["a".to_string()])
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let r2 = db
            .create_job_run(job_id, "manual", &["a".to_string()])
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let r3 = db
            .create_job_run(job_id, "scheduled", &["a".to_string()])
            .unwrap();

        let runs = db.list_job_runs(job_id).unwrap();
        let ids: Vec<i64> = runs.iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![r3, r2, r1]);
    }

    #[test]
    fn mark_run_started_does_not_overwrite_already_running() {
        // If the runner double-fires (shouldn't happen, but be defensive)
        // mark_run_started must not reset started_at on a row that's
        // already moved past 'queued'.
        let db = test_db();
        let job_id = job_with_steps(&db, "Idempotent", &["a"]);
        let run_id = db
            .create_job_run(job_id, "manual", &["a".to_string()])
            .unwrap();
        db.mark_run_started(run_id, 100).unwrap();
        db.mark_run_started(run_id, 999).unwrap();
        let run = db.get_job_run(run_id).unwrap();
        assert_eq!(run.started_at, Some(100));
    }

    #[test]
    fn delete_job_cascades_runs_and_run_steps() {
        let db = test_db();
        let job_id = job_with_steps(&db, "Doomed pipeline", &["a", "b"]);
        let run_id = db
            .create_job_run(job_id, "manual", &["a".to_string(), "b".to_string()])
            .unwrap();
        db.mark_run_started(run_id, 1).unwrap();
        db.mark_run_step_started(run_id, 0, 1, "a").unwrap();

        db.delete_job(job_id).unwrap();

        assert!(db.list_job_runs(job_id).unwrap().is_empty());
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM job_run_steps", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn recover_orphan_runs_sweeps_running_and_queued() {
        let db = test_db();
        let job_id = job_with_steps(&db, "Will be orphaned", &["a", "b"]);

        // One run that got as far as starting step 0, then the app died.
        let r1 = db
            .create_job_run(job_id, "manual", &["a".to_string(), "b".to_string()])
            .unwrap();
        db.mark_run_started(r1, 100).unwrap();
        db.mark_run_step_started(r1, 0, 100, "a").unwrap();

        // One run that never even started (queued only).
        let r2 = db
            .create_job_run(job_id, "scheduled", &["a".to_string(), "b".to_string()])
            .unwrap();

        // One previously-completed run that must NOT be touched.
        let r3 = db
            .create_job_run(job_id, "manual", &["a".to_string(), "b".to_string()])
            .unwrap();
        db.mark_run_started(r3, 50).unwrap();
        db.mark_run_step_started(r3, 0, 50, "a").unwrap();
        db.mark_run_step_finished(r3, 0, "succeeded", Some("out"), None, 60)
            .unwrap();
        db.mark_run_step_started(r3, 1, 60, "out\n\nb").unwrap();
        db.mark_run_step_finished(r3, 1, "succeeded", Some("done"), None, 70)
            .unwrap();
        db.mark_run_finished(r3, "succeeded", 70, None).unwrap();

        let swept = db.recover_orphan_runs().unwrap();
        assert_eq!(swept, 2);

        let run1 = db.get_job_run(r1).unwrap();
        assert_eq!(run1.status, "interrupted");
        assert!(run1.finished_at.is_some());
        assert!(run1.error.as_deref().unwrap_or("").contains("closed"));
        // Step 0 was 'running' → swept to 'cancelled'. Step 1 was 'pending'
        // → untouched.
        assert_eq!(run1.steps[0].status, "cancelled");
        assert!(run1.steps[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("closed"));
        assert_eq!(run1.steps[1].status, "pending");

        let run2 = db.get_job_run(r2).unwrap();
        assert_eq!(run2.status, "interrupted");
        assert_eq!(run2.steps[0].status, "pending");

        let run3 = db.get_job_run(r3).unwrap();
        assert_eq!(run3.status, "succeeded");
        assert_eq!(run3.finished_at, Some(70));
    }

    #[test]
    fn recover_orphan_runs_is_idempotent() {
        let db = test_db();
        let job_id = job_with_steps(&db, "Orphan", &["a"]);
        let run_id = db
            .create_job_run(job_id, "manual", &["a".to_string()])
            .unwrap();
        db.mark_run_started(run_id, 1).unwrap();

        let first = db.recover_orphan_runs().unwrap();
        let second = db.recover_orphan_runs().unwrap();
        assert_eq!(first, 1);
        assert_eq!(second, 0);

        let run = db.get_job_run(run_id).unwrap();
        assert_eq!(run.status, "interrupted");
    }

    #[test]
    fn recover_orphan_runs_preserves_existing_finished_at() {
        // Edge case: a run row that's stuck at 'running' but somehow has
        // a finished_at already (shouldn't happen, but be defensive). The
        // sweep must not stomp the existing timestamp.
        let db = test_db();
        let job_id = job_with_steps(&db, "Edge", &["a"]);
        let run_id = db
            .create_job_run(job_id, "manual", &["a".to_string()])
            .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE job_runs SET status = 'running', started_at = 10, finished_at = 999
                 WHERE id = ?1",
                params![run_id],
            )
            .unwrap();
        }
        db.recover_orphan_runs().unwrap();
        let run = db.get_job_run(run_id).unwrap();
        assert_eq!(run.status, "interrupted");
        assert_eq!(run.finished_at, Some(999));
    }

    #[test]
    fn save_message_with_tool_calls() {
        let db = test_db();
        db.create_conversation("c1", "Test").unwrap();
        db.save_message(
            "c1",
            "assistant",
            "",
            Some(r#"[{"id":"call_1","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"test\"}"}}]"#),
            None,
        )
        .unwrap();
        db.save_message("c1", "tool", "search results here", None, Some("call_1"))
            .unwrap();

        let conv = db.get_conversation("c1").unwrap();
        assert_eq!(conv.messages.len(), 2);
        assert!(conv.messages[0].tool_calls.is_some());
        assert_eq!(conv.messages[1].tool_call_id.as_deref(), Some("call_1"));
    }
}
