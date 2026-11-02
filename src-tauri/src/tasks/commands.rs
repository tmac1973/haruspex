//! The registry's commands. Rust followers change their tasks in-process;
//! these are for the frontend: reading the list, the main window's runner
//! (phase 06) creating and updating its tasks, cancelling, and owners taking
//! their notices.

use super::{BackgroundTask, BackgroundTasks, TaskFollower, TaskKind, TaskPatch};

/// Record a task for the frontend to follow.
#[tauri::command]
pub fn task_create(
    tasks: tauri::State<'_, BackgroundTasks>,
    kind: TaskKind,
    owner: String,
    label: String,
    spec: serde_json::Value,
) -> BackgroundTask {
    tasks.create(kind, &owner, &label, TaskFollower::Frontend, spec)
}

/// Change a frontend task. `TaskGone` when it no longer exists.
#[tauri::command]
pub fn task_update(
    tasks: tauri::State<'_, BackgroundTasks>,
    id: String,
    patch: TaskPatch,
) -> Result<BackgroundTask, String> {
    match tasks.get(&id) {
        Some(t) if t.follower == TaskFollower::Rust => {
            Err("That task is followed by the app itself.".into())
        }
        _ => tasks.update(&id, patch),
    }
}

/// Every task, or one owner's.
#[tauri::command]
pub fn task_list(
    tasks: tauri::State<'_, BackgroundTasks>,
    owner: Option<String>,
) -> Vec<BackgroundTask> {
    tasks.list(owner.as_deref())
}

/// Ask a task to stop. False when it wasn't running.
#[tauri::command]
pub fn task_cancel(tasks: tauri::State<'_, BackgroundTasks>, id: String) -> bool {
    tasks.cancel(&id)
}

/// The owner's ended tasks it hasn't heard about, now marked heard.
#[tauri::command]
pub fn task_take_notices(
    tasks: tauri::State<'_, BackgroundTasks>,
    owner: String,
) -> Vec<BackgroundTask> {
    tasks.take_notices(&owner)
}

/// Open a finished task's file in the system's player, or its folder.
#[tauri::command]
pub async fn task_open(
    tasks: tauri::State<'_, BackgroundTasks>,
    id: String,
    folder: bool,
) -> Result<(), String> {
    let file = tasks
        .get(&id)
        .and_then(|t| t.result)
        .and_then(|r| {
            r.get("absPath")
                .and_then(|p| p.as_str())
                .map(std::path::PathBuf::from)
        })
        .ok_or("That task hasn't finished, or made no file.")?;
    if folder {
        let dir = file.parent().ok_or("The file has no folder.")?;
        return crate::links::folder_open(dir.to_string_lossy().into_owned()).await;
    }
    crate::links::open_render(&file)
}
