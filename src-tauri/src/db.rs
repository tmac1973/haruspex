use log::info;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

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
                ON messages(conversation_id, sort_order);",
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
