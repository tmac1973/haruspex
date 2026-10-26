//! Transcribing footage with timestamps, for cutting by what was said and for
//! chapters and captions.
//!
//! The video tools run their own whisper-server (port 8768, `VideoWhisper`)
//! with the best model there is: large-v3-turbo once Settings → Video editing has
//! downloaded it, base.en until then. It starts on the first transcription and
//! stops five minutes after the last, so it holds no memory between videos and
//! voice input's instance is never touched.
//!
//! A clip's sound is extracted once to 16 kHz mono WAV, cut into pieces of
//! about five minutes at the quietest nearby moment, and each piece sent on its
//! own, so progress can be shown and a cancel lands between pieces. The result
//! is kept in `<episode>/.haruspex/transcripts/` until the clip changes.

use super::silence::{self, SilenceRange};
use super::{paths, probe};
use crate::whisper::{Segment, VideoWhisper};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Seconds of audio per request.
const CHUNK_SECS: f64 = 300.0;
/// How far from a chunk mark a silence may be to cut there instead.
const CHUNK_REACH: f64 = 30.0;
/// The video whisper-server stops this long after its last use.
const IDLE_STOP: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    /// The clip, relative to the working folder.
    pub path: String,
    /// The whisper model's file name.
    pub model: String,
    pub language: Option<String>,
    pub duration_secs: f64,
    pub segments: Vec<Segment>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeProgress {
    pub clip: String,
    pub done_secs: f64,
    pub total_secs: f64,
    /// 1-based, of `count`.
    pub index: u32,
    pub count: u32,
}

/// What a cached transcript was made from.
#[derive(Serialize, Deserialize)]
struct Cached {
    size: u64,
    mtime: u64,
    transcript: Transcript,
}

/// The model the video tools transcribe with: turbo if downloaded.
pub fn model_for(models_dir: &Path) -> Option<PathBuf> {
    let dir = models_dir.join("whisper");
    [crate::models::WHISPER_VIDEO_MODEL, "ggml-base.en.bin"]
        .iter()
        .map(|m| dir.join(m))
        .find(|p| p.exists())
}

fn is_turbo(model: &Path) -> bool {
    model
        .file_name()
        .is_some_and(|n| n == crate::models::WHISPER_VIDEO_MODEL)
}

fn stamp(file: &Path) -> (u64, u64) {
    let meta = std::fs::metadata(file).ok();
    let size = meta.as_ref().map_or(0, |m| m.len());
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    (size, mtime)
}

/// A short, stable key for a clip as it is now.
fn clip_key(file: &Path) -> String {
    let (size, mtime) = stamp(file);
    let mut h = Sha256::new();
    h.update(file.to_string_lossy().as_bytes());
    h.update(size.to_le_bytes());
    h.update(mtime.to_le_bytes());
    crate::hash_util::hex(&h.finalize())[..12].to_string()
}

fn haruspex_dir(episode_dir: &Path) -> PathBuf {
    episode_dir.join(".haruspex")
}

pub fn cache_path(episode_dir: &Path, file: &Path) -> PathBuf {
    let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("clip");
    haruspex_dir(episode_dir)
        .join("transcripts")
        .join(format!("{stem}-{}.json", &clip_key(file)[..8]))
}

/// The cached transcript of a clip, if it is still current.
pub fn cached(episode_dir: &Path, file: &Path) -> Option<Transcript> {
    let text = std::fs::read_to_string(cache_path(episode_dir, file)).ok()?;
    let c: Cached = serde_json::from_str(&text).ok()?;
    ((c.size, c.mtime) == stamp(file)).then_some(c.transcript)
}

fn save_cache(episode_dir: &Path, file: &Path, t: &Transcript) {
    let path = cache_path(episode_dir, file);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let (size, mtime) = stamp(file);
    let c = Cached {
        size,
        mtime,
        transcript: t.clone(),
    };
    if let Ok(text) = serde_json::to_string(&c) {
        let _ = std::fs::write(path, text);
    }
}

