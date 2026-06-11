use super::*;
use crate::proxy::stats::EngineStatDelta;
use rusqlite::{params, Connection};
use std::collections::HashMap;

fn test_db() -> Database {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    let db = Database {
        conn: Arc::new(Mutex::new(conn)),
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
    db.save_message("c1", "user", "Hello", None, None, None)
        .unwrap();
    db.save_message("c1", "assistant", "Hi there!", None, None, None)
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
    db.save_message("c1", "user", "msg1", None, None, None)
        .unwrap();
    db.save_message("c1", "assistant", "msg2", None, None, None)
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
    db.save_message("c1", "user", "msg", None, None, None)
        .unwrap();

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
            None,
        )
        .unwrap();
    db.save_message(
        "c1",
        "tool",
        "search results here",
        None,
        Some("call_1"),
        None,
    )
    .unwrap();

    let conv = db.get_conversation("c1").unwrap();
    assert_eq!(conv.messages.len(), 2);
    assert!(conv.messages[0].tool_calls.is_some());
    assert_eq!(conv.messages[1].tool_call_id.as_deref(), Some("call_1"));
}
