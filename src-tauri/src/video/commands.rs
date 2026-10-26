//! Tauri commands for the video tools.

use super::binaries::{self, BinaryOverrides, Tool, VideoBinariesStatus};
use super::paths;
use super::probe::{self, EpisodeProbe};

/// Find ffmpeg, ffprobe and melt, honouring the paths set in Settings → Video editing.
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
/// Settings → Video editing.
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
    let ffmpeg = found.require(Tool::Ffmpeg)?;
    let melt = found.require(Tool::Melt)?;
    let scratch = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("haruspex"))
        .join("video-encoder-test");
    Ok(super::encode::test_encoders(ffmpeg, melt, &scratch).await)
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
    let episode_dir = super::project::episode_home(&working_dir, &episode, &project_path)?;
    // A render older than the cut would get captions that don't fit it.
    let modified = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let current = latest_render(&episode_dir, &project_path)
        .filter(|r| modified(r) >= modified(&project_path));
    let target = match render.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => paths::resolve_in_working(&working_dir, r)?.with_extension("srt"),
        None => match current {
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
        let list: Vec<String> = t.untranscribed.iter().map(u32::to_string).collect();
        shown.push_str(&if list.len() == 1 {
            format!(" (clip {} has no transcript, so no captions)", list[0])
        } else {
            format!(
                " (clips {} have no transcripts, so no captions)",
                list.join(", ")
            )
        });
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
    let episode_dir = super::project::episode_home(&working_dir, &episode, &path)?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let target = episode_dir.join(format!("{stem}.chapters.txt"));
    std::fs::write(&target, &text).map_err(|e| format!("can't write the chapters: {e}"))?;
    Ok(ChaptersWritten {
        path: paths::display_path(&working_dir, &target),
        text,
    })
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SceneCuts {
    pub cuts: Vec<f64>,
    /// More were found than are listed.
    pub capped: bool,
}

/// Where a clip's picture changes shot.
#[tauri::command]
pub async fn video_scenes(
    working_dir: String,
    path: String,
    threshold: f64,
    settings: super::project::VideoSettings,
) -> Result<SceneCuts, String> {
    let found = binaries::resolve(&settings.overrides).await;
    let ffmpeg = found.require(Tool::Ffmpeg)?;
    let file = paths::resolve_media(&working_dir, &path, &settings.intro, &settings.outro)?;
    let (cuts, capped) = super::scenes::detect(ffmpeg, &file, threshold.clamp(0.05, 0.95)).await?;
    Ok(SceneCuts { cuts, capped })
}

/// Which frames a contact sheet shows.
#[derive(serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FrameRequest {
    /// A clip, with `times` or `every_secs`.
    pub path: Option<String>,
    pub times: Option<Vec<f64>>,
    pub every_secs: Option<f64>,
    /// Or times in the cut of a project (`project` or the episode's).
    pub timeline_times: Option<Vec<f64>>,
    pub project: Option<String>,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    /// 1-based, as drawn on the sheet.
    pub n: u32,
    pub path: String,
    pub source_secs: f64,
    pub timeline_secs: Option<f64>,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ContactSheet {
    /// `data:image/jpeg;base64,…`
    pub data_url: String,
    pub tiles: Vec<Tile>,
}

/// A numbered sheet of frames from a clip or from the cut.
#[tauri::command]
pub async fn video_frames(
    working_dir: String,
    episode: String,
    request: FrameRequest,
    settings: super::project::VideoSettings,
) -> Result<ContactSheet, String> {
    use super::frames;
    use base64::Engine;
    let found = binaries::resolve(&settings.overrides).await;
    let ffmpeg = found.require(Tool::Ffmpeg)?.to_string();
    let ffprobe = found.require(Tool::Ffprobe)?.to_string();
    // (file, shown path, source secs, timeline secs)
    let mut wanted: Vec<(std::path::PathBuf, String, f64, Option<f64>)> = Vec::new();
    match (&request.path, &request.timeline_times) {
        (Some(path), None) => {
            let file = paths::resolve_media(&working_dir, path, &settings.intro, &settings.outro)?;
            let shown = paths::display_path(&working_dir, &file);
            let times = match (&request.times, request.every_secs) {
                (Some(t), None) if !t.is_empty() => t.clone(),
                (None, Some(every)) if every > 0.0 => {
                    let info = super::probe::probe_file(&ffprobe, &file, shown.clone()).await?;
                    let n = ((info.duration_secs / every).floor() as usize)
                        .clamp(1, frames::MAX_FRAMES);
                    let step = info.duration_secs / n as f64;
                    (0..n).map(|i| step * i as f64 + step / 2.0).collect()
                }
                _ => return Err("Give either times or every_secs with a path.".into()),
            };
            wanted.extend(
                times
                    .into_iter()
                    .map(|t| (file.clone(), shown.clone(), t, None)),
            );
        }
        (None, Some(times)) if !times.is_empty() => {
            let project = super::project::default_project(
                &working_dir,
                &episode,
                request.project.as_deref(),
                false,
            )?;
            let doc = super::kdenlive::open(&project)?;
            let spans = super::kdenlive::timeline_map::spans(&doc);
            for &t in times {
                let (span, at) = super::kdenlive::timeline_map::source_at(&spans, t)
                    .ok_or_else(|| format!("Nothing is on the main track at {t:.1} s."))?;
                wanted.push((
                    span.file.clone(),
                    paths::display_path(&working_dir, &span.file),
                    at,
                    Some(t),
                ));
            }
        }
        _ => return Err("Give a path (with times or every_secs), or timeline_times.".into()),
    }
    if wanted.len() > frames::MAX_FRAMES {
        return Err(format!(
            "At most {} frames fit on a sheet.",
            frames::MAX_FRAMES
        ));
    }
    let mut pngs = Vec::new();
    for (file, _, at, _) in &wanted {
        pngs.push(frames::extract_frame(&ffmpeg, file, *at, 960).await?);
    }
    let jpeg = frames::contact_sheet(&pngs)?;
    Ok(ContactSheet {
        data_url: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(jpeg)
        ),
        tiles: wanted
            .into_iter()
            .enumerate()
            .map(|(i, (_, path, at, tl))| Tile {
                n: i as u32 + 1,
                path,
                source_secs: at,
                timeline_secs: tl,
            })
            .collect(),
    })
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailWritten {
    pub path: String,
    pub data_url: String,
    #[ts(type = "number")]
    pub bytes: u64,
}

/// Where a thumbnail goes: `<episode>/<name or project stem or episode>.thumbnail.jpg`
/// (a given name ends `.jpg` as it is), the old one backed up first.
fn thumbnail_target(
    working_dir: &str,
    episode: &str,
    project: Option<&str>,
    name: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let episode_dir = match super::project::default_project(working_dir, episode, project, false) {
        Ok(p) => super::project::episode_home(working_dir, episode, &p)?,
        Err(_) => paths::resolve_episode(working_dir, episode)?,
    };
    let file = match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => {
            let n = n.trim_end_matches(".jpg");
            if n.contains(['/', '\\']) || n.starts_with('.') {
                return Err("name is a file name, not a path.".into());
            }
            format!("{n}.jpg")
        }
        None => {
            let stem = super::project::default_project(working_dir, episode, project, false)
                .ok()
                .and_then(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_string))
                .or_else(|| {
                    episode_dir
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "video".into());
            format!("{stem}.thumbnail.jpg")
        }
    };
    let target = episode_dir.join(file);
    if target.exists() {
        let backups = episode_dir.join(".haruspex").join("backups");
        std::fs::create_dir_all(&backups)
            .map_err(|e| format!("can't back up the old thumbnail: {e}"))?;
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S");
        let stem = target
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("thumbnail");
        let _ = std::fs::copy(&target, backups.join(format!("{stem}-{stamp}.jpg")));
    }
    Ok(target)
}

