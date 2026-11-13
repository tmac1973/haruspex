//! The ambient watcher: one task per camera that reads the camera's small
//! stream through ffmpeg, opens an event on motion or sound (see `detect`),
//! records it, and when it closes transcribes it and logs it with a thumbnail
//! (`db::camera_events`). Nothing here uses the model; captions come later.
//!
//! A network camera's watcher reads the substream (or the main stream if it
//! has none) and, while an event is open, records the main stream's sound and
//! one full picture with a second ffmpeg. A webcam can't be opened twice, so
//! its watcher's one ffmpeg also writes the shared files (`shared`) and an
//! event is cut from those.
//!
//! [`WatcherRegistry`] starts and stops the watchers from the cameras'
//! settings and active hours, checking every 30 seconds, and deletes events
//! past the retention window. Watchers run only while the app is open.

use super::capture::{self, Platform};
use super::detect::{self, Closed, Detector, Reading, Step, Timings, Trigger};
use super::{shared, ActiveHours, CameraConfig, CameraSource, Credentials};
use crate::db::{Database, NewCameraEvent};
use crate::video::binaries::{resolve_tool, BinaryOverrides, Tool};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::{mpsc, watch};

/// How often the schedule is checked.
const TICK: Duration = Duration::from_secs(30);
/// How often old events are deleted, after the first time.
const PURGE_EVERY: Duration = Duration::from_secs(3600);
/// The first wait before a failed ffmpeg is restarted, and the longest.
const BACKOFF_MIN: Duration = Duration::from_secs(2);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A run this long was healthy, so the next failure waits the least again.
const HEALTHY_RUN: Duration = Duration::from_secs(60);
/// How often an open event is checked for quiet.
const CHECK_EVERY: Duration = Duration::from_millis(500);
/// The thumbnail is taken this long into an event.
const THUMB_AFTER_MS: i64 = 1_000;
/// The widest an event's thumbnail is kept.
pub(crate) const THUMB_WIDTH: u32 = 640;
/// The longest an event recorder runs, a little past an event's maximum.
const RECORD_MAX_SECS: u32 = 75;
/// How long a recorder has to finish its files after `q`.
const RECORDER_STOP: Duration = Duration::from_secs(5);
/// The most of ffmpeg's errors kept, from the end.
const STDERR_TAIL: usize = 4096;

/// Where a watcher reads from.
#[derive(Clone)]
pub(crate) enum Input {
    /// A network camera: `watch` is the stream the watcher reads, `record` the
    /// one an event is recorded from, both with credentials in.
    Rtsp { watch: String, record: String },
    /// A webcam, and its microphone if it has one.
    Usb {
        video: String,
        audio: Option<String>,
    },
    /// A lavfi graph with a picture and sound (`[out0]`, `[out1]`), read as a
    /// network camera is.
    #[cfg(test)]
    Lavfi(String),
    /// The same, read as a webcam is.
    #[cfg(test)]
    LavfiShared(String),
}

impl Input {
    /// The camera's input, and its credentials to blank out of errors.
    pub async fn for_camera(cfg: &CameraConfig) -> Result<(Input, Credentials), String> {
        let creds = Credentials::for_source(&cfg.source).await?;
        let input = match &cfg.source {
            CameraSource::Rtsp {
                url, substream_url, ..
            } => {
                let watch = substream_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|u| !u.is_empty())
                    .unwrap_or(url);
                Input::Rtsp {
                    watch: creds.inject(watch),
                    record: creds.inject(url),
                }
            }
            CameraSource::Usb {
                video_device,
                audio_device,
            } => Input::Usb {
                video: video_device.clone(),
                audio: audio_device
                    .as_deref()
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                    .map(str::to_string),
            },
        };
        Ok((input, creds))
    }

    /// Whether the watcher writes the shared files, being the only reader.
    fn shared(&self) -> bool {
        match self {
            Input::Usb { .. } => true,
            Input::Rtsp { .. } => false,
            #[cfg(test)]
            Input::Lavfi(_) => false,
            #[cfg(test)]
            Input::LavfiShared(_) => true,
        }
    }

    /// Whether this input could have sound at all.
    fn may_have_audio(&self) -> bool {
        match self {
            Input::Usb { audio, .. } => audio.is_some(),
            _ => true,
        }
    }

    /// ffmpeg's input options, and the picture's and sound's stream labels.
    fn args(&self) -> (Vec<String>, &'static str, &'static str) {
        match self {
            Input::Rtsp { watch, .. } => (capture::rtsp_input(watch), "0:v:0", "0:a:0"),
            Input::Usb { video, audio } => {
                let mut args = capture::usb_video_input(Platform::current(), video);
                if let Some(audio) = audio {
                    args.extend(capture::usb_audio_input(Platform::current(), audio));
                }
                (args, "0:v:0", "1:a:0")
            }
            #[cfg(test)]
            Input::Lavfi(graph) | Input::LavfiShared(graph) => {
                (lavfi_input(graph), "0:v:0", "0:a:0")
            }
        }
    }

    /// The input options an event is recorded from, for a camera that can be
    /// opened again; `None` for a webcam.
    fn record_args(&self) -> Option<Vec<String>> {
        match self {
            Input::Rtsp { record, .. } => Some(capture::rtsp_input(record)),
            Input::Usb { .. } => None,
            #[cfg(test)]
            Input::Lavfi(graph) => Some(lavfi_input(graph)),
            #[cfg(test)]
            Input::LavfiShared(_) => None,
        }
    }
}

