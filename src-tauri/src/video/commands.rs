//! Tauri commands for the video tools.

use super::binaries::{self, BinaryOverrides, Tool, VideoBinariesStatus};
use super::paths;
use super::probe::{self, EpisodeProbe};
use std::path::Path;

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

/// Make the episode folder when it is missing (`episode` relative to the
/// working folder). True when it was made. The Video sequence job calls it
/// before its first probe, since it writes a new episode.
#[tauri::command]
pub fn video_episode_ensure(working_dir: String, episode: String) -> Result<bool, String> {
    paths::ensure_episode(&working_dir, &episode).map(|(_, created)| created)
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

/// Put the bundled ffmpeg, ffprobe and melt on the PATH of the model's own
/// commands (Code tab, Shell tab), or take them off: on while Settings →
/// Video editing is on. Returns whether they are on, which they can't be
/// without the media bundle.
#[tauri::command]
pub async fn media_shims_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::media_env::set_shims(&app, enabled))
        .await
        .map_err(|e| e.to_string())?
}

/// The project's main track and what else is in it.
#[tauri::command]
pub async fn video_project_summary(
    working_dir: String,
    episode: String,
    project: Option<String>,
) -> Result<super::format::ProjectSummary, String> {
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
    unpanicked(super::project::cut(&working_dir, &episode, spec, &settings)).await
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
    unpanicked(super::project::op(
        &working_dir,
        &episode,
        project.as_deref(),
        op,
        &settings,
    ))
    .await
}

/// `edit`, with a panic turned into an error. Tauri runs an async command as
/// a spawned task and answers when it ends, so one that panics never answers
/// and the tool call waits until the turn is stopped.
async fn unpanicked<T>(
    edit: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    use futures_util::FutureExt;
    std::panic::AssertUnwindSafe(edit)
        .catch_unwind()
        .await
        .unwrap_or_else(|panic| {
            let why = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            log::error!("video project edit panicked: {why}");
            Err(format!("The edit failed inside Haruspex: {why}"))
        })
}

/// Start rendering a project in the background.
#[tauri::command]
pub async fn video_render_start(
    tasks: tauri::State<'_, crate::tasks::BackgroundTasks>,
    video: tauri::State<'_, super::tasks::VideoTasks>,
    request: super::tasks::RenderRequest,
) -> Result<crate::tasks::BackgroundTask, String> {
    super::tasks::start_render(tasks.inner().clone(), video.inner().clone(), request).await
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
    let ffmpeg = binaries::hardware_probe_ffmpeg(&overrides).await;
    let scratch = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("haruspex"))
        .join("video-encoder-test");
    Ok(super::encode::test_encoders(ffmpeg.as_deref(), melt, &scratch).await)
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
    let ffprobe = found.require(Tool::Ffprobe)?.to_string();
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
    let run = Transcription {
        app: &app,
        whisper: &whisper,
        models: &models,
        ffmpeg: found.require(Tool::Ffmpeg)?,
        dir: &episode_dir,
        refresh,
        language: None,
    };
    run.all(&list, job, on_progress).await
}

/// Transcribe any sound or video file in the working folder, with each
/// word's time. Kept in `<working folder>/.haruspex/transcripts/`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn audio_transcribe(
    app: tauri::AppHandle,
    whisper: tauri::State<'_, crate::whisper::VideoWhisper>,
    models: tauri::State<'_, crate::models::ModelManager>,
    working_dir: String,
    path: String,
    language: Option<String>,
    refresh: bool,
    overrides: BinaryOverrides,
    job: String,
    on_progress: tauri::ipc::Channel<super::transcribe::TranscribeProgress>,
) -> Result<super::transcribe::Transcript, String> {
    let file = paths::resolve_media(&working_dir, &path, "", "")?;
    if !file.is_file() {
        return Err(format!(
            "No file named {} in the working folder.",
            path.trim()
        ));
    }
    let found = binaries::resolve(&overrides).await;
    let ffprobe = found.require(Tool::Ffprobe)?;
    let info = probe::probe_file(ffprobe, &file, paths::display_path(&working_dir, &file)).await?;
    if info.audio.is_empty() {
        return Err(format!("{} has no sound to transcribe.", info.path));
    }
    let root = paths::resolve_episode(&working_dir, "")?;
    let language = language
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty() && l != "auto");
    let run = Transcription {
        app: &app,
        whisper: &whisper,
        models: &models,
        ffmpeg: found.require(Tool::Ffmpeg)?,
        dir: &root,
        refresh,
        language: language.as_deref(),
    };
    let mut out = run.all(&[(file, info)], job, on_progress).await?;
    out.pop().ok_or_else(|| "Nothing was transcribed.".into())
}

/// One transcription command's run: where its transcripts are kept, and how.
struct Transcription<'a> {
    app: &'a tauri::AppHandle,
    whisper: &'a crate::whisper::VideoWhisper,
    models: &'a crate::models::ModelManager,
    ffmpeg: &'a str,
    /// The folder whose `.haruspex/` keeps the sound and the transcripts.
    dir: &'a std::path::Path,
    refresh: bool,
    language: Option<&'a str>,
}

