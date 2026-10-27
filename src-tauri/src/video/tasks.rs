//! Background video work: renders and uploads.
//!
//! A task starts and the tool returns at once. The task is a record in the
//! background-task registry (`crate::tasks`), which sends its progress out,
//! keeps how it ended, and holds the notice for the conversation that started
//! it. One render runs at a time: two would only share the CPU and both take
//! twice as long.
//!
//! A render's melt is recorded in the orphan registry while it runs, so a
//! crash's leftover is killed on the next launch, and every task is stopped
//! when the app exits.

use super::check::{self, RenderCheck};
use super::loudness::MAX_GAIN;
use super::project::VideoSettings;
use super::{binaries, encode, kdenlive, paths, project};
use crate::orphans::{self, RunningServer};
use crate::tasks::{BackgroundTask, BackgroundTasks, TaskFollower, TaskKind, TaskPatch, TaskState};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

/// The orphan registry kind for renders.
pub const ORPHAN_KIND: &str = "video";

/// Lines of melt's stderr kept for a failure report.
const LOG_TAIL: usize = 40;

/// Progress updates at most this often.
const EMIT_EVERY: Duration = Duration::from_millis(500);

/// A finished render, as its task's `result`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    /// Relative to the working folder.
    pub path: String,
    /// The same file, absolute: what Open and Show in folder use.
    pub abs_path: String,
    pub check: Option<RenderCheck>,
}

/// A finished upload, as its task's `result`. `problems` are what didn't
/// work (a thumbnail).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub url: String,
    pub studio_url: String,
    pub video_id: String,
    pub visibility: String,
    pub problems: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub working_dir: String,
    pub episode: String,
    pub project: Option<String>,
    pub owner: String,
    pub encoder: String,
    pub settings: VideoSettings,
}

/// Where a render's melt is recorded while it runs.
#[derive(Clone)]
pub struct VideoTasks {
    registry: Option<PathBuf>,
}

impl VideoTasks {
    pub fn new(registry: Option<PathBuf>) -> Self {
        VideoTasks { registry }
    }
}

/// How a task ended: its state and what goes with it.
struct Ending {
    state: TaskState,
    result: Option<serde_json::Value>,
    error: Option<String>,
    log_tail: Option<String>,
}

impl Ending {
    fn done<T: Serialize>(result: &T) -> Self {
        Ending {
            state: TaskState::Done,
            result: serde_json::to_value(result).ok(),
            error: None,
            log_tail: None,
        }
    }

    fn failed(message: String, log_tail: String) -> Self {
        Ending {
            state: TaskState::Failed,
            result: None,
            error: Some(message),
            log_tail: (!log_tail.is_empty()).then_some(log_tail),
        }
    }

    fn cancelled() -> Self {
        Ending {
            state: TaskState::Cancelled,
            result: None,
            error: None,
            log_tail: None,
        }
    }

    fn patch(self) -> TaskPatch {
        TaskPatch {
            state: Some(self.state),
            result: self.result,
            error: self.error,
            log_tail: self.log_tail,
            ..Default::default()
        }
    }
}

/// Record a progress figure; the registry sends it on.
fn progress(tasks: &BackgroundTasks, id: &str, pct: f64, started: Instant) {
    let _ = tasks.update(
        id,
        TaskPatch {
            percent: Some(pct),
            eta_secs: eta(started.elapsed(), pct),
            ..Default::default()
        },
    );
}

/// melt's `-progress` line: `Current Frame:   86, percentage:   94`.
pub fn parse_progress(line: &str) -> Option<(i64, f64)> {
    let frame = line
        .split("Current Frame:")
        .nth(1)?
        .split(',')
        .next()?
        .trim()
        .parse()
        .ok()?;
    let pct = line.split("percentage:").nth(1)?.trim().parse().ok()?;
    Some((frame, pct))
}

/// Seconds left, from how long the first `percent` took.
pub fn eta(elapsed: Duration, percent: f64) -> Option<f64> {
    (percent >= 1.0).then(|| elapsed.as_secs_f64() * (100.0 - percent) / percent)
}

