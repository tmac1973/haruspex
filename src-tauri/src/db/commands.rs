use super::*;
use crate::code_tools::git::{self, CodeForkMode};

/// Run a database operation on the blocking thread pool.
///
/// Sync `#[tauri::command]`s execute on the main thread, where SQLite
/// work (worst case: deserializing a conversation's `steps` artifacts)
/// stalls the webview. `Database` is a cloneable handle over the shared
/// connection, so each command clones it and does the real work off-thread.
pub(super) async fn on_pool<T, F>(db: Database, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Database) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(db))
        .await
        .map_err(|e| format!("db task panicked: {e}"))?
}

#[tauri::command]
pub async fn db_list_conversations(
    state: tauri::State<'_, Database>,
) -> Result<Vec<ConversationSummary>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.list_conversations()).await
}

#[tauri::command]
pub async fn db_get_conversation(
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<ConversationWithMessages, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.get_conversation(&id)).await
}

#[tauri::command]
pub async fn db_create_conversation(
    state: tauri::State<'_, Database>,
    id: String,
    title: String,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.create_conversation(&id, &title)).await
}

#[tauri::command]
pub async fn db_save_message(
    state: tauri::State<'_, Database>,
    conversation_id: String,
    role: String,
    content: String,
    tool_calls: Option<String>,
    tool_call_id: Option<String>,
    steps: Option<String>,
) -> Result<i64, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.save_message(
            &conversation_id,
            &role,
            &content,
            tool_calls.as_deref(),
            tool_call_id.as_deref(),
            steps.as_deref(),
        )
    })
    .await
}

/// Update the `steps` JSON for the most recently inserted message in
/// a conversation. Used after the agent loop finishes to attach
/// captured artifacts to the assistant message that was already
/// persisted at the start of streaming.
#[tauri::command]
pub async fn db_update_last_message_steps(
    state: tauri::State<'_, Database>,
    conversation_id: String,
    steps: Option<String>,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.update_last_message_steps(&conversation_id, steps.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn db_rename_conversation(
    state: tauri::State<'_, Database>,
    id: String,
    title: String,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.rename_conversation(&id, &title)).await
}

#[tauri::command]
pub async fn db_delete_conversation(
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.delete_conversation(&id)).await
}

#[tauri::command]
pub async fn db_clear_all_conversations(state: tauri::State<'_, Database>) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.clear_all_conversations()).await
}

#[tauri::command]
pub async fn db_replace_messages(
    state: tauri::State<'_, Database>,
    conversation_id: String,
    messages: Vec<MessageInput>,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.replace_messages(&conversation_id, &messages)
    })
    .await
}

#[tauri::command]
pub async fn db_create_job(
    state: tauri::State<'_, Database>,
    input: JobInput,
) -> Result<i64, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.create_job(&input)).await
}

#[tauri::command]
pub async fn db_list_jobs(state: tauri::State<'_, Database>) -> Result<Vec<JobSummary>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.list_jobs()).await
}

#[tauri::command]
pub async fn db_get_job(
    state: tauri::State<'_, Database>,
    id: i64,
) -> Result<JobWithSteps, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.get_job(id)).await
}

#[tauri::command]
pub async fn db_update_job(
    state: tauri::State<'_, Database>,
    id: i64,
    input: JobInput,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.update_job(id, &input)).await
}

/// Replace a job's inline API key with a reference to one in the key list,
/// leaving every other column alone. Used once, to move legacy inline keys
/// out of the database.
#[tauri::command]
pub async fn db_set_job_api_key_ref(
    state: tauri::State<'_, Database>,
    id: i64,
    key_id: String,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.set_job_api_key_ref(id, &key_id)).await
}

#[tauri::command]
pub async fn db_delete_job(state: tauri::State<'_, Database>, id: i64) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.delete_job(id)).await
}

#[tauri::command]
pub async fn db_replace_job_steps(
    state: tauri::State<'_, Database>,
    job_id: i64,
    steps: Vec<JobStepInput>,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.replace_job_steps(job_id, &steps)).await
}

