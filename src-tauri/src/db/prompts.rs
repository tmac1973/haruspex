use super::*;
use rusqlite::params;

impl Database {
    pub fn create_prompt(&self, input: &SavedPromptInput) -> Result<i64, String> {
        let conn = self.conn();
        let now = chrono_now();
        conn.execute(
            "INSERT INTO prompt_catalog (name, scope, prompt, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![input.name, input.scope, input.prompt, now],
        )
        .map_err(|e| format!("Prompt insert failed: {}", e))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_prompts(&self) -> Result<Vec<SavedPrompt>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, scope, prompt, created_at
                 FROM prompt_catalog
                 ORDER BY name COLLATE NOCASE ASC",
            )
            .map_err(|e| format!("Prompts query failed: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(SavedPrompt {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    scope: row.get(2)?,
                    prompt: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| format!("Prompts query failed: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Prompts row read failed: {}", e))
    }

    pub fn delete_prompt(&self, id: i64) -> Result<(), String> {
        let conn = self.conn();
        conn.execute("DELETE FROM prompt_catalog WHERE id = ?1", params![id])
            .map_err(|e| format!("Prompt delete failed: {}", e))?;
        Ok(())
    }
}
