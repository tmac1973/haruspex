use super::*;
use rusqlite::params;

impl Database {
    pub fn list_conversations(&self) -> Result<Vec<ConversationSummary>, String> {
        let conn = self.conn();
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
        let conn = self.conn();

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
                "SELECT id, conversation_id, role, content, tool_calls, tool_call_id, created_at, sort_order, steps
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
                    steps: row.get(8)?,
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
        let conn = self.conn();
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
        steps: Option<&str>,
    ) -> Result<i64, String> {
        let conn = self.conn();
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
            "INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id, created_at, sort_order, steps)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![conversation_id, role, content, tool_calls, tool_call_id, now, sort_order, steps],
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
        let conn = self.conn();
        conn.execute(
            "UPDATE conversations SET title = ?1 WHERE id = ?2",
            params![title, id],
        )
        .map_err(|e| format!("Update failed: {}", e))?;
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> Result<(), String> {
        let conn = self.conn();
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])
            .map_err(|e| format!("Delete failed: {}", e))?;
        Ok(())
    }

    pub fn clear_all_conversations(&self) -> Result<(), String> {
        let conn = self.conn();
        conn.execute_batch("DELETE FROM messages; DELETE FROM conversations;")
            .map_err(|e| format!("Clear failed: {}", e))?;
        Ok(())
    }

    pub fn replace_messages(
        &self,
        conversation_id: &str,
        messages: &[MessageInput],
    ) -> Result<(), String> {
        let conn = self.conn();
        let now = chrono_now();

        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )
        .map_err(|e| format!("Delete failed: {}", e))?;

        for (i, msg) in messages.iter().enumerate() {
            conn.execute(
                "INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id, created_at, sort_order, steps)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    conversation_id,
                    msg.role,
                    msg.content,
                    msg.tool_calls,
                    msg.tool_call_id,
                    now,
                    i as i64 + 1,
                    msg.steps
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

    /// Update the `steps` JSON for the most recently inserted message in a
    /// conversation. Used after the agent loop finishes to attach captured
    /// artifacts to the assistant message persisted at the start of streaming.
    pub fn update_last_message_steps(
        &self,
        conversation_id: &str,
        steps: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "UPDATE messages SET steps = ?1 \
             WHERE id = ( \
                 SELECT id FROM messages WHERE conversation_id = ?2 \
                 ORDER BY sort_order DESC LIMIT 1 \
             )",
            params![steps, conversation_id],
        )
        .map_err(|e| format!("Update failed: {}", e))?;
        Ok(())
    }
}