#[tauri::command]
pub async fn db_create_prompt(
    state: tauri::State<'_, Database>,
    input: SavedPromptInput,
) -> Result<i64, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.create_prompt(&input)).await
}

#[tauri::command]
pub async fn db_list_prompts(
    state: tauri::State<'_, Database>,
) -> Result<Vec<SavedPrompt>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.list_prompts()).await
}

#[tauri::command]
pub async fn db_delete_prompt(state: tauri::State<'_, Database>, id: i64) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.delete_prompt(id)).await
}

#[tauri::command]
pub async fn db_create_job_run(
    state: tauri::State<'_, Database>,
    job_id: i64,
    trigger: String,
    step_prompts: Vec<String>,
) -> Result<i64, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.create_job_run(job_id, &trigger, &step_prompts)
    })
    .await
}

#[tauri::command]
pub async fn db_mark_run_started(
    state: tauri::State<'_, Database>,
    run_id: i64,
    started_at: i64,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.mark_run_started(run_id, started_at)).await
}

#[tauri::command]
pub async fn db_set_run_environment(
    state: tauri::State<'_, Database>,
    run_id: i64,
    model_id: Option<String>,
    model_thinking: Option<bool>,
    model_effort: Option<String>,
    context_size: Option<i64>,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.set_run_environment(
            run_id,
            model_id.as_deref(),
            model_thinking,
            model_effort.as_deref(),
            context_size,
        )
    })
    .await
}

#[tauri::command]
pub async fn db_mark_run_finished(
    state: tauri::State<'_, Database>,
    run_id: i64,
    status: String,
    finished_at: i64,
    error: Option<String>,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.mark_run_finished(run_id, &status, finished_at, error.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn db_mark_run_step_started(
    state: tauri::State<'_, Database>,
    run_id: i64,
    ordering: i64,
    started_at: i64,
    prompt_rendered: String,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.mark_run_step_started(run_id, ordering, started_at, &prompt_rendered)
    })
    .await
}

/// Flat parameters because that is the IPC boundary's shape: Tauri passes
/// named args from the JS side, and nesting them behind a struct would change
/// the wire contract for no gain on either side.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn db_mark_run_step_finished(
    state: tauri::State<'_, Database>,
    run_id: i64,
    ordering: i64,
    status: String,
    output: Option<String>,
    error: Option<String>,
    finished_at: i64,
    // Token/timing totals for the step. `None` when it ran no model calls,
    // which reads back as "not recorded" rather than as zeros.
    stats: Option<StepStats>,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.mark_run_step_finished(
            run_id,
            ordering,
            &status,
            output.as_deref(),
            error.as_deref(),
            finished_at,
            stats.as_ref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn db_list_job_runs(
    state: tauri::State<'_, Database>,
    job_id: i64,
) -> Result<Vec<JobRunSummary>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.list_job_runs(job_id)).await
}

#[tauri::command]
pub async fn db_get_job_run(
    state: tauri::State<'_, Database>,
    run_id: i64,
) -> Result<JobRunWithSteps, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.get_job_run(run_id)).await
}

#[tauri::command]
pub async fn db_recover_orphan_runs(state: tauri::State<'_, Database>) -> Result<i64, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.recover_orphan_runs()).await
}

#[tauri::command]
pub async fn db_delete_job_run(
    state: tauri::State<'_, Database>,
    run_id: i64,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.delete_job_run(run_id)).await
}

#[tauri::command]
pub async fn db_delete_all_job_runs(
    state: tauri::State<'_, Database>,
    job_id: i64,
) -> Result<i64, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.delete_all_job_runs(job_id)).await
}

#[tauri::command]
pub async fn db_set_job_next_due_at(
    state: tauri::State<'_, Database>,
    job_id: i64,
    next_due_at: Option<i64>,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.set_job_next_due_at(job_id, next_due_at)).await
}