async fn run_ffmpeg(ffmpeg: &str, args: &[&str], what: &str) -> Result<Vec<u8>, String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-v", "error"])
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    super::no_window(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(30 * 60), cmd.output())
        .await
        .map_err(|_| format!("{what} took too long"))?
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "{what} failed: {}",
            err.lines().next().unwrap_or("ffmpeg failed")
        ));
    }
    Ok(out.stdout)
}

/// The clip's sound as 16 kHz mono WAV, extracted once.
pub async fn audio_wav(
    ffmpeg: &str,
    episode_dir: &Path,
    file: &Path,
    stream: u32,
) -> Result<PathBuf, String> {
    let dir = haruspex_dir(episode_dir).join("audio");
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    let wav = dir.join(format!("{}.wav", clip_key(file)));
    if wav.exists() {
        return Ok(wav);
    }
    let part = wav.with_extension("part.wav");
    let map = format!("0:{stream}");
    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &file.to_string_lossy(),
            "-map",
            &map,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            &part.to_string_lossy(),
        ],
        "extracting the sound",
    )
    .await?;
    std::fs::rename(&part, &wav).map_err(|e| format!("can't save the sound: {e}"))?;
    Ok(wav)
}

/// Cancels a running transcription between (and during) requests.
#[derive(Clone, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

impl Cancel {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    async fn wait(&self) {
        loop {
            // Registered before the check, so a cancel in between still wakes it.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.cancelled() {
                return;
            }
            notified.await;
        }
    }
}

const CANCELLED: &str = "Transcription cancelled.";

/// Uses of the video whisper-server, so an idle stop only fires after the last.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static LOADED: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Make sure the video whisper-server is up with `model`.
pub async fn ensure_server(
    app: &tauri::AppHandle,
    whisper: &VideoWhisper,
    model: &Path,
) -> Result<(), String> {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let loaded = LOADED.lock().map(|l| l.clone()).unwrap_or(None);
    if loaded.as_deref() != Some(model) || !whisper.0.is_running().await {
        whisper.0.start(app, &model.to_string_lossy()).await?;
        if let Ok(mut l) = LOADED.lock() {
            *l = Some(model.to_path_buf());
        }
    }
    whisper.0.wait_ready(Duration::from_secs(120)).await
}

/// Stop the video whisper-server once it has been idle a while.
pub fn schedule_idle_stop(app: tauri::AppHandle) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(IDLE_STOP).await;
        if GENERATION.load(Ordering::SeqCst) == generation {
            use tauri::Manager;
            let _ = app.state::<VideoWhisper>().0.stop().await;
            if let Ok(mut l) = LOADED.lock() {
                *l = None;
            }
        }
    });
}

/// Whether a clip needs whisper, or its kept transcript will do.
pub fn needs_whisper(episode_dir: &Path, file: &Path, model: &Path, refresh: bool) -> bool {
    let model_name = model.file_name().and_then(|n| n.to_str()).unwrap_or("");
    match cached(episode_dir, file) {
        Some(t) => refresh && t.model != model_name,
        None => true,
    }
}