impl Transcription<'_> {
    /// Transcribe each file in turn, holding the server while any needs it.
    async fn all(
        &self,
        list: &[(std::path::PathBuf, probe::ClipInfo)],
        job: String,
        on_progress: tauri::ipc::Channel<super::transcribe::TranscribeProgress>,
    ) -> Result<Vec<super::transcribe::Transcript>, String> {
        use super::transcribe;
        let model = transcribe::model_for(self.models.models_dir())
            .ok_or("No speech model is installed. Settings → Audio downloads one.")?;
        if self.language.is_some_and(|l| l != "en") && transcribe::language_for(&model) == "en" {
            return Err(
                "The speech model knows only English. Settings → Video editing → \
                 Transcription downloads one that knows more languages."
                    .into(),
            );
        }
        let cancel = transcribe::Cancel::default();
        if let Ok(mut m) = TRANSCRIBING.lock() {
            m.insert(job.clone(), cancel.clone());
        }
        let result = self.each(list, &model, &cancel, &on_progress).await;
        if let Ok(mut m) = TRANSCRIBING.lock() {
            m.remove(&job);
        }
        result
    }

    async fn each(
        &self,
        list: &[(std::path::PathBuf, probe::ClipInfo)],
        model: &std::path::Path,
        cancel: &super::transcribe::Cancel,
        on_progress: &tauri::ipc::Channel<super::transcribe::TranscribeProgress>,
    ) -> Result<Vec<super::transcribe::Transcript>, String> {
        use super::transcribe;
        let needed = list.iter().any(|(file, _)| {
            transcribe::needs_whisper(self.dir, file, model, self.refresh, self.language)
        });
        // Held to the end; dropping it schedules the idle stop.
        let _lease = if needed {
            Some(transcribe::lease_server(self.app, model).await?)
        } else {
            None
        };
        let count = list.len() as u32;
        let mut out = Vec::new();
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
            let how = transcribe::How {
                refresh: self.refresh,
                language: self.language,
                cancel,
                progress: &progress,
            };
            out.push(
                transcribe::transcribe_clip(
                    self.whisper,
                    self.ffmpeg,
                    model,
                    self.dir,
                    file,
                    info,
                    &how,
                )
                .await?,
            );
        }
        Ok(out)
    }
}

/// A clip's kept transcript, without transcribing: for the transcript
/// viewer, which also learns where to keep the clip's edit list.
#[tauri::command]
pub fn video_transcript_for(
    working_dir: String,
    path: String,
) -> Result<Option<super::transcribe::TranscriptFound>, String> {
    let root = paths::resolve_episode(&working_dir, "")?;
    let file = paths::resolve_media(&working_dir, &path, "", "")?;
    Ok(super::transcribe::find_cached(&root, &file))
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

/// One stretch of a sound file, for `audio_join`.
#[derive(Clone, Debug, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AudioSlice {
    /// Relative to the working folder.
    pub path: String,
    pub from_secs: f64,
    pub to_secs: f64,
}

/// The filter graph that cuts each input to its stretch and joins them, mono 24 kHz.
pub fn join_graph(slices: &[(f64, f64)]) -> String {
    let mut g = String::new();
    for (i, (from, to)) in slices.iter().enumerate() {
        g.push_str(&format!(
            "[{i}:a]atrim=start={from:.4}:end={to:.4},asetpts=PTS-STARTPTS,\
             aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono[p{i}];"
        ));
    }
    for i in 0..slices.len() {
        g.push_str(&format!("[p{i}]"));
    }
    g.push_str(&format!("concat=n={}:v=0:a=1[out]", slices.len()));
    g
}

/// Stretches of sound files in the working folder joined end to end into
/// one WAV: a speaking window's slices of its spoken lines.
#[tauri::command]
pub async fn audio_join(
    working_dir: String,
    parts: Vec<AudioSlice>,
    out: String,
    overrides: BinaryOverrides,
) -> Result<f64, String> {
    if parts.is_empty() {
        return Err("Joining needs at least one stretch.".into());
    }
    if !out.to_ascii_lowercase().ends_with(".wav") {
        return Err("The joined file must be a .wav.".into());
    }
    let bad = |p: &AudioSlice| {
        !p.from_secs.is_finite() || !p.to_secs.is_finite() || p.to_secs <= p.from_secs
    };
    if parts.iter().any(bad) {
        return Err("Each stretch must end after it starts.".into());
    }
    let found = binaries::resolve(&overrides).await;
    let ffmpeg = found.require(Tool::Ffmpeg)?;
    let files = parts
        .iter()
        .map(|p| paths::resolve_media(&working_dir, &p.path, "", ""))
        .collect::<Result<Vec<_>, _>>()?;
    let target = paths::resolve_in_working(&working_dir, &out)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    }
    let graph = join_graph(
        &parts
            .iter()
            .map(|p| (p.from_secs, p.to_secs))
            .collect::<Vec<_>>(),
    );
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    for f in &files {
        args.push("-i".into());
        args.push(f.into());
    }
    for a in [
        "-filter_complex",
        &graph,
        "-map",
        "[out]",
        "-c:a",
        "pcm_s16le",
    ] {
        args.push(a.into());
    }
    args.push(target.clone().into());
    ffmpeg_run(ffmpeg, &args, "Joining the speech").await?;
    let wav = std::fs::read(&target).map_err(|e| format!("Can't read the joined speech: {e}"))?;
    Ok(crate::speech_server::wav_seconds(&wav))
}

/// The pauses in a sound file in the working folder, quieter than -35 dB
/// for at least `min_secs`.
#[tauri::command]
pub async fn audio_silences(
    working_dir: String,
    path: String,
    min_secs: f64,
    overrides: BinaryOverrides,
) -> Result<Vec<super::silence::SilenceRange>, String> {
    let file = paths::resolve_media(&working_dir, &path, "", "")?;
    let found = binaries::resolve(&overrides).await;
    let ffmpeg = found.require(Tool::Ffmpeg)?;
    super::silence::detect(ffmpeg, &file, -35.0, min_secs.max(0.1), None).await
}