#[cfg(test)]
fn lavfi_input(graph: &str) -> Vec<String> {
    strings(&["-f", "lavfi", "-i", graph])
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

/// The watcher's ffmpeg options: scene scores and sound levels to stdout as
/// metadata lines and, for a webcam, the shared files into `dir`.
pub(crate) fn watch_args(input: &Input, audio: bool, scene: f64, dir: &Path) -> Vec<String> {
    let (mut args, v, a) = input.args();
    args.splice(0..0, strings(&["-nostdin", "-y"]));
    let shared = input.shared();
    let audio = audio && input.may_have_audio();
    let motion =
        format!("fps=2,scale=320:-2,select='gt(scene,{scene})',metadata=print:file=-:direct=1[mv]");
    let mut graph = if shared {
        format!("[{v}]split=2[wv][jv];[jv]fps=1[jp];[wv]{motion}")
    } else {
        format!("[{v}]{motion}")
    };
    if audio {
        let level = format!(
            "asetnsamples=n={}:p=0,astats=metadata=1:reset=1,\
             ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-:direct=1[ma]",
            detect::LEVEL_FRAME_SAMPLES
        );
        let mono = "aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono";
        if shared {
            graph.push_str(&format!(";[{a}]{mono},asplit=2[la][aw];[la]{level}"));
        } else {
            graph.push_str(&format!(";[{a}]{mono},{level}"));
        }
    }
    args.extend(strings(&["-filter_complex", &graph]));
    args.extend(strings(&["-map", "[mv]", "-f", "null", "-"]));
    if audio {
        args.extend(strings(&["-map", "[ma]", "-f", "null", "-"]));
    }
    if shared {
        let latest = dir.join(shared::LATEST);
        args.extend(strings(&["-map", "[jp]", "-q:v", "3", "-update", "1"]));
        args.extend(strings(&["-f", "image2", &latest.to_string_lossy()]));
        if audio {
            let segments = dir.join(shared::SEGMENT_PATTERN);
            args.extend(strings(&[
                "-map",
                "[aw]",
                "-c:a",
                "pcm_s16le",
                "-f",
                "segment",
                "-segment_time",
                &shared::SEGMENT_SECS.to_string(),
                "-segment_format",
                "wav",
                "-segment_wrap",
                &shared::SEGMENT_WRAP.to_string(),
                &segments.to_string_lossy(),
            ]));
        }
    }
    args
}

/// The event recorder's ffmpeg options: up to [`RECORD_MAX_SECS`] of sound
/// to `wav` and one full picture a second in to `jpg`.
pub(crate) fn record_args(input: Vec<String>, audio: bool, wav: &Path, jpg: &Path) -> Vec<String> {
    // No -nostdin: `q` on stdin is how it is stopped.
    let mut args = strings(&["-y"]);
    args.extend(input);
    if audio {
        args.extend(strings(&[
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-t",
            &RECORD_MAX_SECS.to_string(),
            &wav.to_string_lossy(),
        ]));
    }
    args.extend(strings(&[
        "-map",
        "0:v:0",
        "-ss",
        "1",
        "-frames:v",
        "1",
        "-q:v",
        "3",
        "-update",
        "1",
        &jpg.to_string_lossy(),
    ]));
    args
}

/// An event that has closed, with what was recorded of it.
pub(crate) struct ClosedEvent {
    pub camera_id: String,
    pub closed: Closed,
    /// 16 kHz mono WAV, when there was sound to record.
    pub wav: Option<Vec<u8>>,
    pub jpeg: Option<Vec<u8>>,
}

/// What one watcher needs to run.
#[derive(Clone)]
pub(crate) struct WatchSpec {
    pub camera_id: String,
    pub input: Input,
    pub creds: Arc<Credentials>,
    /// The camera's working folder: shared files and event recordings.
    pub dir: PathBuf,
    pub scene: f64,
    pub threshold_db: f64,
    pub timings: Timings,
}

/// What records an open event.
enum Recorder {
    Idle,
    /// A second ffmpeg on a network camera.
    Child {
        child: tokio::process::Child,
        wav: PathBuf,
        jpg: PathBuf,
    },
    /// A webcam's shared files, from `since`; the picture once taken.
    Shared {
        since: SystemTime,
        jpeg: Option<Vec<u8>>,
        tried: bool,
    },
}

/// Start ffmpeg: the watcher with its output piped, or a recorder that is
/// stopped by typing `q` (killed, it may leave its WAV empty).
fn spawn_ffmpeg(
    ffmpeg: &str,
    args: &[String],
    recorder: bool,
) -> Result<tokio::process::Child, String> {
    use std::process::Stdio;
    let mut cmd = tokio::process::Command::new(ffmpeg);
    let (stdin, out, err) = if recorder {
        (Stdio::piped(), Stdio::null(), Stdio::null())
    } else {
        (Stdio::null(), Stdio::piped(), Stdio::piped())
    };
    cmd.args(["-hide_banner", "-v", "error"])
        .args(args)
        .stdin(stdin)
        .stdout(out)
        .stderr(err)
        .kill_on_drop(true);
    crate::video::prepare_child(&mut cmd);
    cmd.spawn()
        .map_err(|e| format!("could not run {ffmpeg}: {e}"))
}

impl Recorder {
    async fn start(spec: &WatchSpec, ffmpeg: &str, audio: bool) -> Recorder {
        let Some(input) = spec.input.record_args() else {
            return Recorder::Shared {
                // The segment holding the start began up to a segment earlier.
                since: SystemTime::now() - Duration::from_secs(u64::from(shared::SEGMENT_SECS)),
                jpeg: None,
                tried: false,
            };
        };
        let (wav, jpg) = (spec.dir.join("event.wav"), spec.dir.join("event.jpg"));
        let _ = tokio::fs::remove_file(&wav).await;
        let _ = tokio::fs::remove_file(&jpg).await;
        let args = record_args(input, audio, &wav, &jpg);
        match spawn_ffmpeg(ffmpeg, &args, true) {
            Ok(child) => Recorder::Child { child, wav, jpg },
            Err(e) => {
                log::warn!("camera {}: {}", spec.camera_id, spec.creds.redact(&e));
                Recorder::Idle
            }
        }
    }

    /// Take the shared picture once the event is a second old.
    async fn tick(&mut self, spec: &WatchSpec, opened_at: Option<i64>, now: i64) {
        if let (Recorder::Shared { jpeg, tried, .. }, Some(opened)) = (self, opened_at) {
            if !*tried && now - opened >= THUMB_AFTER_MS {
                *tried = true;
                let dir = spec.dir.clone();
                *jpeg = tokio::task::spawn_blocking(move || shared::read_latest(&dir))
                    .await
                    .ok()
                    .flatten();
            }
        }
    }

    /// Stop recording; the sound and picture.
    async fn finish(self, spec: &WatchSpec) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
        match self {
            Recorder::Idle => (None, None),
            Recorder::Child {
                mut child,
                wav,
                jpg,
            } => {
                if let Some(mut stdin) = child.stdin.take() {
                    use tokio::io::AsyncWriteExt;
                    let _ = stdin.write_all(b"q").await;
                }
                if tokio::time::timeout(RECORDER_STOP, child.wait())
                    .await
                    .is_err()
                {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
                let mut sound = tokio::fs::read(&wav).await.ok();
                if let Some(bytes) = sound.as_mut() {
                    if capture::fix_wav_sizes(bytes).is_err() {
                        sound = None;
                    }
                }
                let picture = tokio::fs::read(&jpg).await.ok().filter(|j| !j.is_empty());
                let _ = tokio::fs::remove_file(&wav).await;
                let _ = tokio::fs::remove_file(&jpg).await;
                (sound, picture)
            }
            Recorder::Shared { since, jpeg, .. } => {
                let dir = spec.dir.clone();
                let pcm = tokio::task::spawn_blocking(move || {
                    shared::concat_pcm(&shared::segments_since(&dir, since))
                })
                .await
                .unwrap_or_default();
                let sound = (!pcm.is_empty()).then(|| shared::wav_from_pcm(&pcm));
                let picture = match jpeg {
                    Some(j) => Some(j),
                    None => shared::latest_jpeg(&spec.dir).await.ok(),
                };
                (sound, picture)
            }
        }
    }
}

/// How one ffmpeg run ended.
#[derive(Debug, PartialEq)]
pub(crate) enum RunEnd {
    /// Asked to stop.
    Stopped,
    /// ffmpeg exited; why, in words for the user.
    Exited(String),
}

/// Run the watcher's ffmpeg once, until it exits or `stop` is set, sending
/// each closed event to `events`. `healthy` is called on the first reading.
pub(crate) async fn run_once(
    spec: &WatchSpec,
    ffmpeg: &str,
    audio: bool,
    stop: &mut watch::Receiver<bool>,
    events: &mpsc::UnboundedSender<ClosedEvent>,
    healthy: &(dyn Fn() + Send + Sync),
) -> RunEnd {
    if let Err(e) = tokio::fs::create_dir_all(&spec.dir).await {
        return RunEnd::Exited(format!("could not make the watcher's folder: {e}"));
    }
    let args = watch_args(&spec.input, audio, spec.scene, &spec.dir);
    let mut child = match spawn_ffmpeg(ffmpeg, &args, false) {
        Ok(c) => c,
        Err(e) => return RunEnd::Exited(spec.creds.redact(&e)),
    };
    let _shared = spec
        .input
        .shared()
        .then(|| shared::register(&spec.camera_id, &spec.dir));
    let stderr = child.stderr.take().map(|mut err| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            while let Ok(n) = err.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > STDERR_TAIL * 2 {
                    buf.drain(..buf.len() - STDERR_TAIL);
                }
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    });
    let Some(stdout) = child.stdout.take() else {
        return RunEnd::Exited("ffmpeg gave no output".into());
    };
    let mut lines = BufReader::new(stdout).lines();
    let mut detector = Detector::new(spec.timings, spec.threshold_db);
    let mut recorder = Recorder::Idle;
    let mut check = tokio::time::interval(CHECK_EVERY);
    let mut seen = false;
    let now = crate::time_util::now_ms;
    let stopped = loop {
        let step = tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => match detect::parse_line(&line) {
                    Some(reading) => {
                        if !seen {
                            seen = true;
                            healthy();
                        }
                        let turning = matches!(reading, Reading::Scene(_))
                            && detect::motion_held(&spec.camera_id, now());
                        if turning {
                            detector.tick(now())
                        } else {
                            detector.reading(reading, now())
                        }
                    }
                    None => Step::Nothing,
                },
                _ => break false,
            },
            _ = check.tick() => detector.tick(now()),
            _ = stop.changed() => break true,
        };
        match step {
            Step::Opened(_) => recorder = Recorder::start(spec, ffmpeg, audio).await,
            Step::Closed(closed) => {
                let done = std::mem::replace(&mut recorder, Recorder::Idle);
                send(spec, closed, done, events).await;
            }
            Step::Nothing => {}
        }
        recorder.tick(spec, detector.opened_at(), now()).await;
    };
    // The stream ended or the watcher is stopping: an open event is kept.
    if let Some(closed) = detector.close(now()) {
        send(spec, closed, recorder, events).await;
    }
    if stopped {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return RunEnd::Stopped;
    }
    let status = child.wait().await;
    let err = match stderr {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };
    let why = if err.trim().is_empty() {
        match status {
            Ok(s) if s.success() => "The camera stopped sending.".to_string(),
            Ok(s) => format!("ffmpeg stopped ({s})."),
            Err(e) => format!("ffmpeg stopped: {e}"),
        }
    } else {
        capture::explain(&err, &spec.creds)
    };
    RunEnd::Exited(spec.creds.redact(&why))
}

