use super::*;

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
    steps: Option<String>,
) -> Result<i64, String> {
    state.save_message(
        &conversation_id,
        &role,
        &content,
        tool_calls.as_deref(),
        tool_call_id.as_deref(),
        steps.as_deref(),
    )
}

/// Update the `steps` JSON for the most recently inserted message in
/// a conversation. Used after the agent loop finishes to attach
/// captured artifacts to the assistant message that was already
/// persisted at the start of streaming.
#[tauri::command]
pub fn db_update_last_message_steps(
    state: tauri::State<'_, Database>,
    conversation_id: String,
    steps: Option<String>,
) -> Result<(), String> {
    state.update_last_message_steps(&conversation_id, steps.as_deref())
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
pub fn db_create_prompt(
    state: tauri::State<'_, Database>,
    input: SavedPromptInput,
) -> Result<i64, String> {
    state.create_prompt(&input)
}

#[tauri::command]
pub fn db_list_prompts(state: tauri::State<'_, Database>) -> Result<Vec<SavedPrompt>, String> {
    state.list_prompts()
}

#[tauri::command]
pub fn db_delete_prompt(state: tauri::State<'_, Database>, id: i64) -> Result<(), String> {
    state.delete_prompt(id)
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