/// Sound files in the working folder joined end to end into one, each
/// crossfading into the next over `crossfade_secs`: songs made one after
/// another for a bed longer than one song. `out` is a `.wav` in the working
/// folder.
#[tauri::command]
pub async fn audio_crossfade_join(
    working_dir: String,
    parts: Vec<String>,
    crossfade_secs: f64,
    out: String,
    overrides: BinaryOverrides,
) -> Result<(), String> {
    if parts.len() < 2 {
        return Err("Joining needs two files or more.".into());
    }
    if !out.to_ascii_lowercase().ends_with(".wav") {
        return Err("The joined file must be a .wav.".into());
    }
    let found = binaries::resolve(&overrides).await;
    let ffmpeg = found.require(Tool::Ffmpeg)?;
    let files = parts
        .iter()
        .map(|p| paths::resolve_media(&working_dir, p, "", ""))
        .collect::<Result<Vec<_>, _>>()?;
    let target = paths::resolve_in_working(&working_dir, &out)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    }
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-v", "error", "-y"]);
    for f in &files {
        cmd.arg("-i").arg(f);
    }
    cmd.args([
        "-filter_complex",
        &crossfade_graph(files.len(), crossfade_secs),
    ])
    .args(["-map", "[out]", "-c:a", "pcm_s16le"])
    .arg(&target)
    .stdin(std::process::Stdio::null())
    .kill_on_drop(true);
    super::prepare_child(&mut cmd);
    let done = cmd
        .output()
        .await
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !done.status.success() {
        let err = String::from_utf8_lossy(&done.stderr);
        return Err(format!(
            "could not join the sound: {}",
            super::ffmpeg_error(&err, "ffmpeg failed")
        ));
    }
    Ok(())
}

/// `n` inputs chained through `acrossfade`, the last labelled `[out]`.
fn crossfade_graph(n: usize, secs: f64) -> String {
    let d = format!("{:.3}", secs.clamp(0.1, 10.0));
    let mut graph = Vec::new();
    let mut prev = "[0:a]".to_string();
    for i in 1..n {
        let label = if i == n - 1 {
            "[out]".to_string()
        } else {
            format!("[x{i}]")
        };
        graph.push(format!(
            "{prev}[{i}:a]acrossfade=d={d}:c1=tri:c2=tri{label}"
        ));
        prev = label;
    }
    graph.join(";")
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

/// Where [`video_write_captions`] writes: beside `render` when named, else
/// beside the newest render that isn't older than the cut, else beside the
/// project in `episode_dir`. Always inside the working folder.
fn captions_target(
    working_dir: &str,
    episode_dir: &std::path::Path,
    project_path: &std::path::Path,
    render: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    // A render older than the cut would get captions that don't fit it.
    let modified = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let current =
        latest_render(episode_dir, project_path).filter(|r| modified(r) >= modified(project_path));
    let target = match render.map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => paths::resolve_in_working(working_dir, r)?.with_extension("srt"),
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
    paths::resolve_in_working(working_dir, &paths::display_path(working_dir, &target))
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
    let target = captions_target(&working_dir, &episode_dir, &project_path, render.as_deref())?;
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
    let path = super::project::default_project(&working_dir, &episode, project.as_deref(), None)?;
    let doc = super::format::ProjectDoc::open(&path)?;
    let total = doc.fps().secs(doc.sequence_end());
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
    /// Pictures in the working folder, put on the sheet before the frames:
    /// what a clip is checked against.
    #[serde(default)]
    #[ts(optional)]
    pub images: Option<Vec<SheetImage>>,
}

/// A picture on a contact sheet, with what it is.
#[derive(serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SheetImage {
    pub path: String,
    pub label: String,
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
    /// For a picture rather than a frame: what it is.
    pub label: Option<String>,
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
                None,
            )?;
            let doc = super::format::ProjectDoc::open(&project)?;
            let spans = doc.spans();
            for &t in times {
                let (span, at) = super::timeline::source_at(&spans, t)
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
    let images = request.images.unwrap_or_default();
    if wanted.len() + images.len() > frames::MAX_FRAMES {
        return Err(format!(
            "At most {} frames fit on a sheet.",
            frames::MAX_FRAMES
        ));
    }
    let mut pngs = Vec::new();
    let mut tiles = Vec::new();
    for image in &images {
        let file =
            paths::resolve_media(&working_dir, &image.path, &settings.intro, &settings.outro)?;
        pngs.push(std::fs::read(&file).map_err(|e| format!("can't read {}: {e}", image.path))?);
        tiles.push(Tile {
            n: tiles.len() as u32 + 1,
            path: paths::display_path(&working_dir, &file),
            source_secs: 0.0,
            timeline_secs: None,
            label: Some(image.label.clone()),
        });
    }
    for (file, _, at, _) in &wanted {
        pngs.push(frames::extract_frame(&ffmpeg, file, *at, 960).await?);
    }
    let jpeg = frames::contact_sheet(&pngs)?;
    Ok(ContactSheet {
        data_url: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(jpeg)
        ),
        tiles: {
            let first = tiles.len();
            tiles.extend(
                wanted
                    .into_iter()
                    .enumerate()
                    .map(|(i, (_, path, at, tl))| Tile {
                        n: (first + i) as u32 + 1,
                        path,
                        source_secs: at,
                        timeline_secs: tl,
                        label: None,
                    }),
            );
            tiles
        },
    })
}

/// One frame of a clip, kept at full size.
#[derive(serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StillRequest {
    /// A clip in the working folder…
    pub path: Option<String>,
    /// …or a generated clip in the cache, by hash.
    pub video_hash: Option<String>,
    /// `time` (with `at_secs`), `first` or `last`.
    pub which: String,
    pub at_secs: Option<f64>,
    /// A `.png` in the episode folder; default `<episode>/.haruspex/stills/`.
    pub out: Option<String>,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StillWritten {
    /// Relative to the working folder.
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// `data:image/jpeg;base64,…`, at most 960 wide, to show in the chat.
    pub preview_data_url: String,
}