async fn send(
    spec: &WatchSpec,
    closed: Closed,
    recorder: Recorder,
    events: &mpsc::UnboundedSender<ClosedEvent>,
) {
    let (wav, jpeg) = recorder.finish(spec).await;
    let _ = events.send(ClosedEvent {
        camera_id: spec.camera_id.clone(),
        closed,
        wav,
        jpeg,
    });
}

/// Run a watcher until `stop` is set: ffmpeg, restarted with a growing wait
/// when it exits. `status` hears each error, and `None` once it reads again.
pub(crate) async fn run(
    spec: WatchSpec,
    overrides: BinaryOverrides,
    mut stop: watch::Receiver<bool>,
    events: mpsc::UnboundedSender<ClosedEvent>,
    status: Arc<dyn Fn(Option<String>) + Send + Sync>,
) {
    let mut backoff = BACKOFF_MIN;
    let mut audio = true;
    loop {
        if *stop.borrow() {
            return;
        }
        let started = Instant::now();
        let end = match resolve_tool(Tool::Ffmpeg, &overrides).await {
            Ok(path) => {
                let healthy = {
                    let status = status.clone();
                    move || status(None)
                };
                run_once(&spec, &path, audio, &mut stop, &events, &healthy).await
            }
            Err(e) => RunEnd::Exited(e),
        };
        match end {
            RunEnd::Stopped => return,
            // A stream with no sound: watch the picture alone, straight away.
            RunEnd::Exited(why) if audio && why == capture::NO_MICROPHONE => {
                audio = false;
                continue;
            }
            RunEnd::Exited(why) => {
                log::warn!("camera watcher {}: {why}", spec.camera_id);
                status(Some(why));
            }
        }
        if started.elapsed() >= HEALTHY_RUN {
            backoff = BACKOFF_MIN;
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = stop.changed() => return,
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// `HH:MM` as minutes past midnight.
fn minutes(hhmm: &str) -> Option<u32> {
    let (h, m) = hhmm.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Whether `now` (minutes past local midnight) is within the active hours;
/// an end before the start runs past midnight, and equal times are all day.
pub(crate) fn within_hours(hours: &ActiveHours, now: u32) -> Result<bool, String> {
    let (Some(start), Some(end)) = (minutes(&hours.start), minutes(&hours.end)) else {
        return Err(format!(
            "The active hours {}–{} aren't times; set them again in Settings → Cameras.",
            hours.start, hours.end
        ));
    };
    Ok(match start.cmp(&end) {
        std::cmp::Ordering::Less => (start..end).contains(&now),
        std::cmp::Ordering::Greater => now >= start || now < end,
        std::cmp::Ordering::Equal => true,
    })
}

/// Whether a camera's watcher should be running at `now` (minutes past local
/// midnight).
pub(crate) fn should_run(cfg: &CameraConfig, now: u32) -> Result<bool, String> {
    if !cfg.watcher.enabled {
        return Ok(false);
    }
    match &cfg.watcher.active_hours {
        Some(hours) => within_hours(hours, now),
        None => Ok(true),
    }
}

/// A camera id as a folder name.
fn folder_name(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        "_".into()
    } else {
        safe
    }
}

/// Log a closed event: insert the row, then write its thumbnail to
/// `<events_dir>/<camera_id>/<id>.jpg` and record where. Returns the id.
pub(crate) fn store_event(
    db: &Database,
    events_dir: &Path,
    event: &NewCameraEvent,
    thumb: Option<&[u8]>,
) -> Result<i64, String> {
    let id = db.insert_camera_event(event)?;
    if let Some(jpeg) = thumb {
        let dir = events_dir.join(folder_name(&event.camera_id));
        let path = dir.join(format!("{id}.jpg"));
        let written = std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::write(&path, jpeg))
            .map_err(|e| format!("Saving the thumbnail failed: {e}"));
        match written {
            Ok(()) => db.set_camera_event_thumb(id, &path.to_string_lossy())?,
            Err(e) => log::warn!("camera event {id}: {e}"),
        }
    }
    Ok(id)
}

/// Delete the events that started more than `days` before `now` (epoch ms),
/// and their thumbnails; how many thumbnails went.
pub(crate) fn purge_old(db: &Database, days: u32, now: i64) -> Result<usize, String> {
    let cutoff = now - i64::from(days.max(1)) * 86_400_000;
    let thumbs = db.purge_camera_events_before(cutoff)?;
    Ok(remove_files(&thumbs))
}

/// Delete thumbnail files; how many were deleted.
pub(crate) fn remove_files(paths: &[String]) -> usize {
    paths
        .iter()
        .filter(|p| std::fs::remove_file(p).is_ok())
        .count()
}

/// Whisper's notes for no speech (`[BLANK_AUDIO]`, `(wind blowing)`) left out.
pub(crate) fn clean_transcript<'a>(segments: impl IntoIterator<Item = &'a str>) -> String {
    let kept: Vec<&str> = segments
        .into_iter()
        .map(str::trim)
        .filter(|t| {
            !t.is_empty()
                && !(t.starts_with('[') && t.ends_with(']'))
                && !(t.starts_with('(') && t.ends_with(')'))
        })
        .collect();
    kept.join(" ")
}

/// Which watchers are running, and what last went wrong for each camera.
/// Also the payload of `camera://watchers`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CameraWatchStatus {
    /// Camera ids.
    pub running: Vec<String>,
    /// By camera id; a camera that is working has none.
    pub errors: HashMap<String, String>,
}

