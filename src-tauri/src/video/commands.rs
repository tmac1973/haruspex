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

/// Running transcriptions, by the id the frontend gave, for cancelling.
static TRANSCRIBING: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, super::transcribe::Cancel>>,
> = std::sync::LazyLock::new(Default::default);

/// Transcribe an episode's clips (or the ones named) with timestamps.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn video_transcribe(
    app: tauri::AppHandle,
    whisper: tauri::State<'_, crate::whisper::VideoWhisper>,
    models: tauri::State<'_, crate::models::ModelManager>,
    working_dir: String,
    episode: String,
    clips: Vec<String>,
    refresh: bool,
    settings: super::project::VideoSettings,
    job: String,
    on_progress: tauri::ipc::Channel<super::transcribe::TranscribeProgress>,
) -> Result<Vec<super::transcribe::Transcript>, String> {
    use super::transcribe;
    let found = binaries::resolve(&settings.overrides).await;
    let ffmpeg = found.require(Tool::Ffmpeg)?.to_string();
    let ffprobe = found.require(Tool::Ffprobe)?.to_string();
    let model = transcribe::model_for(models.models_dir())
        .ok_or("No speech model is installed. Settings → Audio downloads one.")?;
    let episode_dir = paths::resolve_episode(&working_dir, &episode)?;
    let list = transcribe::clips_to_transcribe(
        &ffprobe,
        &working_dir,
        &episode,
        &clips,
        &settings.intro,
        &settings.outro,
    )
    .await?;
    if list.is_empty() {
        return Err("There is no clip with sound to transcribe.".into());
    }
    let cancel = transcribe::Cancel::default();
    if let Ok(mut m) = TRANSCRIBING.lock() {
        m.insert(job.clone(), cancel.clone());
    }
    let count = list.len() as u32;
    let mut out = Vec::new();
    let mut result = Ok(());
    let needed = list
        .iter()
        .any(|(file, _)| transcribe::needs_whisper(&episode_dir, file, &model, refresh));
    if needed {
        if let Err(e) = transcribe::ensure_server(&app, &whisper, &model).await {
            if let Ok(mut m) = TRANSCRIBING.lock() {
                m.remove(&job);
            }
            return Err(e);
        }
    }
    for (i, (file, info)) in list.iter().enumerate() {
        let channel = on_progress.clone();
        let (clip, total) = (info.path.clone(), info.duration_secs);
        let progress = move |done: f64| {
            let _ = channel.send(transcribe::TranscribeProgress {
                clip: clip.clone(),
                done_secs: done,
                total_secs: total,
                index: i as u32 + 1,
                count,
            });
        };
        progress(0.0);
        match transcribe::transcribe_clip(
            &whisper,
            &ffmpeg,
            &model,
            &episode_dir,
            file,
            info,
            refresh,
            &cancel,
            &progress,
        )
        .await
        {
            Ok(t) => out.push(t),
            Err(e) => {
                result = Err(e);
                break;
            }
        }
    }
    if let Ok(mut m) = TRANSCRIBING.lock() {
        m.remove(&job);
    }
    transcribe::schedule_idle_stop(app.clone());
    result.map(|()| out)
}

/// Stop a running transcription.
#[tauri::command]
pub fn video_transcribe_cancel(job: String) -> bool {
    TRANSCRIBING
        .lock()
        .ok()
        .and_then(|m| m.get(&job).cloned())
        .map(|c| c.cancel())
        .is_some()
}

/// Quiet stretches in a clip, in its own time.
#[tauri::command]
pub async fn video_silences(
    working_dir: String,
    path: String,
    min_secs: f64,
    noise_db: f64,
    settings: super::project::VideoSettings,
) -> Result<Vec<super::silence::SilenceRange>, String> {
    let found = binaries::resolve(&settings.overrides).await;
    let ffmpeg = found.require(Tool::Ffmpeg)?;
    let file = paths::resolve_media(&working_dir, &path, &settings.intro, &settings.outro)?;
    super::silence::detect(ffmpeg, &file, noise_db, min_secs.max(0.1), None).await
}

/// The cut's speech in the video's time.
#[tauri::command]
pub fn video_project_transcript(
    working_dir: String,
    episode: String,
    project: Option<String>,
) -> Result<super::transcribe::TimelineTranscript, String> {
    super::transcribe::timeline_transcript(&working_dir, &episode, project.as_deref())
        .map(|(t, ..)| t)
}

/// The newest render of a project, if any.
fn latest_render(
    episode_dir: &std::path::Path,
    project: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let stem = project.file_stem()?.to_str()?.to_string();
    let mut renders: Vec<_> = std::fs::read_dir(episode_dir.join("renders"))
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().is_some_and(|e| e == "mp4")
                && !p.to_string_lossy().ends_with(".part.mp4")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(&stem))
        })
        .collect();
    renders.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    renders.pop()
}

/// Write the cut's captions as SRT: next to `render` when named, else next to
/// the newest render, else beside the project. Returns where.
#[tauri::command]
pub fn video_write_captions(
    working_dir: String,
    episode: String,
    project: Option<String>,
    render: Option<String>,
) -> Result<String, String> {
    let (t, lines, project_path) =
        super::transcribe::timeline_transcript(&working_dir, &episode, project.as_deref())?;
    if lines.is_empty() {
        return Err("There is no transcript to caption yet. Transcribe the clips first.".into());
    }
    let episode_dir = paths::resolve_episode(&working_dir, &episode)?;
    let target = match render.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => paths::resolve_in_working(&working_dir, r)?.with_extension("srt"),
        None => match latest_render(&episode_dir, &project_path) {
            Some(r) => r.with_extension("srt"),
            None => episode_dir.join(format!(
                "{}.srt",
                project_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("captions")
            )),
        },
    };
    // Through the working-folder check, so nothing lands outside it.
    let target =
        paths::resolve_in_working(&working_dir, &paths::display_path(&working_dir, &target))?;
    std::fs::write(&target, super::subtitles::srt(&lines))
        .map_err(|e| format!("can't write the captions: {e}"))?;
    let mut shown = paths::display_path(&working_dir, &target);
    if !t.untranscribed.is_empty() {
        shown.push_str(&format!(
            " (clips {} have no transcript, so no captions)",
            t.untranscribed
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    Ok(shown)
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChaptersWritten {
    pub path: String,
    pub text: String,
}

/// Check chapters against YouTube's rules and write them beside the project.
#[tauri::command]
pub fn video_write_chapters(
    working_dir: String,
    episode: String,
    project: Option<String>,
    chapters: Vec<super::subtitles::Chapter>,
) -> Result<ChaptersWritten, String> {
    use super::subtitles;
    let path = super::project::default_project(&working_dir, &episode, project.as_deref(), false)?;
    let doc = super::kdenlive::open(&path)?;
    let total = doc.fps.secs(doc.sequence_end());
    let mut chapters = chapters;
    chapters.sort_by(|a, b| a.at_secs.total_cmp(&b.at_secs));
    let problems = subtitles::check_chapters(&chapters, total);
    if !problems.is_empty() {
        return Err(problems.join(" "));
    }
    let text = subtitles::chapters_text(&chapters);
    let episode_dir = paths::resolve_episode(&working_dir, &episode)?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let target = episode_dir.join(format!("{stem}.chapters.txt"));
    std::fs::write(&target, &text).map_err(|e| format!("can't write the chapters: {e}"))?;
    Ok(ChaptersWritten {
        path: paths::display_path(&working_dir, &target),
        text,
    })
}