/// A cached clip's file, by an already checked hash.
fn cached_clip(app: &tauri::AppHandle, hash: &str) -> Result<std::path::PathBuf, String> {
    if !crate::blob_cache::is_valid_hash(hash) {
        return Err("That is not a generated clip's hash.".into());
    }
    crate::audio_cache::protocol::locate(app, hash)
        .map(|(_, path)| path)
        .map_err(|_| "That clip is no longer in the cache.".to_string())
}

/// Run ffmpeg to the end, or say why it failed.
async fn ffmpeg_run(ffmpeg: &str, args: &[std::ffi::OsString], what: &str) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-v", "error", "-y"])
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    super::prepare_child(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(600), cmd.output())
        .await
        .map_err(|_| format!("{what} took too long"))?
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "{what} failed: {}",
            super::ffmpeg_error(&err, "ffmpeg failed")
        ));
    }
    Ok(())
}

/// The ffmpeg arguments that put `audio`'s sound under `video`'s picture,
/// as Opus, ending with the shorter of the two.
pub fn mux_args(video: &Path, audio: &Path, out: &Path, webm: bool) -> Vec<std::ffi::OsString> {
    let mut a: Vec<std::ffi::OsString> = vec!["-i".into(), video.into(), "-i".into(), audio.into()];
    for s in [
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "libopus",
        "-b:a",
        "96k",
        "-shortest",
        "-f",
    ] {
        a.push(s.into());
    }
    a.push(if webm { "webm" } else { "mp4" }.into());
    a.push(out.into());
    a
}

/// A generated clip with a sound from the audio cache under it, as a new
/// cache entry: a speaking clip (Wan2.2 S2V) with its speech, which plays
/// in the webview whatever sound, if any, the server put in the file.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn video_mux_audio(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    video_hash: String,
    audio_hash: String,
    title: Option<String>,
    conversation_id: Option<String>,
    code_session_id: Option<String>,
    overrides: BinaryOverrides,
) -> Result<crate::audio_cache::commands::StoredAudio, String> {
    let video = cached_clip(&app, &video_hash)?;
    let audio = cached_clip(&app, &audio_hash)?;
    let (mime, _) = crate::audio_cache::protocol::locate(&app, &video_hash)
        .map_err(|_| "That clip is no longer in the cache.".to_string())?;
    let webm = mime != "video/mp4";
    let found = binaries::resolve(&overrides).await;
    let ffmpeg = found.require(Tool::Ffmpeg)?;
    let dir = crate::audio_cache::cache_dir(&app)?;
    let temp = dir.join(crate::audio_cache::commands::temp_name());
    if let Err(e) = ffmpeg_run(
        ffmpeg,
        &mux_args(&video, &audio, &temp, webm),
        "Adding the sound",
    )
    .await
    {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    crate::audio_cache::commands::store_file(
        &db,
        &dir,
        &temp,
        if webm { "video/webm" } else { "video/mp4" },
        title,
        None,
        conversation_id.as_deref(),
        code_session_id.as_deref(),
    )
    .await
}

/// Take one full-size frame of a clip (the true last frame, the first, or one
/// at a time) as a PNG in the episode folder.
#[tauri::command]
pub async fn video_still_extract(
    app: tauri::AppHandle,
    working_dir: String,
    episode: String,
    request: StillRequest,
    settings: super::project::VideoSettings,
) -> Result<StillWritten, String> {
    use super::frames::{self, StillAt};
    use base64::Engine;
    let found = binaries::resolve(&settings.overrides).await;
    let ffmpeg = found.require(Tool::Ffmpeg)?.to_string();
    let (file, stem) = match (request.path.as_deref(), request.video_hash.as_deref()) {
        (Some(p), None) => {
            let f = paths::resolve_media(&working_dir, p, &settings.intro, &settings.outro)?;
            let stem = f
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("clip")
                .to_string();
            (f, stem)
        }
        (None, Some(h)) => (cached_clip(&app, h)?, format!("clip-{}", &h[..12])),
        _ => return Err("Give a clip's path or a generated clip, not both.".into()),
    };
    let (at, tag) = match (request.which.as_str(), request.at_secs) {
        ("last", None) => (StillAt::Last, "last".to_string()),
        ("first", None) => (StillAt::First, "first".to_string()),
        ("time", Some(t)) if t.is_finite() && t >= 0.0 => (StillAt::Secs(t), format!("t{t:.2}")),
        _ => return Err("Give at_secs with which = time, or which = first or last alone.".into()),
    };
    let episode_dir = paths::resolve_episode(&working_dir, &episode)?;
    let out = paths::still_target(
        &working_dir,
        &episode_dir,
        request.out.as_deref(),
        &format!("{stem}-{tag}.png"),
    )?;
    let (width, height) = frames::extract_still(&ffmpeg, &file, at, &out).await?;
    let jpeg = frames::preview_jpeg(&out, 960)?;
    Ok(StillWritten {
        path: paths::display_path(&working_dir, &out),
        width,
        height,
        preview_data_url: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(jpeg)
        ),
    })
}

/// A clip ready for a video upscaler: MJPEG AVI in the audio cache, and
/// what the upscaler checks it against.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleInput {
    /// The AVI's hash in the audio cache: what the upscale job is sent.
    pub hash: String,
    /// As shown, after any rotation the file asks for.
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub fps: f64,
    pub has_audio: bool,
    pub duration_secs: f64,
}