/// The payload of `camera://event`: an event was logged.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CameraEventNotice {
    #[ts(type = "number")]
    pub id: i64,
    pub camera_id: String,
}

struct Running {
    config: CameraConfig,
    overrides: BinaryOverrides,
    stop: watch::Sender<bool>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct State {
    configs: Vec<CameraConfig>,
    retention_days: u32,
    overrides: BinaryOverrides,
    running: HashMap<String, Running>,
    errors: HashMap<String, String>,
    ticking: bool,
}

impl State {
    fn status(&self) -> CameraWatchStatus {
        let mut running: Vec<String> = self.running.keys().cloned().collect();
        running.sort();
        CameraWatchStatus {
            running,
            errors: self.errors.clone(),
        }
    }
}

/// The running watchers, managed as app state.
#[derive(Clone, Default)]
pub struct WatcherRegistry {
    state: Arc<Mutex<State>>,
}

impl WatcherRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn status(&self) -> CameraWatchStatus {
        self.lock().status()
    }

    fn emit(&self, app: &tauri::AppHandle) {
        use tauri::Emitter;
        let _ = app.emit("camera://watchers", self.status());
    }

    /// Take new settings, delete old events, and start or stop watchers to
    /// match; the first call starts the schedule.
    pub async fn set(
        &self,
        app: &tauri::AppHandle,
        configs: Vec<CameraConfig>,
        retention_days: u32,
        overrides: BinaryOverrides,
    ) -> CameraWatchStatus {
        let start_ticking = {
            let mut s = self.lock();
            s.configs = configs;
            s.retention_days = retention_days;
            s.overrides = overrides;
            !std::mem::replace(&mut s.ticking, true)
        };
        self.purge(app).await;
        self.reconcile(app).await;
        if start_ticking {
            let (this, app) = (self.clone(), app.clone());
            tauri::async_runtime::spawn(async move {
                let mut last_purge = Instant::now();
                loop {
                    tokio::time::sleep(TICK).await;
                    this.reconcile(&app).await;
                    if last_purge.elapsed() >= PURGE_EVERY {
                        last_purge = Instant::now();
                        this.purge(&app).await;
                    }
                }
            });
        }
        self.status()
    }

