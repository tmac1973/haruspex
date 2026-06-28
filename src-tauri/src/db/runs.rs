use super::*;
use rusqlite::params;

impl Database {
    pub fn create_job_run(
        &self,
        job_id: i64,
        trigger: &str,
        step_prompts: &[String],
    ) -> Result<i64, String> {
        let mut conn = self.conn();
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
        let conn = self.conn();
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
        let conn = self.conn();
        conn.execute(
            "UPDATE job_runs SET status = ?1, finished_at = ?2, error = ?3
             WHERE id = ?4",
            params![status, finished_at, error, run_id],
        )
        .map_err(|e| format!("Run finish update failed: {}", e))?;
        Ok(())
    }

    /// Persist (or clear) the guided_planning resume blob for a run. Called by
    /// the runner at each milestone so a closed/crashed session can resume.
    // Wired up by the guided_planning runner (Phase 05); unused until then.
    #[allow(dead_code)]
    pub fn set_run_planning_state(
        &self,
        run_id: i64,
        planning_state: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "UPDATE job_runs SET planning_state = ?1 WHERE id = ?2",
            params![planning_state, run_id],
        )
        .map_err(|e| format!("planning_state update failed: {}", e))?;
        Ok(())
    }

    /// Set a run's status without touching its finished/started timestamps.
    /// Used to park a guided_planning run as `needs_input` (and to un-park it
    /// back to `running` on resume) — distinct from mark_run_finished, which is
    /// terminal.
    // Wired up by the guided_planning runner (Phase 05); unused until then.
    #[allow(dead_code)]
    pub fn set_run_status(&self, run_id: i64, status: &str) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "UPDATE job_runs SET status = ?1 WHERE id = ?2",
            params![status, run_id],
        )
        .map_err(|e| format!("Run status update failed: {}", e))?;
        Ok(())
    }

    pub fn mark_run_step_started(
        &self,
        run_id: i64,
        ordering: i64,
        started_at: i64,
        prompt_rendered: &str,
    ) -> Result<(), String> {
        let conn = self.conn();
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
        let conn = self.conn();
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
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, job_id, status, trigger, queued_at, started_at, finished_at, error,
                        planning_state
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
                    planning_state: row.get(8)?,
                })
            })
            .map_err(|e| format!("Runs query failed: {}", e))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Runs row read failed: {}", e))
    }

    pub fn get_job_run(&self, run_id: i64) -> Result<JobRunWithSteps, String> {
        let conn = self.conn();
        let (job_id, status, trigger, queued_at, started_at, finished_at, error, planning_state) =
            conn.query_row(
                "SELECT job_id, status, trigger, queued_at, started_at, finished_at, error,
                        planning_state
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
                        row.get::<_, Option<String>>(7)?,
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
            planning_state,
            steps,
        })
    }

    pub fn delete_job_run(&self, run_id: i64) -> Result<(), String> {
        let conn = self.conn();
        conn.execute("DELETE FROM job_runs WHERE id = ?1", params![run_id])
            .map_err(|e| format!("Run delete failed: {}", e))?;
        Ok(())
    }

    pub fn delete_all_job_runs(&self, job_id: i64) -> Result<i64, String> {
        let conn = self.conn();
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
        let mut conn = self.conn();
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