/// The ffmpeg arguments that turn `clip` into what llama-toolchest's video
/// upscalers read: MJPEG AVI with PCM sound, the sound only when there is
/// some. MP4, VP9 and ordinary VP8 are all refused there.
pub fn upscale_input_args(clip: &Path, out: &Path, rate: Option<u32>) -> Vec<std::ffi::OsString> {
    let mut a: Vec<std::ffi::OsString> = vec!["-i".into(), clip.into()];
    for s in ["-map", "0:v:0", "-map", "0:a:0?", "-fps_mode", "cfr"] {
        a.push(s.into());
    }
    // A variable-rate clip (a phone's, or one cut from others) leaves gaps
    // the AVI muxer fills with empty frames, which toolchest refuses; at a
    // constant rate ffmpeg repeats or drops a frame instead.
    if let Some(r) = rate {
        a.push("-r".into());
        a.push(r.to_string().into());
    }
    for s in [
        "-c:v",
        "mjpeg",
        "-q:v",
        "2",
        "-pix_fmt",
        "yuvj420p",
        "-c:a",
        "pcm_s16le",
        "-f",
        "avi",
    ] {
        a.push(s.into());
    }
    a.push(out.into());
    a
}

/// The whole-number rate a clip averaging `fps` is converted at, or None
/// when ffprobe gave none.
pub fn constant_rate(fps: f64) -> Option<u32> {
    (fps.is_finite() && fps > 0.0).then(|| (fps.round() as u32).max(1))
}

/// The frame count of a clip `secs` long at `fps`, at least one.
pub fn frame_count(secs: f64, fps: f64) -> u32 {
    if !(secs.is_finite() && fps.is_finite()) || secs <= 0.0 || fps <= 0.0 {
        return 1;
    }
    ((secs * fps).round() as u32).max(1)
}