    async fn purge(&self, app: &tauri::AppHandle) {
        use tauri::Manager;
        let days = self.lock().retention_days;
        let db = app.state::<Database>().inner().clone();
        let now = crate::time_util::now_ms();
        let done = tokio::task::spawn_blocking(move || purge_old(&db, days, now)).await;
        if let Ok(Err(e)) = done {
            log::warn!("deleting old camera events failed: {e}");
        }
    }

    /// Start and stop watchers to match the settings and the time of day.
    async fn reconcile(&self, app: &tauri::AppHandle) {
        use chrono::Timelike;
        let now = chrono::Local::now();
        let minute = now.hour() * 60 + now.minute();
        let mut stopping = Vec::new();
        let changed = {
            let mut s = self.lock();
            let mut want: HashMap<String, CameraConfig> = HashMap::new();
            let mut hour_errors = Vec::new();
            for cfg in &s.configs {
                match should_run(cfg, minute) {
                    Ok(true) => {
                        want.insert(cfg.id.clone(), cfg.clone());
                    }
                    Ok(false) => {}
                    Err(e) => hour_errors.push((cfg.id.clone(), e)),
                }
            }
            let overrides = s.overrides.clone();
            let before = s.status();
            let stale: Vec<String> = s
                .running
                .iter()
                .filter(|(id, r)| want.get(*id) != Some(&r.config) || r.overrides != overrides)
                .map(|(id, _)| id.clone())
                .collect();
            for id in stale {
                if let Some(r) = s.running.remove(&id) {
                    let _ = r.stop.send(true);
                    stopping.push(r.task);
                }
            }
            // Errors belong to cameras that are watching; a camera turned
            // off has nothing to report.
            s.errors.retain(|id, _| want.contains_key(id));
            for (id, e) in hour_errors {
                s.errors.insert(id, e);
            }
            want.retain(|id, _| !s.running.contains_key(id));
            let starting: Vec<CameraConfig> = want.into_values().collect();
            (before, starting)
        };
        // A webcam must be let go before it is opened again.
        for task in stopping {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
        let (before, starting) = changed;
        for cfg in starting {
            self.start(app, cfg);
        }
        if self.status() != before {
            self.emit(app);
        }
    }

    fn start(&self, app: &tauri::AppHandle, cfg: CameraConfig) {
        use tauri::Manager;
        let Ok(data) = app.path().app_data_dir() else {
            return;
        };
        // Held until the watcher is listed, so its first error isn't lost.
        let mut state = self.lock();
        let (stop_tx, stop_rx) = watch::channel(false);
        let (events_tx, mut events_rx) = mpsc::unbounded_channel::<ClosedEvent>();
        let overrides = state.overrides.clone();
        let threshold = cfg.watcher.sound_threshold_db;
        let id = cfg.id.clone();
        let status: Arc<dyn Fn(Option<String>) + Send + Sync> = {
            let (this, app, id) = (self.clone(), app.clone(), id.clone());
            Arc::new(move |error: Option<String>| {
                let changed = {
                    let mut s = this.lock();
                    if !s.running.contains_key(&id) {
                        return;
                    }
                    match error {
                        Some(e) => s.errors.insert(id.clone(), e.clone()).as_ref() != Some(&e),
                        None => s.errors.remove(&id).is_some(),
                    }
                };
                if changed {
                    this.emit(&app);
                }
            })
        };
        // Events are logged in order, after the watcher is stopped too.
        {
            let app = app.clone();
            let events_dir = data.join("camera_events");
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events_rx.recv().await {
                    log_event(&app, &events_dir, event, threshold).await;
                }
            });
        }
        let task = {
            let cfg = cfg.clone();
            let dir = data.join("camera_watch").join(folder_name(&cfg.id));
            let overrides = overrides.clone();
            let status = status.clone();
            tauri::async_runtime::spawn(async move {
                let (input, creds) = match Input::for_camera(&cfg).await {
                    Ok(found) => found,
                    Err(e) => {
                        status(Some(e));
                        return;
                    }
                };
                let spec = WatchSpec {
                    camera_id: cfg.id.clone(),
                    input,
                    creds: Arc::new(creds),
                    dir,
                    scene: detect::scene_threshold(cfg.watcher.motion_sensitivity),
                    threshold_db: cfg.watcher.sound_threshold_db,
                    timings: Timings::default(),
                };
                run(spec, overrides, stop_rx, events_tx, status).await;
            })
        };
        state.running.insert(
            id,
            Running {
                config: cfg,
                overrides,
                stop: stop_tx,
                task,
            },
        );
    }

    /// Stop every watcher, as the app exits.
    pub async fn stop_all(&self) {
        let tasks: Vec<_> = {
            let mut s = self.lock();
            s.configs.clear();
            s.running
                .drain()
                .map(|(_, r)| {
                    let _ = r.stop.send(true);
                    r.task
                })
                .collect()
        };
        // Each gets a moment to keep an open event; then its ffmpeg goes
        // with it (kill on drop).
        let waits = tasks.into_iter().map(|task| async move {
            let abort = task.inner().abort_handle();
            if tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .is_err()
            {
                abort.abort();
            }
        });
        futures_util::future::join_all(waits).await;
    }
}

