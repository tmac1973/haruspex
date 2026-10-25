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