#[tauri::command]
pub async fn db_list_due_jobs(
    state: tauri::State<'_, Database>,
    now_ms: i64,
) -> Result<Vec<JobSummary>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.list_due_jobs(now_ms)).await
}

// --- Code-tab sessions ---------------------------------------------------
// Keyed by id; see db/code_sessions.rs.

#[tauri::command]
pub async fn code_session_list(
    state: tauri::State<'_, Database>,
) -> Result<Vec<CodeSessionSummary>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.list_code_sessions()).await
}

/// `wsl_distro` is the picker's distro on Windows (a `\\wsl.localhost\…`
/// root names its own); see `code_tools::wsl::resolve_location`.
#[tauri::command]
pub async fn code_session_create(
    state: tauri::State<'_, Database>,
    root: String,
    wsl_distro: Option<String>,
    backend: Option<String>,
    effort: Option<String>,
) -> Result<CodeSessionRow, String> {
    let location = crate::code_tools::wsl::resolve_location(wsl_distro.as_deref(), &root).await?;
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.create_code_session_at(&location, backend.as_deref(), effort.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn code_session_load(
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<CodeSessionRow, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.load_code_session(&id)).await
}

/// Write the thread after a turn. `notices_seen_at` and `agent_branch` are
/// what the turn told the agent (see `CodeSessionRow`); absent leaves them.
#[tauri::command]
pub async fn code_session_save(
    state: tauri::State<'_, Database>,
    id: String,
    thread: String,
    title: Option<String>,
    notices_seen_at: Option<i64>,
    agent_branch: Option<String>,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.save_code_session(&id, &thread, title.as_deref())?;
        db.set_code_session_seen(&id, notices_seen_at, agent_branch.as_deref())
    })
    .await
}

/// Point a session whose folder is gone at another one. See
/// [`Database::set_code_session_root`].
#[tauri::command]
pub async fn code_session_set_root(
    state: tauri::State<'_, Database>,
    id: String,
    root: String,
    wsl_distro: Option<String>,
) -> Result<CodeSessionRow, String> {
    let location = crate::code_tools::wsl::resolve_location(wsl_distro.as_deref(), &root).await?;
    let db = state.inner().clone();
    on_pool(db, move |db| db.set_code_session_location(&id, &location)).await
}

#[tauri::command]
pub async fn code_session_update_meta(
    state: tauri::State<'_, Database>,
    id: String,
    patch: CodeSessionMetaPatch,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.update_code_session_meta(&id, &patch)).await
}

#[tauri::command]
pub async fn code_session_delete(
    state: tauri::State<'_, Database>,
    id: String,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.delete_code_session(&id)).await
}

/// Fork `id` at message `at`. `ReadOnly` shares the source's folder and may
/// only read; `Worktree` first makes a git worktree on a new branch beside
/// the repository (see `code_tools::git::add_fork_worktree`) and roots the
/// fork there, writable. A worktree whose session row then fails to save is
/// removed again, branch and all.
#[tauri::command]
pub async fn code_session_fork(
    state: tauri::State<'_, Database>,
    id: String,
    at: usize,
    mode: CodeForkMode,
) -> Result<CodeSessionRow, String> {
    let db = state.inner().clone();
    if mode == CodeForkMode::ReadOnly {
        return on_pool(db, move |db| db.fork_code_session(&id, at)).await;
    }
    let source = {
        let id = id.clone();
        on_pool(db.clone(), move |db| db.load_code_session(&id)).await?
    };
    let wt = git::add_fork_worktree(
        std::path::Path::new(&source.root),
        &code_sessions::fork_title(&source.title),
    )
    .await?;
    let (root, path) = (
        wt.root.to_string_lossy().into_owned(),
        wt.path.to_string_lossy().into_owned(),
    );
    let made = on_pool(db, move |db| {
        db.fork_code_session_into(&id, at, Some((&root, &path)))
    })
    .await;
    if made.is_err() {
        git::discard_fork_worktree(&wt).await;
    }
    made
}