fn write_thumbnail(
    working_dir: &str,
    target: &std::path::Path,
    jpeg: Vec<u8>,
) -> Result<ThumbnailWritten, String> {
    use base64::Engine;
    std::fs::write(target, &jpeg).map_err(|e| format!("can't save the thumbnail: {e}"))?;
    Ok(ThumbnailWritten {
        path: paths::display_path(working_dir, target),
        bytes: jpeg.len() as u64,
        data_url: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(jpeg)
        ),
    })
}

/// A thumbnail from a frame: of a clip or render (`path` and `at`), or of the
/// cut (`timeline_at`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn video_thumbnail_from_frame(
    working_dir: String,
    episode: String,
    project: Option<String>,
    path: Option<String>,
    at: Option<f64>,
    timeline_at: Option<f64>,
    contain: bool,
    name: Option<String>,
    settings: super::project::VideoSettings,
) -> Result<ThumbnailWritten, String> {
    let found = binaries::resolve(&settings.overrides).await;
    let ffmpeg = found.require(Tool::Ffmpeg)?;
    let (file, at) = match (path.as_deref(), at, timeline_at) {
        (Some(p), Some(at), None) => (
            paths::resolve_media(&working_dir, p, &settings.intro, &settings.outro)?,
            at,
        ),
        (None, None, Some(t)) => {
            let proj =
                super::project::default_project(&working_dir, &episode, project.as_deref(), false)?;
            let doc = super::kdenlive::open(&proj)?;
            let spans = super::kdenlive::timeline_map::spans(&doc);
            let (span, at) = super::kdenlive::timeline_map::source_at(&spans, t)
                .ok_or_else(|| format!("Nothing is on the main track at {t:.1} s."))?;
            (span.file.clone(), at)
        }
        _ => return Err("Give path with at, or timeline_at.".into()),
    };
    let png = super::frames::extract_frame(ffmpeg, &file, at, 3840).await?;
    let jpeg = super::thumbnail::make(&png, contain)?;
    let target = thumbnail_target(&working_dir, &episode, project.as_deref(), name.as_deref())?;
    write_thumbnail(&working_dir, &target, jpeg)
}

