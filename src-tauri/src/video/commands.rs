//! Tauri commands for the video tools.

use super::binaries::{self, BinaryOverrides, Tool, VideoBinariesStatus};
use super::paths;
use super::probe::{self, EpisodeProbe};

/// Find ffmpeg, ffprobe and melt, honouring the paths set in Settings → Video.
#[tauri::command]
pub async fn video_binaries_status(overrides: BinaryOverrides) -> VideoBinariesStatus {
    binaries::resolve(&overrides).await
}

/// Every clip in an episode folder (`episode` relative to the working folder;
/// empty for the working folder itself).
#[tauri::command]
pub async fn video_probe_folder(
    working_dir: String,
    episode: String,
    overrides: BinaryOverrides,
) -> Result<EpisodeProbe, String> {
    let dir = paths::resolve_episode(&working_dir, &episode)?;
    let found = binaries::resolve(&overrides).await;
    let ffprobe = found.require(Tool::Ffprobe)?;
    Ok(probe::probe_episode(ffprobe, &working_dir, &dir).await)
}

/// One clip: a path in the working folder, or the intro or outro set in
/// Settings → Video.
#[tauri::command]
pub async fn video_probe_file(
    working_dir: String,
    path: String,
    intro: String,
    outro: String,
    overrides: BinaryOverrides,
) -> Result<probe::ClipInfo, String> {
    let file = paths::resolve_media(&working_dir, &path, &intro, &outro)?;
    let found = binaries::resolve(&overrides).await;
    let ffprobe = found.require(Tool::Ffprobe)?;
    probe::probe_file(ffprobe, &file, paths::display_path(&working_dir, &file)).await
}

/// The project's main track and what else is in it.
#[tauri::command]
pub async fn video_project_summary(
    working_dir: String,
    episode: String,
    project: Option<String>,
) -> Result<super::kdenlive::ProjectSummary, String> {
    super::project::summary(&working_dir, &episode, project.as_deref())
}

/// Make the main track hold a cut, creating the project if there is none.
#[tauri::command]
pub async fn video_project_cut(
    working_dir: String,
    episode: String,
    spec: super::project::CutSpec,
    settings: super::project::VideoSettings,
) -> Result<super::project::CutResult, String> {
    super::project::cut(&working_dir, &episode, spec, &settings).await
}

/// Trim, remove or move one clip.
#[tauri::command]
pub async fn video_project_op(
    working_dir: String,
    episode: String,
    project: Option<String>,
    op: super::project::ProjectOp,
    settings: super::project::VideoSettings,
) -> Result<super::project::CutResult, String> {
    super::project::op(&working_dir, &episode, project.as_deref(), op, &settings).await
}

/// Start rendering a project in the background.
#[tauri::command]
pub async fn video_render_start(
    app: tauri::AppHandle,
    tasks: tauri::State<'_, super::tasks::VideoTasks>,
    request: super::tasks::RenderRequest,
) -> Result<super::tasks::VideoTask, String> {
    use tauri::Emitter;
    let emit: super::tasks::Emit = std::sync::Arc::new(move |t: &super::tasks::VideoTask| {
        let _ = app.emit("video-task-progress", t);
    });
    super::tasks::start_render(emit, tasks.inner().clone(), request).await
}

/// A background task, or none when this run never started it.
#[tauri::command]
pub fn video_task_status(
    tasks: tauri::State<'_, super::tasks::VideoTasks>,
    id: String,
) -> Option<super::tasks::VideoTask> {
    tasks.status(&id)
}

/// Every background task this run started.
#[tauri::command]
pub fn video_task_list(
    tasks: tauri::State<'_, super::tasks::VideoTasks>,
) -> Vec<super::tasks::VideoTask> {
    tasks.list()
}

/// Cancel a running task. False when it wasn't running.
#[tauri::command]
pub fn video_task_cancel(tasks: tauri::State<'_, super::tasks::VideoTasks>, id: String) -> bool {
    tasks.cancel(&id)
}

/// libx264 and the hardware encoders melt can use here.
#[tauri::command]
pub async fn video_encoders_test(
    app: tauri::AppHandle,
    overrides: BinaryOverrides,
) -> Result<Vec<super::encode::EncoderOption>, String> {
    use tauri::Manager;
    let found = binaries::resolve(&overrides).await;
    let melt = found.require(Tool::Melt)?;
    let scratch = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("haruspex"))
        .join("video-encoder-test");
    Ok(super::encode::test_encoders(melt, &scratch).await)
}

/// Open a finished render in the system's player, or its folder.
#[tauri::command]
pub async fn video_task_open(
    tasks: tauri::State<'_, super::tasks::VideoTasks>,
    id: String,
    folder: bool,
) -> Result<(), String> {
    let file = tasks.output(&id).ok_or("That render hasn't finished.")?;
    if folder {
        let dir = file.parent().ok_or("The render has no folder.")?;
        return crate::links::open_folder(dir.to_string_lossy().into_owned()).await;
    }
    crate::links::open_render(&file)
}
