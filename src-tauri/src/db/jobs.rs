use super::*;
use rusqlite::params;

/// The `SELECT` column list backing every `JobSummary` query — kept in one
/// place so `list_jobs` and `list_due_jobs` (which differ only in WHERE/ORDER
/// BY) can't drift on column order, and so [`row_to_job_summary`]'s indices
/// stay valid.
const JOB_SUMMARY_COLS: &str = "j.id, j.name, j.description, j.working_dir, j.auto_approve_tools,
                        j.job_type, j.schedule_kind, j.schedule_config, j.next_due_at,
                        j.created_at, j.updated_at,
                        (SELECT COUNT(*) FROM job_steps s WHERE s.job_id = j.id) AS step_count";

/// Every job column written from a [`JobInput`], in binding order. The
/// INSERT (`create_job`), UPDATE (`update_job`), and full SELECT (`get_job`)
/// all derive their SQL from this table, and [`job_write_params`] binds the
/// input fields in the same order — so adding a job column means extending
/// this list, `job_write_params`, and `get_job`'s row decode, with no
/// hand-counted `?N` placeholders to renumber.
const JOB_WRITE_COLS: &[&str] = &[
    "name",
    "description",
    "working_dir",
    "auto_approve_tools",
    "job_type",
    "schedule_kind",
    "schedule_config",
    "next_due_at",
    "type_config",
    "model_remote_base_url",
    "model_remote_api_key",
    "model_remote_model_id",
    "model_remote_context_size",
    "model_remote_vision_supported",
    "model_remote_api_key_id",
];

/// A [`JobInput`]'s fields as SQL parameters, in [`JOB_WRITE_COLS`] order.
/// (rusqlite encodes `bool` as INTEGER 0/1, matching the old `as i64` casts.)
fn job_write_params(input: &JobInput) -> Vec<&dyn rusqlite::ToSql> {
    vec![
        &input.name,
        &input.description,
        &input.working_dir,
        &input.auto_approve_tools,
        &input.job_type,
        &input.schedule_kind,
        &input.schedule_config,
        &input.next_due_at,
        &input.type_config,
        &input.model_remote_base_url,
        &input.model_remote_api_key,
        &input.model_remote_model_id,
        &input.model_remote_context_size,
        &input.model_remote_vision_supported,
        &input.model_remote_api_key_id,
    ]
}

/// Decode one row of a [`JOB_SUMMARY_COLS`] query into a [`JobSummary`].
fn row_to_job_summary(row: &rusqlite::Row) -> rusqlite::Result<JobSummary> {
    Ok(JobSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        working_dir: row.get(3)?,
        auto_approve_tools: row.get::<_, i64>(4)? != 0,
        job_type: row.get(5)?,
        schedule_kind: row.get(6)?,
        schedule_config: row.get(7)?,
        next_due_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        step_count: row.get(11)?,
    })
}

impl Database {
    pub fn create_job(&self, input: &JobInput) -> Result<i64, String> {
        let conn = self.conn();
        let now = chrono_now();
        let n = JOB_WRITE_COLS.len();
        let placeholders: Vec<String> = (1..=n).map(|i| format!("?{i}")).collect();
        // created_at and updated_at both bind the trailing `now` param.
        let sql = format!(
            "INSERT INTO jobs ({}, created_at, updated_at) VALUES ({}, ?{}, ?{})",
            JOB_WRITE_COLS.join(", "),
            placeholders.join(", "),
            n + 1,
            n + 1
        );
        let mut params = job_write_params(input);
        params.push(&now);
        conn.execute(&sql, &params[..])
            .map_err(|e| format!("Job insert failed: {}", e))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_jobs(&self) -> Result<Vec<JobSummary>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {JOB_SUMMARY_COLS}
                 FROM jobs j
                 ORDER BY j.updated_at DESC"
            ))
            .map_err(|e| format!("Jobs query failed: {}", e))?;

        let rows = stmt
            .query_map([], row_to_job_summary)
            .map_err(|e| format!("Jobs query failed: {}", e))?;

        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(row.map_err(|e| format!("Jobs row read failed: {}", e))?);
        }
        Ok(jobs)
    }

    pub fn get_job(&self, id: i64) -> Result<JobWithSteps, String> {
        let conn = self.conn();

        // Columns in JOB_WRITE_COLS order (indices 0..=14), then the two
        // DB-assigned timestamps — decode indices below must match.
        let sql = format!(
            "SELECT {}, created_at, updated_at FROM jobs WHERE id = ?1",
            JOB_WRITE_COLS.join(", ")
        );
        let (
            name,
            description,
            working_dir,
            auto_approve_tools,
            job_type,
            schedule_kind,
            schedule_config,
            next_due_at,
            type_config,
            model_remote_base_url,
            model_remote_api_key,
            model_remote_model_id,
            model_remote_context_size,
            model_remote_vision_supported,
            model_remote_api_key_id,
            created_at,
            updated_at,
        ) = conn
            .query_row(&sql, params![id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? != 0,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                    row.get::<_, Option<bool>>(13)?,
                    row.get::<_, Option<String>>(14)?,
                    row.get::<_, i64>(15)?,
                    row.get::<_, i64>(16)?,
                ))
            })
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
            job_type,
            schedule_kind,
            schedule_config,
            next_due_at,
            created_at,
            updated_at,
            steps,
            type_config,
            model_remote_base_url,
            model_remote_api_key,
            model_remote_model_id,
            model_remote_context_size,
            model_remote_vision_supported,
            model_remote_api_key_id,
        })
    }

    pub fn update_job(&self, id: i64, input: &JobInput) -> Result<(), String> {
        let conn = self.conn();
        let now = chrono_now();
        let n = JOB_WRITE_COLS.len();
        let assignments: Vec<String> = JOB_WRITE_COLS
            .iter()
            .enumerate()
            .map(|(i, col)| format!("{} = ?{}", col, i + 1))
            .collect();
        let sql = format!(
            "UPDATE jobs SET {}, updated_at = ?{} WHERE id = ?{}",
            assignments.join(", "),
            n + 1,
            n + 2
        );
        let mut params = job_write_params(input);
        params.push(&now);
        params.push(&id);
        let affected = conn
            .execute(&sql, &params[..])
            .map_err(|e| format!("Job update failed: {}", e))?;
        if affected == 0 {
            return Err(format!("No job with id {}", id));
        }
        Ok(())
    }

    pub fn set_job_next_due_at(&self, job_id: i64, next_due_at: Option<i64>) -> Result<(), String> {
        let conn = self.conn();
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
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {JOB_SUMMARY_COLS}
                 FROM jobs j
                 WHERE j.schedule_kind != 'manual'
                   AND j.next_due_at IS NOT NULL
                   AND j.next_due_at <= ?1
                 ORDER BY j.next_due_at ASC"
            ))
            .map_err(|e| format!("Due jobs query failed: {}", e))?;

        let rows = stmt
            .query_map(params![now_ms], row_to_job_summary)
            .map_err(|e| format!("Due jobs query failed: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Due jobs row read failed: {}", e))
    }

    pub fn delete_job(&self, id: i64) -> Result<(), String> {
        let conn = self.conn();
        conn.execute("DELETE FROM jobs WHERE id = ?1", params![id])
            .map_err(|e| format!("Job delete failed: {}", e))?;
        Ok(())
    }

    pub fn replace_job_steps(&self, job_id: i64, steps: &[JobStepInput]) -> Result<(), String> {
        let mut conn = self.conn();
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
}