/// Transcribe one clip, from the cache when it is current and `refresh` is off.
/// The video whisper-server must be running (`ensure_server`) unless the
/// transcript is kept.
#[allow(clippy::too_many_arguments)]
pub async fn transcribe_clip(
    whisper: &VideoWhisper,
    ffmpeg: &str,
    model: &Path,
    episode_dir: &Path,
    file: &Path,
    info: &probe::ClipInfo,
    refresh: bool,
    cancel: &Cancel,
    progress: &(dyn Fn(f64) + Send + Sync),
) -> Result<Transcript, String> {
    let model_name = model
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    if let Some(t) = cached(episode_dir, file) {
        // A base.en transcript is kept until turbo is there and asked for.
        if !refresh || t.model == model_name {
            return Ok(t);
        }
    }
    let stream = info
        .audio
        .first()
        .map(|a| a.index)
        .ok_or_else(|| format!("{} has no sound to transcribe.", info.path))?;
    let wav = audio_wav(ffmpeg, episode_dir, file, stream).await?;
    if cancel.cancelled() {
        return Err(CANCELLED.into());
    }
    let duration = info.duration_secs;
    let silences: Vec<SilenceRange> = if duration > CHUNK_SECS + CHUNK_REACH {
        silence::detect(ffmpeg, &wav, -35.0, 0.4, None).await?
    } else {
        Vec::new()
    };
    let points = silence::chunk_points(duration, &silences, CHUNK_SECS, CHUNK_REACH);
    let language = if is_turbo(model) { "auto" } else { "en" };
    let mut segments = Vec::new();
    let mut detected = None;
    for pair in points.windows(2) {
        let (from, to) = (pair[0], pair[1]);
        let chunk = run_ffmpeg(
            ffmpeg,
            &[
                "-ss",
                &format!("{from:.3}"),
                "-to",
                &format!("{to:.3}"),
                "-i",
                &wav.to_string_lossy(),
                "-f",
                "wav",
                "-",
            ],
            "cutting the sound",
        )
        .await?;
        let answer = tokio::select! {
            r = whisper.0.transcribe_segments(chunk, language) => r?,
            _ = cancel.wait() => return Err(CANCELLED.into()),
        };
        detected = detected.or(answer.1);
        segments.extend(answer.0.into_iter().map(|s| Segment {
            start: s.start + from,
            end: (s.end + from).min(to),
            text: s.text,
        }));
        progress(to);
        if cancel.cancelled() {
            return Err(CANCELLED.into());
        }
    }
    let t = Transcript {
        path: info.path.clone(),
        model: model_name,
        language: detected,
        duration_secs: duration,
        segments,
    };
    save_cache(episode_dir, file, &t);
    Ok(t)
}

