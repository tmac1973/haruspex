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
    assert_eq!(e.core.engine, "duckduckgo");
    assert_eq!(e.core.attempts, 3);
    assert_eq!(e.core.successes, 2);
    assert_eq!(e.fail_rate_limited, 1);
    assert_eq!(e.fail_http, 0);
    assert_eq!(e.core.total_latency_ms, 750);
    assert_eq!(e.core.max_latency_ms, 500);
    assert_eq!(e.core.last_success_at, Some(now + 1000));
    assert_eq!(e.core.last_failure_at, Some(now + 2000));
    assert_eq!(e.core.first_choice_attempts, 2);
    assert_eq!(e.core.fallback_attempts, 1);
    assert_eq!(e.core.fallback_successes, 1);
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
        job_type: "research".to_string(),
        schedule_kind: "manual".to_string(),
        schedule_config: None,
        next_due_at: None,
        type_config: None,
        model_remote_base_url: None,
        model_remote_api_key: None,
        model_remote_api_key_id: None,
        model_remote_model_id: None,
        model_remote_context_size: None,
        model_remote_vision_supported: None,
        model_advanced: None,
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
            job_type: "research".to_string(),
            schedule_kind: "daily".to_string(),
            schedule_config: Some(r#"{"time":"09:00"}"#.to_string()),
            next_due_at: Some(1234567890),
            type_config: None,
            model_remote_base_url: None,
            model_remote_api_key: None,
            model_remote_api_key_id: None,
            model_remote_model_id: None,
            model_remote_context_size: None,
            model_remote_vision_supported: None,
            model_advanced: None,
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
            job_type: "research".to_string(),
            schedule_kind: "weekly".to_string(),
            schedule_config: Some(json.clone()),
            next_due_at: None,
            type_config: None,
            model_remote_base_url: None,
            model_remote_api_key: None,
            model_remote_api_key_id: None,
            model_remote_model_id: None,
            model_remote_context_size: None,
            model_remote_vision_supported: None,
            model_advanced: None,
        })
        .unwrap();
    let job = db.get_job(id).unwrap();
    assert_eq!(job.schedule_config, Some(json));
}