/// A clip for `upscale_video`: a generated one by `hash`, or a file in the
/// working folder by `path`, converted to MJPEG AVI and kept in the audio
/// cache, linked to the chat or Code session, with its size and length.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn video_upscale_input(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    working_dir: Option<String>,
    path: Option<String>,
    hash: Option<String>,
    conversation_id: Option<String>,
    code_session_id: Option<String>,
    settings: super::project::VideoSettings,
) -> Result<UpscaleInput, String> {
    let (file, shown) = match (hash.as_deref(), path.as_deref()) {
        (Some(h), _) => (cached_clip(&app, h)?, "the clip".to_string()),
        (None, Some(p)) => {
            let dir = working_dir.ok_or("There is no working folder to read the clip from.")?;
            let file = crate::fs_tools::resolve_in_workdir(Path::new(&dir), p)?;
            if !file.is_file() {
                return Err(format!("No file named {} in the working folder.", p.trim()));
            }
            (file, p.trim().to_string())
        }
        (None, None) => return Err("Name a clip: its path or its haruspex-video:// URL.".into()),
    };
    let found = binaries::resolve(&settings.overrides).await;
    let ffprobe = found.require(Tool::Ffprobe)?.to_string();
    let ffmpeg = found.require(Tool::Ffmpeg)?.to_string();
    let info = probe::probe_file(&ffprobe, &file, shown.clone()).await?;
    let video = info
        .video
        .as_ref()
        .ok_or_else(|| format!("{shown} has no picture."))?;
    let rate = constant_rate(if video.fps_den > 0 {
        video.fps_num as f64 / video.fps_den as f64
    } else {
        0.0
    });
    let fps = rate.map_or(0.0, f64::from);
    // ffmpeg turns the picture upright as it converts.
    let (width, height) = if video.rotation.abs() % 180 == 90 {
        (video.height, video.width)
    } else {
        (video.width, video.height)
    };
    let dir = crate::audio_cache::cache_dir(&app)?;
    let temp = dir.join(crate::audio_cache::commands::temp_name());
    if let Err(e) = ffmpeg_run(
        &ffmpeg,
        &upscale_input_args(&file, &temp, rate),
        "Converting the clip",
    )
    .await
    {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    let stored = crate::audio_cache::commands::store_file(
        &db,
        &dir,
        &temp,
        "video/x-msvideo",
        None,
        None,
        conversation_id.as_deref(),
        code_session_id.as_deref(),
    )
    .await?;
    Ok(UpscaleInput {
        hash: stored.hash,
        width,
        height,
        frames: frame_count(info.duration_secs, fps),
        fps,
        has_audio: !info.audio.is_empty(),
        duration_secs: info.duration_secs,
    })
}

/// ffprobe a generated clip in the cache: its length, picture and sound.
#[tauri::command]
pub async fn video_probe_cached(
    app: tauri::AppHandle,
    hash: String,
    settings: super::project::VideoSettings,
) -> Result<probe::ClipInfo, String> {
    let found = binaries::resolve(&settings.overrides).await;
    let ffprobe = found.require(Tool::Ffprobe)?.to_string();
    let file = cached_clip(&app, &hash)?;
    probe::probe_file(&ffprobe, &file, hash).await
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
    let episode_dir = match super::project::default_project(working_dir, episode, project, None) {
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
            let stem = super::project::default_project(working_dir, episode, project, None)
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
        let _ = super::copy_file(&target, &backups.join(format!("{stem}-{stamp}.jpg")));
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
                super::project::default_project(&working_dir, &episode, project.as_deref(), None)?;
            let doc = super::format::ProjectDoc::open(&proj)?;
            let spans = doc.spans();
            let (span, at) = super::timeline::source_at(&spans, t)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{temp_dir, TestDir};
    use std::fs;
    use std::path::Path;

    /// Two slices joined last as long as both, and a 0.5 s pause is found.
    /// Needs ffmpeg on PATH.
    #[tokio::test]
    #[ignore = "needs ffmpeg"]
    async fn speech_slices_join_and_pauses_are_found() {
        let dir = temp_dir("audio_join");
        let wd = dir.to_string_lossy().into_owned();
        let make = |graph: &str, out: &str| {
            let ok = crate::test_util::host_command("ffmpeg")
                .args([
                    "-v", "error", "-y", "-f", "lavfi", "-i", graph, "-ar", "24000", "-ac", "1",
                ])
                .arg(dir.join(out))
                .status()
                .unwrap()
                .success();
            assert!(ok);
        };
        make("sine=f=300:d=4", "a.wav");
        // 1.5 s of tone, 0.5 s of quiet, 1.5 s of tone.
        make(
            "sine=f=300:d=3.5,volume='if(between(t,1.5,2),0,1)':eval=frame",
            "b.wav",
        );
        let slice = |p: &str, a: f64, b: f64| AudioSlice {
            path: p.into(),
            from_secs: a,
            to_secs: b,
        };
        let secs = audio_join(
            wd.clone(),
            vec![slice("a.wav", 0.5, 3.0), slice("b.wav", 0.0, 1.25)],
            "out/win.wav".into(),
            BinaryOverrides::default(),
        )
        .await
        .unwrap();
        assert!((secs - 3.75).abs() < 0.01, "{secs}");
        let gaps = audio_silences(wd, "b.wav".into(), 0.3, BinaryOverrides::default())
            .await
            .unwrap();
        assert_eq!(gaps.len(), 1, "{gaps:?}");
        assert!((gaps[0].start - 1.5).abs() < 0.05 && (gaps[0].end - 2.0).abs() < 0.05);
    }

    /// A silent WebM clip and a WAV muxed: one video and one Opus audio
    /// stream, as long as the shorter. Needs ffmpeg and ffprobe on PATH.
    #[tokio::test]
    #[ignore = "needs ffmpeg and ffprobe"]
    async fn muxing_puts_the_speech_under_the_clip() {
        let dir = temp_dir("mux_audio");
        let video = dir.join("clip.webm");
        let audio = dir.join("speech.wav");
        let make = |args: &[&str], out: &Path| {
            let ok = crate::test_util::host_command("ffmpeg")
                .args(["-v", "error", "-y"])
                .args(args)
                .arg(out)
                .status()
                .unwrap()
                .success();
            assert!(ok);
        };
        make(
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=320x240:r=16:d=3",
                "-c:v",
                "libvpx",
            ],
            &video,
        );
        make(&["-f", "lavfi", "-i", "sine=f=300:d=5"], &audio);
        let out = dir.join("out.webm");
        ffmpeg_run(
            "ffmpeg",
            &mux_args(&video, &audio, &out, true),
            "Adding the sound",
        )
        .await
        .unwrap();
        let info = probe::probe_file("ffprobe", &out, "out".into())
            .await
            .unwrap();
        assert!(info.video.is_some());
        assert_eq!(info.audio.len(), 1);
        assert_eq!(info.audio[0].codec, "opus");
        assert!(
            (info.duration_secs - 3.0).abs() < 0.15,
            "{}",
            info.duration_secs
        );
    }

    /// The still, the contact sheet and the speech mux on a real generated
    /// clip (ComfyUI's are AV1 WebM), with the ffmpeg the app would use:
    /// `HARUSPEX_FFMPEG=src-tauri/binaries/haruspex-ffmpeg-<triple>
    /// HARUSPEX_FFPROBE=… HARUSPEX_VIDEO_CLIP=clip.webm HARUSPEX_SPEECH=speech.wav
    /// cargo test -- --ignored generated_clip_stills_sheet_and_speech`
    #[tokio::test]
    #[ignore = "needs a clip, a WAV and the ffmpeg to test"]
    async fn generated_clip_stills_sheet_and_speech() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        let (ffmpeg, ffprobe) = (var("HARUSPEX_FFMPEG"), var("HARUSPEX_FFPROBE"));
        let clip = std::path::PathBuf::from(var("HARUSPEX_VIDEO_CLIP"));
        let speech = std::path::PathBuf::from(var("HARUSPEX_SPEECH"));
        let dir = temp_dir("generated_clip");

        let last = dir.join("last.png");
        let (w, h) = crate::video::frames::extract_still(
            &ffmpeg,
            &clip,
            crate::video::frames::StillAt::Last,
            &last,
        )
        .await
        .unwrap();
        assert!(w > 0 && h > 0);

        let info = probe::probe_file(&ffprobe, &clip, "clip".into())
            .await
            .unwrap();
        let mut pngs = Vec::new();
        for i in 0..4 {
            let at = info.duration_secs * i as f64 / 4.0;
            pngs.push(
                crate::video::frames::extract_frame(&ffmpeg, &clip, at, 960)
                    .await
                    .unwrap(),
            );
        }
        assert!(!crate::video::frames::contact_sheet(&pngs)
            .unwrap()
            .is_empty());

        let out = dir.join("spoken.webm");
        ffmpeg_run(
            &ffmpeg,
            &mux_args(&clip, &speech, &out, true),
            "Adding the sound",
        )
        .await
        .unwrap();
        let muxed = probe::probe_file(&ffprobe, &out, "out".into())
            .await
            .unwrap();
        assert!(muxed.video.is_some());
        assert_eq!(muxed.audio[0].codec, "opus");
    }
    use std::time::{Duration, SystemTime};

    #[test]
    fn crossfades_chain_one_input_into_the_next() {
        assert_eq!(
            crossfade_graph(3, 2.0),
            "[0:a][1:a]acrossfade=d=2.000:c1=tri:c2=tri[x1];[x1][2:a]acrossfade=d=2.000:c1=tri:c2=tri[out]"
        );
    }

    #[tokio::test]
    async fn two_sounds_join_into_one_a_crossfade_shorter() {
        // The setup calls ffmpeg and ffprobe from PATH, which the app's own
        // lookup can find elsewhere (the Windows runner has none on PATH).
        if !crate::test_util::host_has("ffmpeg")
            || !crate::test_util::host_has("ffprobe")
            || crate::video::binaries::resolve(&Default::default())
                .await
                .ffmpeg
                .is_none()
        {
            eprintln!("skipped: no ffmpeg");
            return;
        }
        let dir = temp_dir("audio_join");
        for (name, f) in [("a.wav", 220), ("b.wav", 440)] {
            let ok = crate::test_util::host_command("ffmpeg")
                .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
                .arg(format!("sine=f={f}:d=5"))
                .arg(dir.join(name))
                .status()
                .unwrap()
                .success();
            assert!(ok);
        }
        let wd = dir.to_string_lossy().into_owned();
        audio_crossfade_join(
            wd,
            vec!["a.wav".into(), "b.wav".into()],
            2.0,
            "music/bed.wav".into(),
            Default::default(),
        )
        .await
        .unwrap();
        let out = crate::test_util::host_command("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(dir.join("music/bed.wav"))
            .output()
            .unwrap();
        let secs: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        assert!((secs - 8.0).abs() < 0.05, "{secs}");
    }

    /// A sheet with a picture first, then the clip's frames, numbered on.
    #[tokio::test]
    async fn a_sheet_puts_pictures_before_the_frames() {
        // The setup calls ffmpeg and ffprobe from PATH, which the app's own
        // lookup can find elsewhere (the Windows runner has none on PATH).
        if !crate::test_util::host_has("ffmpeg")
            || !crate::test_util::host_has("ffprobe")
            || crate::video::binaries::resolve(&Default::default())
                .await
                .ffmpeg
                .is_none()
        {
            eprintln!("skipped: no ffmpeg");
            return;
        }
        let dir = temp_dir("video_frames_images");
        let ok = crate::test_util::host_command("ffmpeg")
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=s=320x180:r=24:d=2",
            ])
            .arg(dir.join("clip.mp4"))
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let png = image::RgbaImage::from_pixel(64, 36, image::Rgba([200, 30, 30, 255]));
        png.save(dir.join("key.png")).unwrap();
        let sheet = video_frames(
            dir.to_string_lossy().into_owned(),
            String::new(),
            FrameRequest {
                path: Some("clip.mp4".into()),
                times: Some(vec![0.0, 1.0]),
                every_secs: None,
                timeline_times: None,
                project: None,
                images: Some(vec![SheetImage {
                    path: "key.png".into(),
                    label: "the start image".into(),
                }]),
            },
            Default::default(),
        )
        .await
        .unwrap();
        let tiles: Vec<(u32, Option<&str>, &str)> = sheet
            .tiles
            .iter()
            .map(|t| (t.n, t.label.as_deref(), t.path.as_str()))
            .collect();
        assert_eq!(
            tiles,
            [
                (1, Some("the start image"), "key.png"),
                (2, None, "clip.mp4"),
                (3, None, "clip.mp4")
            ]
        );
        assert!(sheet.data_url.starts_with("data:image/jpeg;base64,"));
    }

    /// A working folder with episode `ep010` holding `cut.kdenlive`.
    fn episode() -> (TestDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = temp_dir("video_cmds");
        let ep = dir.join("ep010");
        fs::create_dir_all(ep.join("renders")).unwrap();
        let project = ep.join("cut.kdenlive");
        fs::write(&project, "").unwrap();
        (dir, ep, project)
    }

    #[tokio::test]
    async fn a_panicking_edit_answers_with_an_error() {
        let items: Vec<u32> = Vec::new();
        let n = items.len() + 1;
        let err = unpanicked(async move { Ok::<u32, String>(items[n]) })
            .await
            .unwrap_err();
        assert!(err.contains("index out of bounds"), "{err}");
        assert_eq!(unpanicked(async { Ok::<_, String>(7) }).await, Ok(7));
    }

    /// Write `path` with its modified time `secs` after `base`.
    fn touch(path: &Path, base: SystemTime, secs: u64) {
        fs::write(path, b"x").unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(base + Duration::from_secs(secs))
            .unwrap();
    }

    #[test]
    fn latest_render_is_the_newest_finished_mp4_named_for_the_project() {
        let (_dir, ep, project) = episode();
        let r = ep.join("renders");
        let base = SystemTime::now() - Duration::from_secs(3600);
        touch(&r.join("cut-1.mp4"), base, 10);
        touch(&r.join("cut-2.mp4"), base, 20);
        // Newer, but still rendering, another project's, or not a video.
        touch(&r.join("cut-3.part.mp4"), base, 30);
        touch(&r.join("other.mp4"), base, 40);
        touch(&r.join("cut-4.mov"), base, 50);
        assert_eq!(latest_render(&ep, &project), Some(r.join("cut-2.mp4")));

        // By modified time, not by name.
        touch(&r.join("cut-1.mp4"), base, 60);
        assert_eq!(latest_render(&ep, &project), Some(r.join("cut-1.mp4")));
    }

    #[test]
    fn latest_render_is_none_without_renders() {
        let (_dir, ep, project) = episode();
        assert_eq!(latest_render(&ep, &project), None);
        fs::remove_dir(ep.join("renders")).unwrap();
        assert_eq!(latest_render(&ep, &project), None);
    }

    #[test]
    fn captions_go_beside_a_named_render_inside_the_working_folder() {
        let (dir, ep, project) = episode();
        let wd = dir.to_string_lossy();
        let target =
            captions_target(&wd, &ep, &project, Some(" ep010/renders/final.mp4 ")).unwrap();
        assert_eq!(target, ep.join("renders/final.srt"));
    }

    #[test]
    fn captions_are_never_written_outside_the_working_folder() {
        let (dir, ep, project) = episode();
        let wd = dir.to_string_lossy();
        let outside = temp_dir("video_cmds_outside");
        let render = outside.join("final.mp4");
        fs::write(&render, b"x").unwrap();
        assert!(captions_target(&wd, &ep, &project, Some("../elsewhere/final.mp4")).is_err());
        assert!(captions_target(&wd, &ep, &project, Some(&render.to_string_lossy())).is_err());
        assert!(!outside.join("final.srt").exists());
    }

    #[test]
    fn captions_follow_the_newest_render_unless_the_cut_is_newer() {
        let (dir, ep, project) = episode();
        let wd = dir.to_string_lossy();
        let base = SystemTime::now() - Duration::from_secs(3600);
        touch(&project, base, 10);
        touch(&ep.join("renders/cut-1.mp4"), base, 20);
        assert_eq!(
            captions_target(&wd, &ep, &project, None).unwrap(),
            ep.join("renders/cut-1.srt")
        );
        // An empty name is no name.
        assert_eq!(
            captions_target(&wd, &ep, &project, Some("  ")).unwrap(),
            ep.join("renders/cut-1.srt")
        );

        // Edited since: the render no longer fits, so beside the project.
        touch(&project, base, 30);
        assert_eq!(
            captions_target(&wd, &ep, &project, None).unwrap(),
            ep.join("cut.srt")
        );
    }

    #[test]
    fn captions_fall_back_beside_the_project_without_a_render() {
        let (dir, ep, project) = episode();
        let wd = dir.to_string_lossy();
        assert_eq!(
            captions_target(&wd, &ep, &project, None).unwrap(),
            ep.join("cut.srt")
        );
    }

    fn chapter(title: &str, at_secs: f64) -> super::super::subtitles::Chapter {
        super::super::subtitles::Chapter {
            title: title.into(),
            at_secs,
        }
    }

    /// `ep010/cut.kdenlive` from the OBS fixture, and its length in seconds.
    fn fixture_episode() -> (TestDir, f64) {
        let (dir, _ep, project) = episode();
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src/video/kdenlive/fixtures/intro-plus-obs.kdenlive"),
            &project,
        )
        .unwrap();
        let doc = super::super::format::ProjectDoc::open(&project).unwrap();
        let total = doc.fps().secs(doc.sequence_end());
        assert!(total >= 40.0, "the fixture is only {total}s");
        (dir, total)
    }

    #[test]
    fn chapters_are_sorted_and_written_beside_the_project() {
        let (dir, total) = fixture_episode();
        let third = (total / 3.0).floor();
        let written = video_write_chapters(
            dir.to_string_lossy().into_owned(),
            "ep010".into(),
            None,
            vec![
                chapter("Outro", third * 2.0),
                chapter(" Intro ", 0.0),
                chapter("Middle", third),
            ],
        )
        .unwrap();
        assert_eq!(written.path, "ep010/cut.chapters.txt");
        let lines: Vec<&str> = written.text.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "0:00 Intro");
        assert!(lines[1].ends_with(" Middle"), "{lines:?}");
        assert!(lines[2].ends_with(" Outro"), "{lines:?}");
        assert_eq!(
            fs::read_to_string(dir.join("ep010/cut.chapters.txt")).unwrap(),
            written.text
        );
    }

    #[test]
    fn chapters_that_break_youtubes_rules_are_refused_and_not_written() {
        let (dir, _total) = fixture_episode();
        let err = video_write_chapters(
            dir.to_string_lossy().into_owned(),
            "ep010".into(),
            None,
            vec![chapter("Intro", 5.0), chapter("End", 20.0)],
        )
        .err()
        .unwrap();
        assert!(err.contains("at least 3 chapters"), "{err}");
        assert!(err.contains("must start at 0:00"), "{err}");
        assert!(!dir.join("ep010/cut.chapters.txt").exists());
    }
}