/// `<episode>/renders/<project stem>-<yyyymmdd-HHMM>.mp4`, local time.
pub fn output_path(episode_dir: &Path, project: &Path) -> PathBuf {
    let stem = project
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M");
    let dir = episode_dir.join("renders");
    let mut path = dir.join(format!("{stem}-{stamp}.mp4"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{stamp}-{n}.mp4"));
        n += 1;
    }
    path
}

fn part_path(out: &Path) -> PathBuf {
    let name = out
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("render.mp4");
    out.with_file_name(format!("{}.part.mp4", name.trim_end_matches(".mp4")))
}

/// Start rendering a project in the background.
pub async fn start_render(
    tasks: BackgroundTasks,
    video: VideoTasks,
    req: RenderRequest,
) -> Result<BackgroundTask, String> {
    if let Some(id) = tasks.running(TaskKind::VideoRender) {
        return Err(format!(
            "A render is already running (id {id}). Wait for it or cancel it."
        ));
    }
    let found = binaries::resolve(&req.settings.overrides).await;
    let melt = found.require(binaries::Tool::Melt)?.to_string();
    let ffmpeg = found.require(binaries::Tool::Ffmpeg)?.to_string();
    let ffprobe = found.require(binaries::Tool::Ffprobe)?.to_string();
    let project_path = project::default_project(
        &req.working_dir,
        &req.episode,
        req.project.as_deref(),
        false,
    )?;
    let doc = kdenlive::open(&project_path)?;
    let frames = doc.sequence_end();
    if frames == 0 {
        return Err("The project is empty: there is nothing to render.".into());
    }
    let expected = doc.fps.secs(frames);
    // Clips whose gain is at its bound, so normalising can't raise them.
    let at_limit: Vec<String> = kdenlive::summary(&doc, &req.working_dir, &project_path)
        .items
        .into_iter()
        .filter(|i| i.gain_db.is_some_and(|g| g >= MAX_GAIN - 0.05))
        .map(|i| i.path)
        .collect();
    let fps = doc.fps.num as f64 / doc.fps.den as f64;
    let episode_dir = project::episode_home(&req.working_dir, &req.episode, &project_path)?;
    let out = output_path(&episode_dir, &project_path);
    std::fs::create_dir_all(out.parent().unwrap_or(&episode_dir))
        .map_err(|e| format!("can't make the renders folder: {e}"))?;
    let part = part_path(&out);
    let encoder = if req.encoder.trim().is_empty() {
        encode::SOFTWARE
    } else {
        req.encoder.trim()
    };

    let mut cmd = tokio::process::Command::new(&melt);
    cmd.arg("-progress")
        .arg(&project_path)
        .arg("-consumer")
        .arg(format!("avformat:{}", part.display()))
        .args(encode::consumer_args(encoder, doc.height, fps))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    super::prepare_child(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start melt: {e}"))?;
    let pid = child.id().unwrap_or(0);
    let name = project_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let task = tasks.create(
        TaskKind::VideoRender,
        &req.owner,
        &format!("Rendering {name}"),
        TaskFollower::Rust,
        serde_json::json!({ "workingDir": req.working_dir }),
    );
    let id = task.id.clone();
    // The part file is in melt's command line and nobody else's.
    orphans::register(
        video.registry.as_deref(),
        RunningServer {
            id: id.clone(),
            pid,
            started_at: crate::time_util::now_secs_u64(),
            program: part.to_string_lossy().into_owned(),
        },
    );
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    tasks.attach_cancel(&id, cancel_tx);

    let stderr = child.stderr.take();
    let worker = tasks.clone();
    let working_dir = req.working_dir.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
        let reader = {
            let (worker, id, tail) = (worker.clone(), id.clone(), tail.clone());
            async move {
                let Some(mut stderr) = stderr else { return };
                let mut buf = [0u8; 4096];
                let mut line = String::new();
                let mut last_emit = Instant::now() - EMIT_EVERY;
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    for ch in String::from_utf8_lossy(&buf[..n]).chars() {
                        if ch != '\r' && ch != '\n' {
                            line.push(ch);
                            continue;
                        }
                        if let Some((_, pct)) = parse_progress(&line) {
                            if last_emit.elapsed() >= EMIT_EVERY {
                                last_emit = Instant::now();
                                progress(&worker, &id, pct, started);
                            }
                        } else if !line.trim().is_empty() && !line.contains("mlt_repository") {
                            if let Ok(mut t) = tail.lock() {
                                t.push_back(line.clone());
                                while t.len() > LOG_TAIL {
                                    t.pop_front();
                                }
                            }
                        }
                        line.clear();
                    }
                }
            }
        };
        let outcome = tokio::select! {
            status = async { reader.await; child.wait().await } => Some(status),
            _ = &mut cancel_rx => None,
        };
        let ending = match outcome {
            None => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                Ending::cancelled()
            }
            Some(Ok(status)) if status.success() && part.exists() => {
                match std::fs::rename(&part, &out) {
                    Ok(()) => {
                        let check = check::check(&ffprobe, &ffmpeg, &out, expected, &at_limit)
                            .await
                            .ok();
                        Ending::done(&RenderResult {
                            path: paths::display_path(&working_dir, &out),
                            abs_path: out.to_string_lossy().into_owned(),
                            check,
                        })
                    }
                    Err(e) => {
                        Ending::failed(format!("could not save the render: {e}"), String::new())
                    }
                }
            }
            Some(result) => {
                let log_tail = tail
                    .lock()
                    .map(|t| t.iter().cloned().collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default();
                let message = match result {
                    Ok(status) => format!("melt stopped with {status}"),
                    Err(e) => format!("melt failed: {e}"),
                };
                Ending::failed(message, log_tail)
            }
        };
        if ending.state != TaskState::Done {
            let _ = std::fs::remove_file(&part);
        }
        orphans::deregister_pid(video.registry.as_deref(), &id, pid);
        let _ = worker.update(&id, ending.patch());
    });
    Ok(task)
}