/// Transcribe a closed event, log it, and say so with `camera://event`.
async fn log_event(app: &tauri::AppHandle, events_dir: &Path, event: ClosedEvent, threshold: f64) {
    use tauri::{Emitter, Manager};
    let level_db = event.wav.as_deref().map_or(-120.0, capture::level_db);
    // Motion in a quiet room has nothing to say, and whisper invents words
    // for silence.
    let speech = event.closed.trigger != Trigger::Motion || level_db >= threshold;
    let transcript = match event.wav {
        Some(wav) if speech => transcribe(app, wav).await.unwrap_or_else(|e| {
            log::warn!("camera {}: transcribing failed: {e}", event.camera_id);
            String::new()
        }),
        _ => String::new(),
    };
    let thumb = match event.jpeg {
        Some(jpeg) => tokio::task::spawn_blocking(move || shared::fit_jpeg(&jpeg, THUMB_WIDTH))
            .await
            .ok()
            .and_then(Result::ok),
        None => None,
    };
    let row = NewCameraEvent {
        camera_id: event.camera_id.clone(),
        started_at: event.closed.started_at,
        ended_at: event.closed.ended_at,
        trigger: event.closed.trigger.as_str().to_string(),
        level_db,
        transcript,
    };
    let db = app.state::<Database>().inner().clone();
    let dir = events_dir.to_path_buf();
    let stored =
        tokio::task::spawn_blocking(move || store_event(&db, &dir, &row, thumb.as_deref())).await;
    match stored {
        Ok(Ok(id)) => {
            let _ = app.emit(
                "camera://event",
                CameraEventNotice {
                    id,
                    camera_id: event.camera_id,
                },
            );
        }
        Ok(Err(e)) => log::warn!("camera {}: {e}", event.camera_id),
        Err(e) => log::warn!("camera {}: logging the event failed: {e}", event.camera_id),
    }
}