#[cfg(test)]
mod upscale_tests {
    use super::*;

    #[test]
    fn upscale_input_is_mjpeg_avi_with_optional_sound() {
        let args: Vec<String> =
            upscale_input_args(Path::new("in.mp4"), Path::new("out.tmp"), Some(16))
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
        let joined = args.join(" ");
        assert!(
            joined.contains("-fps_mode cfr -r 16 "),
            "a constant rate, so the AVI has no empty frames"
        );
        assert!(joined.starts_with("-i in.mp4 "));
        assert!(
            joined.contains("-map 0:a:0?"),
            "a clip without sound still converts"
        );
        assert!(joined.contains("-c:v mjpeg"));
        assert!(joined.contains("-c:a pcm_s16le"));
        assert!(joined.ends_with("-f avi out.tmp"));
    }

    #[test]
    fn a_clip_converts_at_a_whole_number_rate() {
        assert_eq!(constant_rate(15.5), Some(16));
        assert_eq!(constant_rate(30000.0 / 1001.0), Some(30));
        assert_eq!(constant_rate(0.2), Some(1));
        assert_eq!(constant_rate(0.0), None);
        assert_eq!(constant_rate(f64::NAN), None);
        let args = upscale_input_args(Path::new("in.mp4"), Path::new("out.tmp"), None);
        assert!(!args.iter().any(|a| a == "-r"), "no rate, no -r");
    }

    #[test]
    fn frame_count_rounds_and_never_is_zero() {
        assert_eq!(frame_count(5.0625, 16.0), 81);
        assert_eq!(frame_count(0.0, 24.0), 1);
        assert_eq!(frame_count(f64::NAN, 24.0), 1);
        assert_eq!(frame_count(2.0, 0.0), 1);
    }
}