#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    pub working_dir: String,
    pub owner: String,
    /// The render, relative to the working folder.
    pub render: String,
    /// A thumbnail JPEG, relative to the working folder.
    pub thumbnail: Option<String>,
    pub meta: super::youtube::VideoMeta,
    pub proxy: Option<crate::proxy::ProxyConfig>,
}

/// Start uploading a render the user confirmed.
pub async fn start_upload(
    tasks: BackgroundTasks,
    req: UploadRequest,
) -> Result<BackgroundTask, String> {
    use super::youtube;
    if let Some(id) = tasks.running(TaskKind::YoutubeUpload) {
        return Err(format!(
            "An upload is already running (id {id}). Wait for it or cancel it."
        ));
    }
    let problems = youtube::check_meta(&req.meta);
    if !problems.is_empty() {
        return Err(problems.join(" "));
    }
    let file = paths::resolve_in_working(&req.working_dir, &req.render)?;
    if !file.is_file() || file.extension().is_none_or(|e| e != "mp4") {
        return Err(format!(
            "{} is not a rendered MP4 in the working folder.",
            req.render
        ));
    }
    let thumbnail = match req
        .thumbnail
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Some(t) => Some(
            std::fs::read(paths::resolve_in_working(&req.working_dir, t)?)
                .map_err(|e| format!("can't read the thumbnail: {e}"))?,
        ),
        None => None,
    };
    let refresh = crate::secrets::get(youtube::REFRESH_KEY)
        .await?
        .ok_or("Sign in to YouTube in Settings → Video editing first.")?;
    let auth = youtube::account_auth(refresh, req.proxy.clone());
    let http = crate::proxy::apply_proxy(
        reqwest::Client::builder().timeout(Duration::from_secs(10 * 60)),
        req.proxy.as_ref(),
    )?
    .build()
    .map_err(|e| format!("could not create an HTTP client: {e}"))?;
    let name = file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video")
        .to_string();
    let task = tasks.create(
        TaskKind::YoutubeUpload,
        &req.owner,
        &format!("Uploading {name} to YouTube"),
        TaskFollower::Rust,
        serde_json::json!({ "workingDir": req.working_dir }),
    );
    let id = task.id.clone();
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    tasks.attach_cancel(&id, cancel_tx);
    let worker = tasks.clone();
    let meta = req.meta.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let ep = youtube::Endpoints::default();
        let progress = {
            let (worker, id) = (worker.clone(), id.clone());
            let last = Mutex::new(Instant::now() - EMIT_EVERY);
            move |sent: u64, total: u64| {
                let pct = if total > 0 {
                    sent as f64 * 100.0 / total as f64
                } else {
                    0.0
                };
                let mut l = last.lock().unwrap_or_else(|e| e.into_inner());
                if l.elapsed() < EMIT_EVERY && sent < total {
                    return;
                }
                *l = Instant::now();
                progress(&worker, &id, pct, started);
            }
        };
        let never = || false;
        let ending = tokio::select! {
            r = youtube::upload(&http, &ep, &auth, &file, &meta, &never, &progress) => match r {
                Ok(video_id) => {
                    let mut problems = Vec::new();
                    if let Some(jpeg) = thumbnail {
                        if let Err(e) = youtube::set_thumbnail(&http, &ep, &auth, &video_id, jpeg).await {
                            problems.push(e);
                        }
                    }
                    Ending::done(&UploadResult {
                        url: format!("https://youtu.be/{video_id}"),
                        studio_url: format!("https://studio.youtube.com/video/{video_id}/edit"),
                        visibility: meta.visibility.api().into(),
                        video_id,
                        problems,
                    })
                }
                Err(message) => Ending::failed(message, String::new()),
            },
            _ = &mut cancel_rx => Ending::cancelled(),
        };
        let _ = worker.update(&id, ending.patch());
    });
    Ok(task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    #[test]
    fn progress_lines_parse() {
        assert_eq!(
            parse_progress("Current Frame:         86, percentage:         94"),
            Some((86, 94.0))
        );
        assert_eq!(parse_progress("mlt_repository_init: failed"), None);
    }

    #[test]
    fn eta_scales_from_elapsed() {
        assert_eq!(eta(Duration::from_secs(10), 25.0), Some(30.0));
        assert_eq!(eta(Duration::from_secs(10), 0.0), None);
    }

    #[test]
    fn outputs_never_clobber_and_parts_are_beside_them() {
        let dir = temp_dir("render_out");
        let p = output_path(&dir, Path::new("/x/ep012.kdenlive"));
        let name = p.file_name().unwrap().to_str().unwrap().to_string();
        assert!(
            name.starts_with("ep012-") && name.ends_with(".mp4"),
            "{name}"
        );
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"x").unwrap();
        let q = output_path(&dir, Path::new("/x/ep012.kdenlive"));
        assert_ne!(p, q);
        assert!(part_path(&p).to_str().unwrap().ends_with(".part.mp4"));
    }

    /// A real render of a generated project, through the task.
    #[tokio::test]
    #[ignore = "needs ffmpeg, ffprobe and melt"]
    async fn render_a_real_project() {
        let dir = temp_dir("render_real");
        std::fs::create_dir_all(dir.join("ep1")).unwrap();
        let ok = crate::test_util::host_command("ffmpeg")
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=s=640x360:r=30:d=4",
                "-f",
                "lavfi",
                "-i",
                "sine=d=4",
                "-shortest",
            ])
            .arg(dir.join("ep1/a.mp4"))
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let wd = dir.to_string_lossy().into_owned();
        let settings = VideoSettings {
            preset: "1080p30".into(),
            ..Default::default()
        };
        let spec = project::CutSpec {
            items: vec![project::CutItemSpec {
                path: Some("ep1/a.mp4".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        project::cut(&wd, "ep1", spec, &settings).await.unwrap();
        let seen = Arc::new(Mutex::new(Vec::<BackgroundTask>::new()));
        let sink = seen.clone();
        let tasks = BackgroundTasks::new(
            None,
            Arc::new(move |t| sink.lock().unwrap().push(t.clone())),
            Arc::new(|_| {}),
        );
        let video = VideoTasks::new(None);
        let req = RenderRequest {
            working_dir: wd.clone(),
            episode: "ep1".into(),
            project: None,
            owner: "chat:test".into(),
            encoder: String::new(),
            settings,
        };
        let started = start_render(tasks.clone(), video.clone(), req.clone())
            .await
            .unwrap();
        assert!(start_render(tasks.clone(), video, req)
            .await
            .unwrap_err()
            .contains("already running"));
        let done = loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let t = tasks.get(&started.id).unwrap();
            if t.state != TaskState::Running {
                break t;
            }
        };
        assert_eq!(done.state, TaskState::Done, "{:?}", done.error);
        let result: RenderResult = serde_json::from_value(done.result.unwrap()).unwrap();
        assert!(
            result.path.starts_with("ep1/renders/ep1-"),
            "{}",
            result.path
        );
        let check = result.check.as_ref().unwrap();
        assert!((check.duration_secs - 4.0).abs() < 0.2, "{check:?}");
        assert_eq!((check.width, check.height), (1920, 1080));
        assert!(check.has_audio);
        println!("{check:#?}");
        assert!(seen
            .lock()
            .unwrap()
            .iter()
            .any(|t| t.state == TaskState::Running));
    }

    #[test]
    fn results_serialise_camel_case() {
        let v = serde_json::to_value(RenderResult {
            path: "ep1/renders/a.mp4".into(),
            abs_path: "/v/ep1/renders/a.mp4".into(),
            check: None,
        })
        .unwrap();
        assert_eq!(v["absPath"], "/v/ep1/renders/a.mp4");
        let v = serde_json::to_value(UploadResult {
            url: "u".into(),
            studio_url: "s".into(),
            video_id: "i".into(),
            visibility: "private".into(),
            problems: vec![],
        })
        .unwrap();
        assert_eq!(v["studioUrl"], "s");
    }
}
