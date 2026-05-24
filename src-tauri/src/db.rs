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
            );",
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