/// The episode's clips to transcribe: those named, or every one with sound.
pub async fn clips_to_transcribe(
    ffprobe: &str,
    working_dir: &str,
    episode: &str,
    named: &[String],
    intro: &str,
    outro: &str,
) -> Result<Vec<(PathBuf, probe::ClipInfo)>, String> {
    let mut out = Vec::new();
    if named.is_empty() {
        let dir = paths::resolve_episode(working_dir, episode)?;
        for file in probe::media_files(&dir) {
            let shown = paths::display_path(working_dir, &file);
            if let Ok(info) = probe::probe_file(ffprobe, &file, shown).await {
                if !info.audio.is_empty() {
                    out.push((file, info));
                }
            }
        }
    } else {
        for p in named {
            let file = paths::resolve_media(working_dir, p, intro, outro)?;
            let info =
                probe::probe_file(ffprobe, &file, paths::display_path(working_dir, &file)).await?;
            out.push((file, info));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    #[test]
    fn turbo_is_preferred_when_downloaded() {
        let dir = temp_dir("whisper_models");
        std::fs::create_dir_all(dir.join("whisper")).unwrap();
        assert_eq!(model_for(&dir), None);
        std::fs::write(dir.join("whisper/ggml-base.en.bin"), b"").unwrap();
        assert!(model_for(&dir).unwrap().ends_with("ggml-base.en.bin"));
        std::fs::write(
            dir.join("whisper").join(crate::models::WHISPER_VIDEO_MODEL),
            b"",
        )
        .unwrap();
        assert!(is_turbo(&model_for(&dir).unwrap()));
    }

    #[test]
    fn the_cache_is_dropped_when_the_clip_changes() {
        let dir = temp_dir("transcript_cache");
        let clip = dir.join("a.mp4");
        std::fs::write(&clip, b"one").unwrap();
        let t = Transcript {
            path: "a.mp4".into(),
            model: "ggml-base.en.bin".into(),
            language: Some("en".into()),
            duration_secs: 3.0,
            segments: vec![Segment {
                start: 0.0,
                end: 1.0,
                text: "hi".into(),
            }],
        };
        save_cache(&dir, &clip, &t);
        assert_eq!(cached(&dir, &clip), Some(t));
        std::fs::write(&clip, b"different").unwrap();
        assert_eq!(cached(&dir, &clip), None);
    }

    /// Transcribe a real clip against a whisper-server the test starts.
    /// `HARUSPEX_VIDEO_CLIP=/path/clip.mp4 cargo test -- --ignored transcribe_a_real_clip --nocapture`
    /// (needs ffmpeg, ffprobe, the sidecar binaries and base.en).
    #[tokio::test]
    #[ignore = "needs whisper-server, its model and a clip"]
    async fn transcribe_a_real_clip() {
        let clip =
            PathBuf::from(std::env::var("HARUSPEX_VIDEO_CLIP").expect("set HARUSPEX_VIDEO_CLIP"));
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let model = home.join(".local/share/com.haruspex.app/models/whisper/ggml-base.en.bin");
        let bins = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let server = std::fs::read_dir(&bins)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .find(|p| {
                let n = p.file_name().unwrap().to_string_lossy().into_owned();
                n.starts_with("haruspex-whisper-server-") && !n.ends_with(".version")
            })
            .expect("no whisper-server sidecar");
        let mut child = tokio::process::Command::new(&server)
            .args([
                "--model",
                &model.to_string_lossy(),
                "--host",
                "127.0.0.1",
                "--port",
                "8768",
            ])
            .env("LD_LIBRARY_PATH", bins.join("libs"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let whisper = crate::whisper::WhisperServer::video();
        whisper
            .0
            .attach_ready_for_tests(Duration::from_secs(60))
            .await;
        let dir = temp_dir("transcribe_real");
        let info = probe::probe_file("ffprobe", &clip, "clip".into())
            .await
            .unwrap();
        let progress = |done: f64| println!("progress {done:.0}");
        let t = transcribe_clip(
            &whisper,
            "ffmpeg",
            &model,
            &dir,
            &clip,
            &info,
            false,
            &Cancel::default(),
            &progress,
        )
        .await
        .unwrap();
        child.kill().await.ok();
        println!(
            "{} segments; first {:?}; last {:?}",
            t.segments.len(),
            t.segments.first(),
            t.segments.last()
        );
        assert!(!t.segments.is_empty());
        assert!(t.segments.windows(2).all(|w| w[0].start <= w[1].start));
        assert!(t.segments.last().unwrap().end <= info.duration_secs + 1.0);
        assert!(cached(&dir, &clip).is_some());
    }

    #[test]
    fn cancel_wakes_a_waiter() {
        let c = Cancel::default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let waiter = c.clone();
            let h = tokio::spawn(async move { waiter.wait().await });
            tokio::task::yield_now().await;
            c.cancel();
            tokio::time::timeout(Duration::from_secs(1), h)
                .await
                .unwrap()
                .unwrap();
        });
    }
}

/// One line of the cut's speech, in the video's time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLine {
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// The clip it is from, 1-based.
    pub index: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTranscript {
    /// Relative to the working folder.
    pub project: String,
    pub lines: Vec<TimelineLine>,
    /// Clips with no transcript yet, 1-based.
    pub untranscribed: Vec<u32>,
    pub total_secs: f64,
}

/// The project's speech in the cut's time, from the episode's transcripts.
pub fn timeline_transcript(
    working_dir: &str,
    episode: &str,
    project: Option<&str>,
) -> Result<
    (
        TimelineTranscript,
        Vec<super::kdenlive::timeline_map::Line>,
        PathBuf,
    ),
    String,
> {
    use super::kdenlive::{self, timeline_map};
    let path = super::project::default_project(working_dir, episode, project, false)?;
    let doc = kdenlive::open(&path)?;
    let episode_dir = paths::resolve_episode(working_dir, episode)?;
    let spans = timeline_map::spans(&doc);
    let (lines, missing) = timeline_map::lines(&spans, |file| {
        cached(&episode_dir, file).map(|t| t.segments)
    });
    let t = TimelineTranscript {
        project: paths::display_path(working_dir, &path),
        lines: lines
            .iter()
            .map(|l| TimelineLine {
                start: l.start,
                end: l.end,
                text: l.text.clone(),
                index: l.index as u32,
            })
            .collect(),
        untranscribed: missing.into_iter().map(|i| i as u32).collect(),
        total_secs: doc.fps.secs(doc.sequence_end()),
    };
    Ok((t, lines, path))
}
