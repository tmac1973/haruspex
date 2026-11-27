//! Background video work: renders.
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
use super::format::ProjectDoc;
use super::loudness::MAX_GAIN;
use super::project::VideoSettings;
use super::{binaries, encode, paths, project};
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
    let project_path =
        project::default_project(&req.working_dir, &req.episode, req.project.as_deref(), None)?;
    let doc = ProjectDoc::open(&project_path)?;
    let frames = doc.sequence_end();
    if frames == 0 {
        return Err("The project is empty: there is nothing to render.".into());
    }
    let expected = doc.fps().secs(frames);
    // Every sound the project plays: the main track's clips with sound and
    // the audio tracks under the picture.
    let summary = doc.summary(&req.working_dir, &project_path);
    let sounds: Vec<(Option<f64>, &String)> = summary
        .items
        .iter()
        .filter(|i| i.has_audio)
        .map(|i| (i.gain_db, &i.path))
        .chain(summary.audio.iter().map(|a| (a.gain_db, &a.path)))
        .collect();
    let gains = check::Gains {
        // Clips whose gain is at its bound, so normalising can't raise them.
        at_limit: sounds
            .iter()
            .filter(|(g, _)| g.is_some_and(|g| g >= MAX_GAIN - 0.05))
            .map(|(_, p)| (*p).clone())
            .collect(),
        normalized: !sounds.is_empty() && sounds.iter().all(|(g, _)| g.is_some()),
    };
    let fps = doc.fps().num as f64 / doc.fps().den as f64;
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
        .args(encode::consumer_args(encoder, doc.height(), fps))
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
            owner: None,
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
                        let check = check::check(&ffprobe, &ffmpeg, &out, expected, &gains)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;
    use crate::video::format::Format;

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

    /// A real render of a project each editor's format, through the task: two
    /// clips with a crossfade and evened-out sound. Runs wherever melt is
    /// found (the media bundle, after `./scripts/fetch-media.sh`), and is
    /// skipped elsewhere.
    #[tokio::test]
    async fn render_real_projects_in_both_editors() {
        let found = binaries::resolve(&Default::default()).await;
        if found.melt.is_none() || found.ffmpeg.is_none() || found.ffprobe.is_none() {
            eprintln!("skipped: needs ffmpeg, ffprobe and melt");
            return;
        }
        let ffmpeg = found.ffmpeg.unwrap().path;
        for editor in [Format::Shotcut, Format::Kdenlive] {
            let dir = temp_dir(&format!("render_real_{}", editor.extension()));
            std::fs::create_dir_all(dir.join("ep1")).unwrap();
            for (name, src) in [("a.mp4", "testsrc"), ("b.mp4", "smptebars")] {
                let mut cmd = tokio::process::Command::new(&ffmpeg);
                cmd.args(["-v", "error", "-y", "-f", "lavfi", "-i"])
                    .arg(format!("{src}=s=640x360:r=30:d=4"))
                    .args(["-f", "lavfi", "-i", "sine=d=4", "-shortest"])
                    .args(["-c:v", "libx264", "-c:a", "aac"])
                    .arg(dir.join("ep1").join(name));
                crate::video::prepare_child(&mut cmd);
                assert!(cmd.status().await.unwrap().success());
            }
            let wd = dir.to_string_lossy().into_owned();
            let settings = VideoSettings {
                preset: "1080p30".into(),
                editor,
                ..Default::default()
            };
            let spec = project::CutSpec {
                items: ["ep1/a.mp4", "ep1/b.mp4"]
                    .iter()
                    .map(|p| project::CutItemSpec {
                        path: Some(p.to_string()),
                        ..Default::default()
                    })
                    .collect(),
                crossfade_secs: Some(1.0),
                ..Default::default()
            };
            let cut = project::cut(&wd, "ep1", spec, &settings).await.unwrap();
            assert_eq!(cut.summary.editor, editor);
            assert!(cut.summary.project.ends_with(editor.extension()));
            assert_eq!(cut.summary.mixes, 1);
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
                settings: settings.clone(),
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
            assert_eq!(done.state, TaskState::Done, "{editor:?}: {:?}", done.error);
            let result: RenderResult = serde_json::from_value(done.result.unwrap()).unwrap();
            assert!(
                result.path.starts_with("ep1/renders/ep1-"),
                "{}",
                result.path
            );
            let check = result.check.as_ref().unwrap();
            // Two 4 s clips overlapping by 1 s.
            assert!(
                (check.duration_secs - 7.0).abs() < 0.2,
                "{editor:?}: {check:?}"
            );
            assert_eq!((check.width, check.height), (1920, 1080));
            assert!(check.has_audio, "{editor:?}");
            println!("{editor:?}: {check:#?}");
            assert!(seen
                .lock()
                .unwrap()
                .iter()
                .any(|t| t.state == TaskState::Running));
        }
    }

    /// A voiceover on the audio track renders under the picture, starting
    /// where it was put, in each editor's format; in Shotcut a music bed
    /// under it gets a second audio track. Skipped without melt, as above.
    #[tokio::test]
    async fn render_a_voiceover_under_the_picture_in_both_editors() {
        let found = binaries::resolve(&Default::default()).await;
        if found.melt.is_none() || found.ffmpeg.is_none() || found.ffprobe.is_none() {
            eprintln!("skipped: needs ffmpeg, ffprobe and melt");
            return;
        }
        let ffmpeg = found.ffmpeg.unwrap().path;
        let make = |args: Vec<String>| {
            let ffmpeg = ffmpeg.clone();
            async move {
                let mut cmd = tokio::process::Command::new(&ffmpeg);
                cmd.args(["-v", "error", "-y"]).args(args);
                crate::video::prepare_child(&mut cmd);
                assert!(cmd.status().await.unwrap().success());
            }
        };
        for editor in [Format::Shotcut, Format::Kdenlive] {
            let dir = temp_dir(&format!("render_voiceover_{}", editor.extension()));
            let ep = dir.join("ep1");
            std::fs::create_dir_all(&ep).unwrap();
            // Two silent 4 s clips, a 2 s "voice" and an 8 s "bed".
            for (name, src) in [("a.mp4", "testsrc"), ("b.mp4", "smptebars")] {
                make(vec![
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    format!("{src}=s=640x360:r=30:d=4"),
                    "-c:v".into(),
                    "libx264".into(),
                    ep.join(name).to_string_lossy().into_owned(),
                ])
                .await;
            }
            for (name, f, d) in [("voice.wav", 440, 2), ("bed.wav", 220, 8)] {
                make(vec![
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    format!("sine=f={f}:d={d}"),
                    "-ac".into(),
                    "2".into(),
                    ep.join(name).to_string_lossy().into_owned(),
                ])
                .await;
            }
            let wd = dir.to_string_lossy().into_owned();
            let settings = VideoSettings {
                preset: "1080p30".into(),
                editor,
                ..Default::default()
            };
            let spec = project::CutSpec {
                items: ["ep1/a.mp4", "ep1/b.mp4"]
                    .iter()
                    .map(|p| project::CutItemSpec {
                        path: Some(p.to_string()),
                        ..Default::default()
                    })
                    .collect(),
                audio: Some(vec![project::CutAudioSpec {
                    path: Some("ep1/voice.wav".into()),
                    at_secs: Some(3.0),
                    ..Default::default()
                }]),
                ..Default::default()
            };
            let cut = project::cut(&wd, "ep1", spec, &settings).await.unwrap();
            assert_eq!(cut.summary.audio.len(), 1, "{editor:?}");
            let voice = &cut.summary.audio[0];
            assert!((voice.start_secs - 3.0).abs() < 0.05, "{voice:?}");
            assert!(voice.gain_db.is_some(), "{voice:?}");
            assert!(
                (cut.summary.total_secs - 8.0).abs() < 0.05,
                "{editor:?}: {}",
                cut.summary.total_secs
            );
            let render = render_now(&wd, &settings).await;
            let check = render.check.as_ref().unwrap();
            assert!((check.duration_secs - 8.0).abs() < 0.2, "{check:?}");
            assert!(check.has_audio);
            // Silence until 3 s, the voice to 5 s, silence after.
            let file = dir.join(&render.path);
            let quiet = crate::video::silence::detect(&ffmpeg, &file, -40.0, 0.5, None)
                .await
                .unwrap();
            println!("{editor:?}: {quiet:?}");
            assert_eq!(quiet.len(), 2, "{editor:?}: {quiet:?}");
            assert!(
                quiet[0].start < 0.1 && (quiet[0].end - 3.0).abs() < 0.15,
                "{quiet:?}"
            );
            assert!((quiet[1].start - 5.0).abs() < 0.15, "{quiet:?}");

            if editor == Format::Shotcut {
                // A bed under the voice from the start: a second audio track.
                let spec = project::CutSpec {
                    items: vec![
                        project::CutItemSpec {
                            index: Some(1),
                            ..Default::default()
                        },
                        project::CutItemSpec {
                            index: Some(2),
                            ..Default::default()
                        },
                    ],
                    audio: Some(vec![
                        project::CutAudioSpec {
                            index: Some(1),
                            at_secs: Some(3.0),
                            ..Default::default()
                        },
                        project::CutAudioSpec {
                            path: Some("ep1/bed.wav".into()),
                            lufs: Some(-30.0),
                            ..Default::default()
                        },
                    ]),
                    ..Default::default()
                };
                let cut = project::cut(&wd, "ep1", spec, &settings).await.unwrap();
                let tracks: Vec<(&str, &str)> = cut
                    .summary
                    .audio
                    .iter()
                    .map(|a| (a.track.as_str(), a.path.as_str()))
                    .collect();
                assert_eq!(tracks, [("A2", "ep1/bed.wav"), ("A1", "ep1/voice.wav")]);
                assert_eq!(cut.summary.audio[0].lufs, Some(-30.0));
                let render = render_now(&wd, &settings).await;
                let file = dir.join(&render.path);
                let quiet = crate::video::silence::detect(&ffmpeg, &file, -50.0, 0.5, None)
                    .await
                    .unwrap();
                assert!(quiet.is_empty(), "the bed plays throughout: {quiet:?}");
                let l = render.check.unwrap().loudness.unwrap();
                println!("with the bed: {l:?}");
            }
        }
    }

    /// Render the episode's project and wait for it.
    async fn render_now(wd: &str, settings: &VideoSettings) -> RenderResult {
        let tasks = BackgroundTasks::new(None, Arc::new(|_| {}), Arc::new(|_| {}));
        let req = RenderRequest {
            working_dir: wd.to_string(),
            episode: "ep1".into(),
            project: None,
            owner: "chat:test".into(),
            encoder: String::new(),
            settings: settings.clone(),
        };
        let started = start_render(tasks.clone(), VideoTasks::new(None), req)
            .await
            .unwrap();
        let done = loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let t = tasks.get(&started.id).unwrap();
            if t.state != TaskState::Running {
                break t;
            }
        };
        assert_eq!(done.state, TaskState::Done, "{:?}", done.error);
        serde_json::from_value(done.result.unwrap()).unwrap()
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
    }
}