/// What was said in `wav`, through the video whisper-server.
async fn transcribe(app: &tauri::AppHandle, wav: Vec<u8>) -> Result<String, String> {
    use crate::video::transcribe::{language_for, lease_server, model_for};
    use tauri::Manager;
    let model = model_for(app.state::<crate::models::ModelManager>().models_dir())
        .ok_or("No speech model is installed. Settings → Audio downloads one.")?;
    let _lease = lease_server(app, &model).await?;
    let (segments, _) = app
        .state::<crate::whisper::VideoWhisper>()
        .0
        .transcribe_segments(wav, language_for(&model))
        .await?;
    Ok(clean_transcript(segments.iter().map(|s| s.text.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    fn hours(start: &str, end: &str) -> ActiveHours {
        ActiveHours {
            start: start.into(),
            end: end.into(),
        }
    }

    #[test]
    fn active_hours_wrap_past_midnight() {
        let day = hours("08:00", "18:30");
        assert!(!within_hours(&day, 7 * 60 + 59).unwrap());
        assert!(within_hours(&day, 8 * 60).unwrap());
        assert!(within_hours(&day, 18 * 60 + 29).unwrap());
        assert!(!within_hours(&day, 18 * 60 + 30).unwrap());
        let night = hours("22:00", "06:00");
        assert!(within_hours(&night, 23 * 60).unwrap());
        assert!(within_hours(&night, 0).unwrap());
        assert!(within_hours(&night, 5 * 60 + 59).unwrap());
        assert!(!within_hours(&night, 6 * 60).unwrap());
        assert!(!within_hours(&night, 12 * 60).unwrap());
        assert!(within_hours(&hours("07:00", "07:00"), 3).unwrap());
        assert!(within_hours(&hours("7:5", "25:00"), 0).is_err());
    }

    fn camera(source: CameraSource) -> CameraConfig {
        CameraConfig {
            id: "cam/1".into(),
            name: "Kitchen".into(),
            source,
            permission: Default::default(),
            ptz: Default::default(),
            onvif: None,
            watcher: Default::default(),
            caps: None,
            calibration: None,
        }
    }

    #[test]
    fn only_an_enabled_camera_in_its_hours_runs() {
        let mut cfg = camera(CameraSource::Usb {
            video_device: "/dev/video0".into(),
            audio_device: None,
        });
        assert!(!should_run(&cfg, 600).unwrap());
        cfg.watcher.enabled = true;
        assert!(should_run(&cfg, 600).unwrap());
        cfg.watcher.active_hours = Some(hours("22:00", "06:00"));
        assert!(!should_run(&cfg, 600).unwrap());
        assert!(should_run(&cfg, 60).unwrap());
        assert_eq!(folder_name("cam/1"), "cam_1");
        assert_eq!(folder_name(""), "_");
    }

    #[tokio::test]
    async fn a_network_camera_watches_its_substream_and_records_the_main_one() {
        crate::secrets::seed_for_test("camera:test-watch", "pw");
        let cfg = camera(CameraSource::Rtsp {
            url: "rtsp://cam/ch0".into(),
            substream_url: Some("rtsp://cam/ch1".into()),
            username: "root".into(),
            password_ref: Some("camera:test-watch".into()),
        });
        let (input, creds) = Input::for_camera(&cfg).await.unwrap();
        assert_eq!(
            creds.redact("rtsp://root:pw@cam"),
            creds.redact("rtsp://root:x@cam")
        );
        let args = watch_args(&input, true, 0.04, Path::new("/w"));
        assert!(args.contains(&"rtsp://root:pw@cam/ch1".to_string()));
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.starts_with("[0:v:0]fps=2,scale=320:-2,select='gt(scene,0.04)'"));
        assert!(graph.contains("[0:a:0]aresample=16000"));
        assert!(!args.iter().any(|a| a.contains("latest.jpg")));
        let quiet = watch_args(&input, false, 0.04, Path::new("/w"));
        assert!(!quiet.iter().any(|a| a.contains("astats")));
        let rec = record_args(
            input.record_args().unwrap(),
            true,
            Path::new("/w/e.wav"),
            Path::new("/w/e.jpg"),
        );
        assert!(rec.contains(&"rtsp://root:pw@cam/ch0".to_string()));
        assert!(rec.windows(2).any(|w| w == ["-ss", "1"]));
    }

    #[tokio::test]
    async fn a_webcam_watcher_writes_the_shared_files() {
        let cfg = camera(CameraSource::Usb {
            video_device: "/dev/video0".into(),
            audio_device: Some("hw:1,0".into()),
        });
        let (input, _) = Input::for_camera(&cfg).await.unwrap();
        assert!(input.record_args().is_none());
        let args = watch_args(&input, true, 0.08, Path::new("/w"));
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.starts_with("[0:v:0]split=2"));
        assert!(graph.contains("[1:a:0]aresample"));
        assert!(args.iter().any(|a| a.ends_with("latest.jpg")));
        assert!(args.iter().any(|a| a.ends_with("seg%03d.wav")));
        let silent = camera(CameraSource::Usb {
            video_device: "/dev/video0".into(),
            audio_device: Some("  ".into()),
        });
        let (input, _) = Input::for_camera(&silent).await.unwrap();
        let args = watch_args(&input, true, 0.08, Path::new("/w"));
        assert!(!args
            .iter()
            .any(|a| a.contains("astats") || a.contains("seg%")));
    }

    #[test]
    fn whisper_notes_are_left_out() {
        assert_eq!(
            clean_transcript([" Hello there.", "[BLANK_AUDIO]", "(door closes)", " Bye "]),
            "Hello there. Bye"
        );
        assert_eq!(clean_transcript(["[ Silence ]"]), "");
    }

    fn row(camera_id: &str, started_at: i64) -> NewCameraEvent {
        NewCameraEvent {
            camera_id: camera_id.into(),
            started_at,
            ended_at: started_at + 1_000,
            trigger: "motion".into(),
            level_db: -120.0,
            transcript: String::new(),
        }
    }

    #[test]
    fn an_event_is_stored_with_its_thumbnail_and_purged_with_it() {
        let db = Database::open_in_memory();
        let dir = temp_dir("camera_events_store");
        let day = 86_400_000;
        let now = 100 * day;
        let old = store_event(&db, &dir, &row("cam/1", now - 8 * day), Some(b"old")).unwrap();
        let new = store_event(&db, &dir, &row("cam/1", now - day), Some(b"new")).unwrap();
        let bare = store_event(&db, &dir, &row("cam/1", now - 9 * day), None).unwrap();
        let old_path = dir.join("cam_1").join(format!("{old}.jpg"));
        let new_path = dir.join("cam_1").join(format!("{new}.jpg"));
        assert_eq!(std::fs::read(&old_path).unwrap(), b"old");
        assert_eq!(
            db.camera_event_thumb_path(new).unwrap().as_deref(),
            Some(&*new_path.to_string_lossy())
        );
        assert_eq!(db.camera_event_thumb_path(bare).unwrap(), None);
        assert_eq!(purge_old(&db, 7, now).unwrap(), 1);
        assert!(!old_path.exists() && new_path.exists());
        let left = db
            .list_camera_events(&crate::db::CameraEventFilter {
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(left.iter().map(|e| e.id).collect::<Vec<_>>(), [new]);
        assert!(left[0].has_thumb);
    }

    async fn ffmpeg() -> Option<String> {
        resolve_tool(Tool::Ffmpeg, &BinaryOverrides::default())
            .await
            .ok()
    }

    /// Two seconds of black, then white for four with a 1.5-second tone at
    /// the switch, in real time.
    const SCENE_AND_TONE: &str = "color=c=black:s=320x240:r=10:d=2[v0];\
        color=c=white:s=320x240:r=10:d=4[v1];\
        [v0][v1]concat=n=2:v=1:a=0,realtime[out0];\
        aevalsrc='if(between(t,2,3.5),0.5*sin(2*PI*440*t),0)':s=16000:d=6,arealtime[out1]";

    fn spec(input: Input, dir: &Path) -> WatchSpec {
        WatchSpec {
            camera_id: "lavfi-cam".into(),
            input,
            creds: Arc::new(Credentials::default()),
            dir: dir.to_path_buf(),
            scene: 0.04,
            threshold_db: -35.0,
            timings: Timings {
                quiet_ms: 1_500,
                ..Timings::default()
            },
        }
    }

    async fn watch_once(spec: &WatchSpec, ffmpeg: &str) -> (RunEnd, Vec<ClosedEvent>) {
        let (_stop_tx, mut stop) = watch::channel(false);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let healthy = || {};
        let end = run_once(spec, ffmpeg, true, &mut stop, &tx, &healthy).await;
        drop(tx);
        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }
        (end, events)
    }

    #[tokio::test]
    async fn a_scene_change_and_a_tone_make_one_event_with_a_thumbnail() {
        let Some(ffmpeg) = ffmpeg().await else {
            eprintln!("skipped: no ffmpeg");
            return;
        };
        let dir = temp_dir("camera_watch_lavfi");
        let spec = spec(Input::Lavfi(SCENE_AND_TONE.into()), &dir);
        let (end, events) = watch_once(&spec, &ffmpeg).await;
        assert_eq!(end, RunEnd::Exited("The camera stopped sending.".into()));
        assert_eq!(events.len(), 1, "one event");
        let event = &events[0];
        assert_eq!(event.closed.trigger, Trigger::Both);
        let jpeg = event.jpeg.as_deref().expect("a thumbnail");
        assert!(image::load_from_memory(jpeg).is_ok());
        let wav = event.wav.as_deref().expect("its sound");
        assert!(capture::level_db(wav) > -40.0, "{}", capture::level_db(wav));
        // The recording's files are gone once read.
        assert!(!dir.join("event.wav").exists() && !dir.join("event.jpg").exists());
        // And it is logged with the thumbnail.
        let db = Database::open_in_memory();
        let thumb = shared::fit_jpeg(jpeg, THUMB_WIDTH).unwrap();
        let row = NewCameraEvent {
            trigger: event.closed.trigger.as_str().into(),
            ..row(&event.camera_id, event.closed.started_at)
        };
        let id = store_event(&db, &dir.join("events"), &row, Some(&thumb)).unwrap();
        let path = db.camera_event_thumb_path(id).unwrap().unwrap();
        assert!(Path::new(&path).exists());
    }

    #[tokio::test]
    async fn a_webcam_watcher_shares_its_picture_and_sound() {
        let Some(ffmpeg) = ffmpeg().await else {
            eprintln!("skipped: no ffmpeg");
            return;
        };
        let dir = temp_dir("camera_watch_shared");
        let spec = spec(Input::LavfiShared(SCENE_AND_TONE.into()), &dir);
        let reader = {
            let dir = dir.to_path_buf();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1_500)).await;
                let registered = shared::dir_for("lavfi-cam");
                let jpeg = shared::snapshot(&dir, 160).await;
                (registered, jpeg)
            })
        };
        let (end, events) = watch_once(&spec, &ffmpeg).await;
        let (registered, jpeg) = reader.await.unwrap();
        assert_eq!(registered.as_deref(), Some(dir.as_path()));
        let jpeg = jpeg.unwrap();
        assert_eq!(image::load_from_memory(&jpeg).unwrap().width(), 160);
        assert_eq!(end, RunEnd::Exited("The camera stopped sending.".into()));
        assert_eq!(shared::dir_for("lavfi-cam"), None, "unregistered on exit");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].closed.trigger, Trigger::Both);
        assert!(events[0].jpeg.is_some());
        let wav = events[0].wav.as_deref().expect("its sound");
        assert!(capture::level_db(wav) > -40.0);
    }
}