#[test]
fn type_config_and_model_override_round_trip() {
    let db = test_db();
    // Rust treats type_config as opaque JSON — this is exactly what the
    // frontend's audit module serializes, but any string must round-trip.
    let cfg = r#"{"num_runs":5,"output_file":"AUDIT.md","max_iterations":250}"#;
    let id = db
        .create_job(&JobInput {
            name: "Dup audit".to_string(),
            description: None,
            working_dir: "/repo".to_string(),
            auto_approve_tools: false,
            job_type: "audit".to_string(),
            schedule_kind: "manual".to_string(),
            schedule_config: None,
            next_due_at: None,
            type_config: Some(cfg.to_string()),
            model_remote_base_url: Some("http://compute:3000".to_string()),
            model_remote_api_key: Some("sk-test".to_string()),
            model_remote_api_key_id: None,
            model_remote_model_id: Some("qwen3.5-27b".to_string()),
            model_remote_context_size: Some(131072),
            model_remote_vision_supported: Some(true),
            model_advanced: Some(r#"{"reasoning":"off"}"#.to_string()),
        })
        .unwrap();
    let job = db.get_job(id).unwrap();
    assert_eq!(job.job_type, "audit");
    assert_eq!(job.type_config.as_deref(), Some(cfg));
    assert_eq!(
        job.model_remote_base_url.as_deref(),
        Some("http://compute:3000")
    );
    assert_eq!(job.model_remote_api_key.as_deref(), Some("sk-test"));
    assert_eq!(job.model_remote_model_id.as_deref(), Some("qwen3.5-27b"));
    assert_eq!(job.model_remote_context_size, Some(131072));
    assert_eq!(job.model_remote_vision_supported, Some(true));
    // Opaque to Rust — stored and returned verbatim, like type_config.
    assert_eq!(
        job.model_advanced.as_deref(),
        Some(r#"{"reasoning":"off"}"#)
    );

    // The list view carries the discriminator for badges.
    let summary = db
        .list_jobs()
        .unwrap()
        .into_iter()
        .find(|j| j.id == id)
        .unwrap();
    assert_eq!(summary.job_type, "audit");
}

#[test]
fn type_config_migration_folds_legacy_columns() {
    let db = test_db();
    // Simulate pre-migration rows: legacy per-type columns set, type_config
    // NULL (as an old DB would have after the ALTER adds the column).
    {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO jobs (name, working_dir, auto_approve_tools, job_type,
                               schedule_kind, audit_num_runs, audit_output_file,
                               audit_read_only, audit_max_iterations, created_at, updated_at)
             VALUES ('Legacy audit', '/repo', 0, 'audit', 'manual', 5, 'AUDIT.md', 1, 250, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO jobs (name, working_dir, auto_approve_tools, job_type,
                               schedule_kind, initial_description, plan_output_dir,
                               created_at, updated_at)
             VALUES ('Legacy planner', '/repo', 0, 'guided_planning',
                     'manual', 'Build X', 'plan/x/', 0, 0)",
            [],
        )
        .unwrap();
        // Research rows never get a type_config from the migration.
        conn.execute(
            "INSERT INTO jobs (name, working_dir, auto_approve_tools, job_type,
                               schedule_kind, created_at, updated_at)
             VALUES ('Legacy research', '/repo', 0, 'research', 'manual', 0, 0)",
            [],
        )
        .unwrap();
    }

    // Re-running the full migration folds the legacy columns into JSON.
    db.migrate().unwrap();

    let jobs = db.list_jobs().unwrap();
    let audit = jobs.iter().find(|j| j.name == "Legacy audit").unwrap();
    let cfg: serde_json::Value = serde_json::from_str(
        db.get_job(audit.id)
            .unwrap()
            .type_config
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(cfg["num_runs"], 5);
    assert_eq!(cfg["output_file"], "AUDIT.md");
    assert_eq!(cfg["read_only"], true);
    assert_eq!(cfg["max_iterations"], 250);

    let planner = jobs.iter().find(|j| j.name == "Legacy planner").unwrap();
    let cfg: serde_json::Value = serde_json::from_str(
        db.get_job(planner.id)
            .unwrap()
            .type_config
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(cfg["initial_description"], "Build X");
    assert_eq!(cfg["plan_output_dir"], "plan/x/");

    let research = jobs.iter().find(|j| j.name == "Legacy research").unwrap();
    assert_eq!(db.get_job(research.id).unwrap().type_config, None);

    // Idempotent: a second migrate() leaves the folded JSON alone.
    db.migrate().unwrap();
    let again = db.get_job(audit.id).unwrap().type_config.unwrap();
    let cfg: serde_json::Value = serde_json::from_str(&again).unwrap();
    assert_eq!(cfg["num_runs"], 5);
}

#[test]
fn existing_jobs_default_to_research_type() {
    let db = test_db();
    let id = db.create_job(&sample_job_input("Legacy")).unwrap();
    assert_eq!(db.get_job(id).unwrap().job_type, "research");
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

/// Token totals survive the round trip, and — the part that matters — a step
/// with no totals reads back as `None` rather than as a row of zeros. A
/// checkpoint stage that waits on the user spends nothing and records nothing,
/// and a stats table must be able to tell those apart.
#[test]
fn step_stats_round_trip_and_absence_is_not_zero() {
    let db = test_db();
    let job_id = job_with_steps(&db, "Stats", &["a", "b"]);
    let run_id = db
        .create_job_run(job_id, "manual", &["a".to_string(), "b".to_string()])
        .unwrap();

    let stats = StepStats {
        tokens_prompt: 186_000,
        tokens_completion: 22_800,
        tokens_reasoning: 14_100,
        tokens_reasoning_exact: true,
        peak_prompt_tokens: 31_700,
        model_calls: 31,
        reasoning_ms: 1_683_000,
        total_ms: 2_712_000,
    };
    db.mark_run_step_finished(run_id, 0, "succeeded", Some("out"), None, 200, Some(&stats))
        .unwrap();
    // Second step ran no model calls at all.
    db.mark_run_step_finished(run_id, 1, "succeeded", Some("out"), None, 300, None)
        .unwrap();

    let run = db.get_job_run(run_id).unwrap();
    let recorded = run.steps[0].stats.as_ref().expect("step 0 recorded stats");
    assert_eq!(recorded.tokens_prompt, 186_000);
    assert_eq!(recorded.tokens_completion, 22_800);
    assert_eq!(recorded.tokens_reasoning, 14_100);
    assert!(recorded.tokens_reasoning_exact);
    assert_eq!(recorded.peak_prompt_tokens, 31_700);
    assert_eq!(recorded.model_calls, 31);
    assert_eq!(recorded.reasoning_ms, 1_683_000);
    assert_eq!(recorded.total_ms, 2_712_000);

    assert!(
        run.steps[1].stats.is_none(),
        "a step that ran no model calls must read back as not-recorded, not as zeros"
    );
}

/// The estimate flag is what lets the UI mark a `~`; it has to survive
/// storage, including its false value.
#[test]
fn step_stats_preserve_the_estimated_flag() {
    let db = test_db();
    let job_id = job_with_steps(&db, "Estimated", &["a"]);
    let run_id = db
        .create_job_run(job_id, "manual", &["a".to_string()])
        .unwrap();
    let stats = StepStats {
        tokens_reasoning_exact: false,
        model_calls: 3,
        ..Default::default()
    };
    db.mark_run_step_finished(run_id, 0, "succeeded", None, None, 10, Some(&stats))
        .unwrap();

    let run = db.get_job_run(run_id).unwrap();
    let recorded = run.steps[0].stats.as_ref().unwrap();
    assert!(!recorded.tokens_reasoning_exact);
    assert_eq!(recorded.model_calls, 3);
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
    db.mark_run_step_finished(run_id, 0, "succeeded", Some("a-output"), None, 200, None)
        .unwrap();
    db.mark_run_step_started(run_id, 1, 200, "a-output\n\nb")
        .unwrap();
    db.mark_run_step_finished(run_id, 1, "succeeded", Some("b-output"), None, 300, None)
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

/// The stats card labels a run's tokens with the model that produced them.
/// Reading that off the job at display time would be wrong the moment the job
/// is edited, so it is written to the RUN and must survive a round trip —
/// through both read paths, since the history list and the detail view use
/// different queries.
#[test]
fn run_environment_round_trips_through_both_read_paths() {
    let db = test_db();
    let job_id = job_with_steps(&db, "Planning", &["a"]);
    let run_id = db
        .create_job_run(job_id, "manual", &["a".to_string()])
        .unwrap();

    db.set_run_environment(
        run_id,
        Some("Qwen3.6-35B-A3B"),
        Some(true),
        Some("high"),
        Some(32768),
    )
    .unwrap();

    let run = db.get_job_run(run_id).unwrap();
    assert_eq!(run.model_id.as_deref(), Some("Qwen3.6-35B-A3B"));
    assert_eq!(run.model_thinking, Some(true));
    assert_eq!(run.model_effort.as_deref(), Some("high"));
    assert_eq!(run.context_size, Some(32768));

    let listed = db.list_job_runs(job_id).unwrap();
    assert_eq!(listed[0].model_id.as_deref(), Some("Qwen3.6-35B-A3B"));
    assert_eq!(listed[0].model_thinking, Some(true));
    assert_eq!(listed[0].context_size, Some(32768));
}

/// A run recorded before this existed reads back as NULL, not as a row of
/// defaults — "not recorded" and "ran on an unnamed model with thinking off"
/// are different claims, and only one of them is true.
#[test]
fn run_environment_is_null_when_never_recorded() {
    let db = test_db();
    let job_id = job_with_steps(&db, "Planning", &["a"]);
    let run_id = db
        .create_job_run(job_id, "manual", &["a".to_string()])
        .unwrap();

    let run = db.get_job_run(run_id).unwrap();
    assert!(run.model_id.is_none());
    assert!(run.model_thinking.is_none());
    assert!(run.model_effort.is_none());
    assert!(run.context_size.is_none());
}

/// Reasoning off is a recorded fact, not an absence: `Some(false)` must not
/// collapse into `None` on the way through SQLite.
#[test]
fn run_environment_records_thinking_off_distinctly() {
    let db = test_db();
    let job_id = job_with_steps(&db, "Planning", &["a"]);
    let run_id = db
        .create_job_run(job_id, "manual", &["a".to_string()])
        .unwrap();

    db.set_run_environment(run_id, Some("gpt-oss-120b"), Some(false), None, Some(8192))
        .unwrap();

    let run = db.get_job_run(run_id).unwrap();
    assert_eq!(run.model_thinking, Some(false));
    assert!(run.model_effort.is_none());
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
    db.mark_run_step_finished(run_id, 0, "succeeded", Some("ok"), None, 20, None)
        .unwrap();
    db.mark_run_step_started(run_id, 1, 20, "ok\n\nb").unwrap();
    db.mark_run_step_finished(run_id, 1, "failed", None, Some("boom"), 30, None)
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
    db.mark_run_step_finished(r3, 0, "succeeded", Some("out"), None, 60, None)
        .unwrap();
    db.mark_run_step_started(r3, 1, 60, "out\n\nb").unwrap();
    db.mark_run_step_finished(r3, 1, "succeeded", Some("done"), None, 70, None)
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

#[test]
fn prompt_catalog_crud() {
    let db = test_db();
    let id = db
        .create_prompt(&SavedPromptInput {
            name: "My dup audit".to_string(),
            scope: "audit".to_string(),
            prompt: "look for duplication".to_string(),
        })
        .unwrap();
    let all = db.list_prompts().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, id);
    assert_eq!(all[0].name, "My dup audit");
    assert_eq!(all[0].scope, "audit");
    assert_eq!(all[0].prompt, "look for duplication");

    db.delete_prompt(id).unwrap();
    assert!(db.list_prompts().unwrap().is_empty());
}

#[test]
fn guided_planning_config_and_run_state_round_trip() {
    let db = test_db();
    let cfg = r#"{"initial_description":"Build a guided planning feature","plan_output_dir":"plan/guided-planning"}"#;
    let id = db
        .create_job(&JobInput {
            job_type: "guided_planning".to_string(),
            type_config: Some(cfg.to_string()),
            ..sample_job_input("Planner")
        })
        .unwrap();

    let job = db.get_job(id).unwrap();
    assert_eq!(job.job_type, "guided_planning");
    assert_eq!(job.type_config.as_deref(), Some(cfg));

    let run_id = db
        .create_job_run(id, "manual", &["go".to_string()])
        .unwrap();

    // New runs start with no planning state.
    assert_eq!(db.get_job_run(run_id).unwrap().planning_state, None);

    // Persist a milestone blob and read it back via both run accessors.
    let blob = r#"{"stage":"planning","milestone":"overview_written"}"#;
    db.set_run_planning_state(run_id, Some(blob)).unwrap();
    assert_eq!(
        db.get_job_run(run_id).unwrap().planning_state.as_deref(),
        Some(blob)
    );
    assert_eq!(
        db.list_job_runs(id).unwrap()[0].planning_state.as_deref(),
        Some(blob)
    );

    // Parking as needs_input is a non-terminal status change.
    db.set_run_status(run_id, "needs_input").unwrap();
    assert_eq!(db.get_job_run(run_id).unwrap().status, "needs_input");
}

// ---------------------------------------------------------------------------
// Agentic memory (plan/agentic-memory/phase-01-rust-memory-core.md)
//
// Synthetic vectors throughout: these assert the storage, ranking and cursor
// logic, none of which should depend on a 65 MB ONNX model being present.
// The embedder has its own tests, and the one that needs real weights is
// #[ignore]d.
// ---------------------------------------------------------------------------

const MODEL: &str = "test-model";

/// A unit vector pointing along `axis` — orthogonal to every other axis, so
/// cosine between two of them is exactly 0 and against itself exactly 1.
fn axis_vector(axis: usize) -> Vec<f32> {
    let mut v = vec![0.0; 8];
    v[axis] = 1.0;
    v
}

/// A vector `t` of the way from axis 0 toward axis 1 — for graded similarity.
fn blend(t: f32) -> Vec<f32> {
    let mut v = vec![0.0; 8];
    v[0] = 1.0 - t;
    v[1] = t;
    v
}

#[test]
fn memory_insert_and_list_round_trips() {
    let db = test_db();
    let id = db
        .insert_memory(
            "Prefers tabs over spaces",
            "preference",
            &axis_vector(0),
            MODEL,
            Some("conv-1"),
            "extracted",
            1_000,
        )
        .unwrap();

    let rows = db.list_memories(0, 10, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, id);
    assert_eq!(rows[0].content, "Prefers tabs over spaces");
    assert_eq!(rows[0].category, "preference");
    assert_eq!(rows[0].source_conversation_id.as_deref(), Some("conv-1"));
    // A new memory is as fresh as it will ever be.
    assert_eq!(rows[0].created_at, rows[0].last_seen_at);
    assert_eq!(rows[0].use_count, 0);
    assert_eq!(db.count_memories().unwrap(), 1);
}

/// The memory must outlive its source conversation — deleting a chat cannot
/// delete what was learned from it. That is what incognito is for. Hence no
/// foreign key on source_conversation_id.
#[test]
fn deleting_the_source_conversation_keeps_the_memory() {
    let db = test_db();
    db.create_conversation("conv-1", "Chat").unwrap();
    db.insert_memory(
        "Lives in Toronto",
        "fact",
        &axis_vector(0),
        MODEL,
        Some("conv-1"),
        "extracted",
        1_000,
    )
    .unwrap();

    db.delete_conversation("conv-1").unwrap();

    assert_eq!(db.count_memories().unwrap(), 1);
    assert_eq!(
        db.list_memories(0, 10, None).unwrap()[0]
            .source_conversation_id
            .as_deref(),
        Some("conv-1")
    );
}

#[test]
fn search_ranks_by_similarity_and_returns_top_k() {
    let db = test_db();
    db.insert_memory(
        "exact",
        "fact",
        &blend(0.0),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();
    db.insert_memory(
        "close",
        "fact",
        &blend(0.25),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();
    db.insert_memory("far", "fact", &blend(0.9), MODEL, None, "extracted", 1_000)
        .unwrap();

    let hits = db
        .search_memories(&blend(0.0), MODEL, 2, 0.0, 1_000)
        .unwrap();

    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].memory.content, "exact");
    assert_eq!(hits[1].memory.content, "close");
    assert!(hits[0].similarity > hits[1].similarity);
}

#[test]
fn search_applies_the_minimum_similarity() {
    let db = test_db();
    db.insert_memory(
        "same",
        "fact",
        &axis_vector(0),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();
    db.insert_memory(
        "orthogonal",
        "fact",
        &axis_vector(1),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();

    let hits = db
        .search_memories(&axis_vector(0), MODEL, 10, 0.5, 1_000)
        .unwrap();

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].memory.content, "same");
}

/// Cosine between vectors from two different embedding spaces is a number
/// with no meaning. Acting on it would be worse than recalling nothing, so
/// rows from another model are skipped rather than scored.
#[test]
fn search_ignores_rows_embedded_by_another_model() {
    let db = test_db();
    db.insert_memory(
        "current",
        "fact",
        &axis_vector(0),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();
    db.insert_memory(
        "legacy",
        "fact",
        &axis_vector(0),
        "older-model",
        None,
        "extracted",
        1_000,
    )
    .unwrap();

    let hits = db
        .search_memories(&axis_vector(0), MODEL, 10, 0.0, 1_000)
        .unwrap();

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].memory.content, "current");
}

/// Recency breaks ties; it must not bury an old-but-true fact under a recent
/// irrelevant one. The floor of 0.5 is the exact guarantee: an ancient exact
/// match still beats anything less than half as similar. It does NOT beat a
/// fresh 0.83-similar one — that is the deliberate cost of letting recency
/// mean anything at all, and this test pins the line where it falls.
#[test]
fn recency_breaks_ties_without_overturning_relevance() {
    let db = test_db();
    let year_ms = 365i64 * 86_400_000;
    let now = 10 * year_ms;

    db.insert_memory(
        "old but exact",
        "fact",
        &blend(0.0),
        MODEL,
        None,
        "extracted",
        now - 5 * year_ms,
    )
    .unwrap();
    // blend(0.75) is ~0.32 similar to blend(0.0) — under the floor, so no
    // amount of freshness can lift it past a five-year-old exact match.
    db.insert_memory(
        "fresh but far weaker",
        "fact",
        &blend(0.75),
        MODEL,
        None,
        "extracted",
        now,
    )
    .unwrap();
    let hits = db
        .search_memories(&blend(0.0), MODEL, 10, 0.0, now)
        .unwrap();
    assert_eq!(hits[0].memory.content, "old but exact");

    // Same similarity, different age → the fresher one wins.
    let db2 = test_db();
    db2.insert_memory(
        "stale",
        "fact",
        &blend(0.0),
        MODEL,
        None,
        "extracted",
        now - 5 * year_ms,
    )
    .unwrap();
    db2.insert_memory("recent", "fact", &blend(0.0), MODEL, None, "extracted", now)
        .unwrap();
    let hits2 = db2
        .search_memories(&blend(0.0), MODEL, 10, 0.0, now)
        .unwrap();
    assert_eq!(hits2[0].memory.content, "recent");
}

#[test]
fn search_bumps_usage_on_the_rows_it_returns() {
    let db = test_db();
    db.insert_memory(
        "used",
        "fact",
        &axis_vector(0),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();
    db.insert_memory(
        "unused",
        "fact",
        &axis_vector(1),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();

    db.search_memories(&axis_vector(0), MODEL, 10, 0.5, 5_000)
        .unwrap();

    let rows = db.list_memories(0, 10, None).unwrap();
    let used = rows.iter().find(|m| m.content == "used").unwrap();
    let unused = rows.iter().find(|m| m.content == "unused").unwrap();
    assert_eq!(used.use_count, 1);
    assert_eq!(used.last_seen_at, 5_000);
    assert_eq!(unused.use_count, 0);
    assert_eq!(unused.last_seen_at, 1_000);
}

/// Deciding not to store a duplicate is not the memory being used — counting
/// it would inflate the usage figures the manager UI reports.
#[test]
fn find_similar_returns_the_best_match_without_bumping_usage() {
    let db = test_db();
    db.insert_memory(
        "near duplicate",
        "fact",
        &blend(0.05),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();
    db.insert_memory(
        "unrelated",
        "fact",
        &axis_vector(4),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();

    let hit = db
        .find_similar(&blend(0.0), MODEL, 0.9, 2_000)
        .unwrap()
        .expect("a near-duplicate should match");
    assert_eq!(hit.memory.content, "near duplicate");

    assert!(db
        .list_memories(0, 10, None)
        .unwrap()
        .iter()
        .all(|m| m.use_count == 0));
}

#[test]
fn find_similar_is_none_below_the_threshold() {
    let db = test_db();
    db.insert_memory(
        "unrelated",
        "fact",
        &axis_vector(4),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();
    assert!(db
        .find_similar(&axis_vector(0), MODEL, 0.9, 2_000)
        .unwrap()
        .is_none());
}

/// Content and embedding are two representations of one fact. A row whose
/// text says one thing while its vector says another is recalled for the
/// wrong query and then shown as the wrong answer.
#[test]
fn updating_content_replaces_the_vector_too() {
    let db = test_db();
    let id = db
        .insert_memory(
            "old wording",
            "fact",
            &axis_vector(0),
            MODEL,
            None,
            "extracted",
            1_000,
        )
        .unwrap();

    assert!(db
        .update_memory_content(&id, "new wording", &axis_vector(3), MODEL)
        .unwrap());

    assert!(db
        .search_memories(&axis_vector(0), MODEL, 10, 0.5, 2_000)
        .unwrap()
        .is_empty());
    let hits = db
        .search_memories(&axis_vector(3), MODEL, 10, 0.5, 2_000)
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].memory.content, "new wording");
}

#[test]
fn delete_and_clear_report_what_they_removed() {
    let db = test_db();
    let id = db
        .insert_memory(
            "a",
            "fact",
            &axis_vector(0),
            MODEL,
            None,
            "extracted",
            1_000,
        )
        .unwrap();
    db.insert_memory(
        "b",
        "fact",
        &axis_vector(1),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();

    assert!(db.delete_memory(&id).unwrap());
    assert!(
        !db.delete_memory(&id).unwrap(),
        "second delete removes nothing"
    );
    assert_eq!(db.delete_all_memories().unwrap(), 1);
    assert_eq!(db.count_memories().unwrap(), 0);
}

#[test]
fn list_filters_by_content_substring() {
    let db = test_db();
    db.insert_memory(
        "prefers dark mode",
        "preference",
        &axis_vector(0),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();
    db.insert_memory(
        "lives in Toronto",
        "fact",
        &axis_vector(1),
        MODEL,
        None,
        "extracted",
        1_000,
    )
    .unwrap();

    let hits = db.list_memories(0, 10, Some("Toronto")).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].content, "lives in Toronto");
}

/// The manager shows where a memory came from. A LEFT JOIN, so a memory
/// whose source chat was deleted still lists — it outlives its source by
/// design, and a row vanishing from the manager would leave the user unable
/// to delete something still being recalled.
#[test]
fn list_resolves_the_source_conversation_title() {
    let db = test_db();
    db.create_conversation("conv-1", "Editor preferences")
        .unwrap();
    db.insert_memory(
        "Prefers tabs.",
        "preference",
        &axis_vector(0),
        MODEL,
        Some("conv-1"),
        "extracted",
        1_000,
    )
    .unwrap();

    let rows = db.list_memories(0, 10, None).unwrap();
    assert_eq!(rows[0].source_title.as_deref(), Some("Editor preferences"));

    db.delete_conversation("conv-1").unwrap();
    let after = db.list_memories(0, 10, None).unwrap();
    assert_eq!(
        after.len(),
        1,
        "the memory outlives its source conversation"
    );
    assert!(after[0].source_title.is_none());
}

/// Search does not join for provenance — nothing in the recall path needs a
/// conversation title, and paying for the join per query would be waste.
#[test]
fn search_leaves_the_source_title_unresolved() {
    let db = test_db();
    db.create_conversation("conv-1", "Editor preferences")
        .unwrap();
    db.insert_memory(
        "Prefers tabs.",
        "preference",
        &axis_vector(0),
        MODEL,
        Some("conv-1"),
        "extracted",
        1_000,
    )
    .unwrap();

    let hits = db
        .search_memories(&axis_vector(0), MODEL, 5, 0.5, 2_000)
        .unwrap();
    assert!(hits[0].memory.source_title.is_none());
    assert_eq!(
        hits[0].memory.source_conversation_id.as_deref(),
        Some("conv-1")
    );
}

#[test]
fn memory_cursor_defaults_to_enabled_and_unextracted() {
    let db = test_db();
    db.create_conversation("conv-1", "Chat").unwrap();

    let cursor = db.get_memory_cursor("conv-1").unwrap();
    assert!(cursor.memory_enabled);
    // -1, because sort_order starts at 0 and 0 would mean "the first message
    // is already done".
    assert_eq!(cursor.memory_extracted_to, -1);
}

/// The extraction scheduler races conversation deletion. "Process this chat
/// that no longer exists" is the wrong default for a privacy feature.
#[test]
fn memory_cursor_of_a_missing_conversation_reads_as_disabled() {
    let db = test_db();
    let cursor = db.get_memory_cursor("never-existed").unwrap();
    assert!(!cursor.memory_enabled);
    assert_eq!(cursor.memory_extracted_to, -1);
}

#[test]
fn memory_enabled_flag_persists_both_ways() {
    let db = test_db();
    db.create_conversation("conv-1", "Chat").unwrap();

    db.set_memory_enabled("conv-1", false).unwrap();
    assert!(!db.get_memory_cursor("conv-1").unwrap().memory_enabled);

    db.set_memory_enabled("conv-1", true).unwrap();
    assert!(db.get_memory_cursor("conv-1").unwrap().memory_enabled);
}

/// Two extraction passes can overlap — an idle timer firing as the user
/// switches away — and the later-finishing one may hold the older cursor.
/// Taking the max stops a stale writer re-distilling turns already done.
#[test]
fn the_watermark_advances_but_never_retreats() {
    let db = test_db();
    db.create_conversation("conv-1", "Chat").unwrap();

    db.set_memory_extracted_to("conv-1", 12).unwrap();
    assert_eq!(
        db.get_memory_cursor("conv-1").unwrap().memory_extracted_to,
        12
    );

    db.set_memory_extracted_to("conv-1", 4).unwrap();
    assert_eq!(
        db.get_memory_cursor("conv-1").unwrap().memory_extracted_to,
        12
    );

    db.set_memory_extracted_to("conv-1", 30).unwrap();
    assert_eq!(
        db.get_memory_cursor("conv-1").unwrap().memory_extracted_to,
        30
    );
}

// ---------------------------------------------------------------------------
// Cached images
// ---------------------------------------------------------------------------

/// A row with plausible values; `hash` and `source_url` are what the tests
/// actually vary, and `bytes` drives the eviction maths.
fn img(hash: &str, url: &str, bytes: i64) -> ImageRow {
    ImageRow {
        hash: hash.to_string(),
        source_url: url.to_string(),
        source: "commons".to_string(),
        mime: "image/jpeg".to_string(),
        width: 800,
        height: 600,
        bytes,
        license: Some("cc-by-sa-4.0".to_string()),
        attribution: Some("A Photographer".to_string()),
        description_url: Some("https://commons.wikimedia.org/wiki/File:X.jpg".to_string()),
        embeddable: true,
        created_at: 0,
        last_used_at: 0,
    }
}

/// Force a known `last_used_at` so eviction order is deterministic rather than
/// dependent on how fast the test machine inserts rows.
fn set_used_at(db: &Database, hash: &str, at: i64) {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "UPDATE images SET last_used_at = ?1 WHERE hash = ?2",
        params![at, hash],
    )
    .unwrap();
}

#[test]
fn image_round_trips_by_source_url() {
    let db = test_db();
    db.insert_image(&img("a".repeat(64).as_str(), "https://e.com/a.jpg", 100))
        .unwrap();

    let found = db.image_by_source_url("https://e.com/a.jpg").unwrap();
    let found = found.expect("inserted image should be found");
    assert_eq!(found.hash, "a".repeat(64));
    assert!(found.embeddable);
    assert_eq!(found.attribution.as_deref(), Some("A Photographer"));

    assert!(db
        .image_by_source_url("https://e.com/missing.jpg")
        .unwrap()
        .is_none());
}

#[test]
fn reinserting_the_same_bytes_keeps_the_first_provenance() {
    let db = test_db();
    let hash = "b".repeat(64);
    db.insert_image(&img(&hash, "https://e.com/first.jpg", 100))
        .unwrap();

    // Same bytes arriving again from a scrape with no licence must not
    // downgrade the record we already have.
    let mut poorer = img(&hash, "https://e.com/second.jpg", 100);
    poorer.source = "page_og".to_string();
    poorer.license = Some("unknown".to_string());
    poorer.attribution = None;
    poorer.embeddable = false;
    db.insert_image(&poorer).unwrap();

    let kept = db
        .image_by_source_url("https://e.com/first.jpg")
        .unwrap()
        .expect("first row survives");
    assert_eq!(kept.license.as_deref(), Some("cc-by-sa-4.0"));
    assert!(kept.embeddable, "the richer provenance must win");
}

#[test]
fn deleting_a_conversation_orphans_only_its_own_images() {
    let db = test_db();
    db.create_conversation("c1", "One").unwrap();
    db.create_conversation("c2", "Two").unwrap();

    let solo = "c".repeat(64);
    let shared = "d".repeat(64);
    db.insert_image(&img(&solo, "https://e.com/solo.jpg", 10))
        .unwrap();
    db.insert_image(&img(&shared, "https://e.com/shared.jpg", 10))
        .unwrap();

    db.link_image("c1", &solo).unwrap();
    db.link_image("c1", &shared).unwrap();
    db.link_image("c2", &shared).unwrap();

    assert!(db.unreferenced_image_hashes().unwrap().is_empty());

    db.delete_conversation("c1").unwrap();

    // The cascade unlinked c1's rows; only the image nothing else references
    // is now collectable.
    let orphans = db.unreferenced_image_hashes().unwrap();
    assert_eq!(orphans, vec![solo.clone()]);

    db.delete_images(&orphans).unwrap();
    assert!(db
        .image_by_source_url("https://e.com/solo.jpg")
        .unwrap()
        .is_none());
    assert!(
        db.image_by_source_url("https://e.com/shared.jpg")
            .unwrap()
            .is_some(),
        "an image another conversation still uses must survive"
    );
}

#[test]
fn linking_the_same_image_twice_is_a_no_op() {
    let db = test_db();
    db.create_conversation("c1", "One").unwrap();
    let hash = "e".repeat(64);
    db.insert_image(&img(&hash, "https://e.com/x.jpg", 10))
        .unwrap();

    db.link_image("c1", &hash).unwrap();
    db.link_image("c1", &hash).unwrap();

    db.delete_conversation("c1").unwrap();
    assert_eq!(db.unreferenced_image_hashes().unwrap(), vec![hash]);
}

#[test]
fn eviction_takes_least_recently_used_until_under_cap() {
    let db = test_db();
    let (old, mid, new) = ("1".repeat(64), "2".repeat(64), "3".repeat(64));
    db.insert_image(&img(&old, "https://e.com/old.jpg", 100))
        .unwrap();
    db.insert_image(&img(&mid, "https://e.com/mid.jpg", 100))
        .unwrap();
    db.insert_image(&img(&new, "https://e.com/new.jpg", 100))
        .unwrap();
    set_used_at(&db, &old, 1);
    set_used_at(&db, &mid, 2);
    set_used_at(&db, &new, 3);

    assert_eq!(db.images_total_bytes().unwrap(), 300);

    // Under the cap: nothing goes.
    assert!(db.images_to_evict(300).unwrap().is_empty());

    // Needs 100 freed → the oldest alone.
    assert_eq!(db.images_to_evict(200).unwrap(), vec![old.clone()]);

    // Needs 200 freed → the two oldest, in order.
    assert_eq!(db.images_to_evict(100).unwrap(), vec![old, mid]);
}

#[test]
fn eviction_ignores_whether_an_image_is_referenced() {
    let db = test_db();
    db.create_conversation("c1", "One").unwrap();
    let hash = "f".repeat(64);
    db.insert_image(&img(&hash, "https://e.com/x.jpg", 100))
        .unwrap();
    db.link_image("c1", &hash).unwrap();

    // The cap is a disk limit, not a retention promise: a live conversation's
    // image is still evictable, and rehydration will simply not find it.
    assert_eq!(db.images_to_evict(10).unwrap(), vec![hash]);
}