/// A thumbnail from a picture the image backend made.
#[tauri::command]
pub fn video_thumbnail_from_image(
    working_dir: String,
    episode: String,
    project: Option<String>,
    image_base64: String,
    contain: bool,
    name: Option<String>,
) -> Result<ThumbnailWritten, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64.trim())
        .map_err(|e| format!("the picture didn't decode: {e}"))?;
    let jpeg = super::thumbnail::make(&bytes, contain)?;
    let target = thumbnail_target(&working_dir, &episode, project.as_deref(), name.as_deref())?;
    write_thumbnail(&working_dir, &target, jpeg)
}

/// The YouTube account the upload sign-in is for, if any.
#[tauri::command]
pub async fn youtube_account() -> Option<super::youtube::YoutubeAccount> {
    super::youtube::account().await
}

/// Sign in to YouTube for uploads (only the `youtube.upload` scope).
#[tauri::command]
pub async fn youtube_sign_in(
    proxy: Option<crate::proxy::ProxyConfig>,
) -> Result<super::youtube::YoutubeAccount, String> {
    super::youtube::sign_in(proxy.as_ref()).await
}

#[tauri::command]
pub async fn youtube_sign_out(proxy: Option<crate::proxy::ProxyConfig>) -> Result<(), String> {
    super::youtube::sign_out(proxy.as_ref()).await
}

/// Upload a render the user confirmed, in the background.
#[tauri::command]
pub async fn youtube_upload_start(
    app: tauri::AppHandle,
    tasks: tauri::State<'_, super::tasks::VideoTasks>,
    request: super::tasks::UploadRequest,
) -> Result<super::tasks::VideoTask, String> {
    use tauri::Emitter;
    let emit: super::tasks::Emit = std::sync::Arc::new(move |t: &super::tasks::VideoTask| {
        let _ = app.emit("video-task-progress", t);
    });
    super::tasks::start_upload(emit, tasks.inner().clone(), request).await
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UploadPlan {
    /// The render, relative to the working folder.
    pub render: String,
    pub duration_secs: Option<f64>,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub thumbnail: Option<String>,
    pub thumbnail_data_url: Option<String>,
    /// The project's chapters file, when there is one.
    pub chapters: Option<String>,
}

/// What an upload of an episode would send: the render (the one named, or the
/// project's newest), its thumbnail and chapters.
#[tauri::command]
pub async fn youtube_upload_plan(
    working_dir: String,
    episode: String,
    project: Option<String>,
    render: Option<String>,
    thumbnail: Option<String>,
    settings: super::project::VideoSettings,
) -> Result<UploadPlan, String> {
    use base64::Engine;
    let project_path =
        super::project::default_project(&working_dir, &episode, project.as_deref(), false).ok();
    let episode_dir = match &project_path {
        Some(p) => super::project::episode_home(&working_dir, &episode, p)?,
        None => paths::resolve_episode(&working_dir, &episode)?,
    };
    let render_path = match render.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => paths::resolve_in_working(&working_dir, r)?,
        None => project_path
            .as_deref()
            .and_then(|p| latest_render(&episode_dir, p))
            .ok_or("There is no render to upload yet. Render the video first.")?,
    };
    if !render_path.is_file() {
        return Err(format!(
            "{} doesn't exist.",
            paths::display_path(&working_dir, &render_path)
        ));
    }
    let size_bytes = std::fs::metadata(&render_path)
        .map(|m| m.len())
        .unwrap_or(0);
    let found = binaries::resolve(&settings.overrides).await;
    let duration_secs = match found.require(Tool::Ffprobe) {
        Ok(ffprobe) => super::probe::probe_file(ffprobe, &render_path, String::new())
            .await
            .ok()
            .map(|i| i.duration_secs),
        Err(_) => None,
    };
    let stem = project_path
        .as_deref()
        .and_then(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_string))
        .or_else(|| {
            episode_dir
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    let thumb_path = match thumbnail
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Some(t) => Some(paths::resolve_in_working(&working_dir, t)?),
        None => Some(episode_dir.join(format!("{stem}.thumbnail.jpg"))).filter(|p| p.is_file()),
    };
    let thumbnail_data_url = match &thumb_path {
        Some(p) => Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD
                .encode(std::fs::read(p).map_err(|e| format!("can't read the thumbnail: {e}"))?)
        )),
        None => None,
    };
    let chapters = std::fs::read_to_string(episode_dir.join(format!("{stem}.chapters.txt"))).ok();
    Ok(UploadPlan {
        render: paths::display_path(&working_dir, &render_path),
        duration_secs,
        size_bytes,
        thumbnail: thumb_path.map(|p| paths::display_path(&working_dir, &p)),
        thumbnail_data_url,
        chapters,
    })
}
